-- Neovide IME preedit display.
-- Neovide 0.16's default neovide.preedit_handler is empty, so composing Hangul (e.g. "ㄱ" -> "가")
-- is invisible until committed. We draw the preedit in a tiny float at the cursor; it works in
-- terminal mode (Claude's input) and normal buffers alike.
local M = {}

local s = { text = "", buf = nil, win = nil, timer = nil, pending = false, guicursor = nil }

-- NOTE: Neovide calls preedit/commit handlers via nvim__exec_lua_fast (a fast/"api-fast" context).
-- Window/buffer changes there can fire autocmds and abort nvim, so handlers only record state
-- and all drawing happens in vim.schedule. The float is hidden, never closed (no WinClosed).

local function cfg(width, hide)
  return {
    relative = "cursor", row = 0, col = 0, width = math.max(1, width), height = 1,
    style = "minimal", focusable = false, zindex = 300, hide = hide or false,
  }
end

-- Neovide paints its block cursor above floats, splitting the wide preedit glyph
-- (ㅅ looked like "Tt"). While composing, use a thin underline cursor instead.
local function cursor_compose(on)
  if on and not s.guicursor then
    s.guicursor = vim.o.guicursor
    vim.o.guicursor = "a:hor8-CvimPreeditCursor"
  elseif not on and s.guicursor then
    vim.o.guicursor = s.guicursor
    s.guicursor = nil
  end
end

local function hide()
  if s.win and vim.api.nvim_win_is_valid(s.win) then
    pcall(vim.api.nvim_win_set_config, s.win, cfg(1, true))
  end
  if s.timer then s.timer:stop() end
  cursor_compose(false)
end

local ns = vim.api.nvim_create_namespace("cvim_ime")

-- What's right of the cursor on the current line, and whether it is Claude's placeholder.
-- Real text (typing mid-line) is redrawn after the preedit so it looks inserted; the placeholder
-- (`> Try "..."` on an empty prompt) is blanked, as it disappears once you type.
local function rest_of_line(max_w)
  local ok, cur = pcall(vim.api.nvim_win_get_cursor, 0)
  if not ok or max_w <= 0 then return "", false end
  local line = vim.api.nvim_buf_get_lines(0, cur[1] - 1, cur[1], false)[1] or ""
  -- Claude's prompt is "❯" + NBSP (C2 A0); Lua's %s doesn't match NBSP, so normalize it
  local before = line:sub(1, cur[2]):gsub("\194\160", " ")
  local rest = line:sub(cur[2] + 1):gsub("%s*│?%s*$", "") -- drop padding / box edge
  local empty_prompt = before:match("^[%s│]*>%s*$") or before:match("^[%s│]*❯%s*$")
  local placeholder = empty_prompt ~= nil and rest:match('^Try "') ~= nil
  if vim.fn.strdisplaywidth(rest) > max_w then
    rest = vim.fn.strcharpart(rest, 0, max_w)
    while vim.fn.strdisplaywidth(rest) > max_w do rest = vim.fn.strcharpart(rest, 0, vim.fn.strchars(rest) - 1) end
  end
  return rest, placeholder
end

-- draw preedit (+ shifted text or blanked placeholder) at the cursor (normal context only)
local function place()
  if s.text == "" or not (s.win and vim.api.nvim_win_is_valid(s.win)) then return end
  local pw = vim.fn.strdisplaywidth(s.text)
  local room = vim.api.nvim_win_get_width(0) - vim.fn.wincol()
  local rest, placeholder = rest_of_line(room - pw)
  local rw = vim.fn.strdisplaywidth(rest)
  local tail = placeholder and string.rep(" ", rw) or rest
  vim.api.nvim_buf_set_lines(s.buf, 0, -1, false, { s.text .. tail })
  vim.api.nvim_buf_clear_namespace(s.buf, ns, 0, -1)
  vim.api.nvim_buf_set_extmark(s.buf, ns, 0, 0, { end_col = #s.text, hl_group = "CvimPreedit" })
  vim.api.nvim_win_set_config(s.win, cfg(pw + rw))
end

local function render()
  s.pending = false
  if s.text == "" then return hide() end
  if not (s.buf and vim.api.nvim_buf_is_valid(s.buf)) then
    s.buf = vim.api.nvim_create_buf(false, true)
  end
  if not (s.win and vim.api.nvim_win_is_valid(s.win)) then
    local c = cfg(1, true)
    c.noautocmd = true
    s.win = vim.api.nvim_open_win(s.buf, false, c)
    vim.wo[s.win].winhighlight = "Normal:CvimPreeditRest"
  end
  cursor_compose(true)
  place()
  -- Claude echoes committed chars asynchronously and the cursor moves after that;
  -- keep re-anchoring to the cursor while composing so we never cover the last syllable.
  if not s.timer then s.timer = (vim.uv or vim.loop).new_timer() end
  s.timer:stop()
  s.timer:start(25, 25, vim.schedule_wrap(function()
    if s.text ~= "" then pcall(place) elseif s.timer then s.timer:stop() end
  end))
end

local function request_render()
  if s.pending then return end -- coalesce bursts of preedit updates
  s.pending = true
  vim.schedule(function() pcall(render) end)
end

-- fast-context safe
function M.preedit(text)
  s.text = text or ""
  request_render()
end

-- fast-context safe (nvim_input is allowed in fast context; Neovide's default does the same)
function M.commit(raw, formatted)
  s.text = ""
  request_render()
  -- Neovide wraps the committed text with held modifiers. Two cases:
  --  * ⌘E while "라" is still composing commits "<D-라>" → type the Hangul, drop the ⌘
  --    (the ⌘E itself is swallowed by Neovide while composing; press it again)
  --  * with the Korean input source, ⌘1 / ⌘2 … also arrive as commits ("<D-1>") → keep them,
  --    they are shortcuts (tab switching)
  if raw and raw:find("[\128-\255]") then formatted = raw:gsub("<", "<lt>") end
  -- stuck in Visual/Select (e.g. "-- (insert) VISUAL --" after a stray drag): Hangul would be
  -- taken as commands. <Esc> first; from an Insert-started Visual it returns to Insert.
  local mode = vim.api.nvim_get_mode().mode -- fast-context safe
  if mode:match("^[vVsS\22\19]") then formatted = "<Esc>" .. formatted end
  -- Terminal-Normal: Hangul does nothing there; go back to Terminal mode (Claude) and type
  if mode == "nt" then formatted = "i" .. formatted end
  vim.api.nvim_input(formatted)
end

local function install()
  if type(_G.neovide) ~= "table" then return false end
  _G.neovide.preedit_handler = function(text) M.preedit(text) end
  _G.neovide.commit_handler = function(raw, formatted) M.commit(raw, formatted) end
  return true
end

function M.setup()
  if not vim.g.neovide then return end
  local th = require("cvim.theme").c
  vim.api.nvim_set_hl(0, "CvimPreedit", { fg = "#ffffff", bg = "#5a3a30", underline = true, bold = true })
  vim.api.nvim_set_hl(0, "CvimPreeditRest", { fg = th.fg_dim, bg = th.bg })
  vim.api.nvim_set_hl(0, "CvimPreeditCursor", { fg = th.accent, bg = th.accent })
  -- Neovide defines _G.neovide when its UI attaches; install now and again on UIEnter
  install()
  vim.api.nvim_create_autocmd("UIEnter", { callback = function() install() end })
  -- in case Neovide's runtime (re)defines its table after us
  for _, ms in ipairs({ 300, 1500, 4000 }) do vim.defer_fn(install, ms) end
  -- drop a stale preedit if focus/mode changes mid-composition
  vim.api.nvim_create_autocmd({ "ModeChanged", "WinLeave", "FocusLost" }, {
    callback = function() if s.text ~= "" then s.text = ""; request_render() end end,
  })
end

M._state = s
return M
