-- Prompt composer: write long / multi-line / Korean prompts in a real Neovim buffer, then send to
-- Claude. Sidesteps Claude Code's TUI IME issues ("compose elsewhere and paste" is the upstream
-- workaround). One draft per workspace, kept when the window is closed.
local M = {}

local function workspace()
  return require("cvim").workspaces[vim.api.nvim_get_current_tabpage()]
end

local function valid_win(win) return win and vim.api.nvim_win_is_valid(win) end
local function valid_buf(buf) return buf and vim.api.nvim_buf_is_valid(buf) end

local HINT = " ⌘⏎ send · ⌘⇧⏎ paste only · Esc close (draft kept) "

local function geometry(w)
  local cw = w.wins.claude
  local width, height = vim.api.nvim_win_get_width(cw), vim.api.nvim_win_get_height(cw)
  local lines = valid_buf(w.prompt_buf) and vim.api.nvim_buf_line_count(w.prompt_buf) or 1
  local h = math.max(6, math.min(lines + 1, math.floor(height * 0.5)))
  return {
    relative = "win", win = cw, anchor = "SW",
    row = height - 1, col = 1,
    width = math.max(20, width - 4), height = h,
    border = "rounded", title = " ✍  Prompt ", title_pos = "left",
    footer = HINT, footer_pos = "right", zindex = 60,
  }
end

local function draft_buf(w)
  if valid_buf(w.prompt_buf) then return w.prompt_buf end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].bufhidden = "hide"
  vim.bo[buf].filetype = "markdown"
  vim.b[buf].cvim_prompt = true
  w.prompt_buf = buf

  local o = { buffer = buf, silent = true }
  local send = function() M.send(true) end
  local paste = function() M.send(false) end
  vim.keymap.set({ "n", "i" }, "<D-CR>", send, o)
  vim.keymap.set({ "n", "i" }, "<D-S-CR>", paste, o)
  vim.keymap.set({ "n", "i" }, "<C-s>", send, o) -- terminal (non-Neovide) fallback
  vim.keymap.set("n", "<Esc>", M.close, o)
  vim.keymap.set("n", "q", M.close, o)
  -- a trackpad brush while typing turns Insert into "-- (insert) VISUAL --", where Hangul does
  -- nothing; keep single clicks (move cursor) but drop drag / multi-click selection in Insert
  for _, k in ipairs({ "<LeftDrag>", "<2-LeftMouse>", "<3-LeftMouse>", "<4-LeftMouse>" }) do
    vim.keymap.set("i", k, "<Nop>", o)
  end
  -- grow/shrink with the text
  vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, {
    buffer = buf,
    callback = function() M.reposition(w) end,
  })
  return buf
end

function M.reposition(w)
  w = w or workspace()
  if not (w and valid_win(w.prompt_win) and valid_win(w.wins.claude)) then return end
  vim.api.nvim_win_set_config(w.prompt_win, geometry(w))
end

function M.open()
  local w = workspace()
  if not (w and valid_win(w.wins.claude)) then return end
  local buf = draft_buf(w)
  if valid_win(w.prompt_win) then
    vim.api.nvim_set_current_win(w.prompt_win)
  else
    w.prompt_win = vim.api.nvim_open_win(buf, true, geometry(w))
    local wo = vim.wo[w.prompt_win]
    wo.wrap, wo.linebreak, wo.number, wo.signcolumn = true, true, false, "no"
    wo.winhighlight = "Normal:NormalFloat,FloatBorder:CvimPromptBorder,FloatTitle:CvimPromptTitle,FloatFooter:CvimPromptFooter"
  end
  -- continue at the end of the draft
  local last = vim.api.nvim_buf_line_count(buf)
  local len = #(vim.api.nvim_buf_get_lines(buf, last - 1, last, false)[1] or "")
  vim.api.nvim_win_set_cursor(w.prompt_win, { last, len })
  -- opened from Claude's terminal mode: a direct startinsert is lost when terminal mode ends,
  -- leaving the composer in Normal mode (Korean keys then do nothing). Defer it.
  local win = w.prompt_win
  vim.schedule(function()
    if vim.api.nvim_get_current_win() == win then vim.cmd("startinsert!") end
  end)
end

function M.close()
  local w = workspace()
  if w and valid_win(w.prompt_win) then
    vim.cmd("stopinsert")
    pcall(vim.api.nvim_win_close, w.prompt_win, true)
  end
  if w then w.prompt_win = nil end
  require("cvim").focus_claude()
end

function M.toggle()
  local w = workspace()
  if w and valid_win(w.prompt_win) and vim.api.nvim_get_current_win() == w.prompt_win then
    M.close()
  else
    M.open()
  end
end

-- submit=true: paste + Enter. submit=false: paste only (edit further in Claude's input)
function M.send(submit)
  local w = workspace()
  if not (w and valid_buf(w.prompt_buf)) then return end
  local text = table.concat(vim.api.nvim_buf_get_lines(w.prompt_buf, 0, -1, false), "\n")
  text = text:gsub("^%s+", ""):gsub("%s+$", "")
  if text == "" then return vim.notify("cvim: prompt is empty", vim.log.levels.INFO) end
  local chan = valid_buf(w.claude_buf) and vim.bo[w.claude_buf].channel or 0
  if chan == 0 then return vim.notify("cvim: Claude is not running", vim.log.levels.WARN) end

  vim.api.nvim_chan_send(chan, "\27[200~" .. text .. "\27[201~")
  if submit then
    -- let Claude finish ingesting the paste before Enter
    vim.defer_fn(function() pcall(vim.api.nvim_chan_send, chan, "\r") end, 120)
  end
  vim.api.nvim_buf_set_lines(w.prompt_buf, 0, -1, false, {})
  M.close()
end

function M.setup()
  local th = require("cvim.theme").c
  vim.api.nvim_set_hl(0, "CvimPromptBorder", { fg = th.accent, bg = th.bg_alt })
  vim.api.nvim_set_hl(0, "CvimPromptTitle", { fg = th.bg, bg = th.accent, bold = true })
  vim.api.nvim_set_hl(0, "CvimPromptFooter", { fg = th.fg_dim, bg = th.bg_alt })
  vim.api.nvim_create_user_command("CvimCompose", M.toggle, {})
end

return M
