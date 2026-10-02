-- Start screen / folder picker: shown when CVIM.app is launched without a folder, and on ⌘O.
-- Recent folders (~/.cache/cvim/recent_dirs) + "choose another folder…" (macOS dialog).
local M = {}

local ns = vim.api.nvim_create_namespace("cvim_start")

local function recent_dirs()
  local path = require("cvim").recent_file
  local out = {}
  if vim.fn.filereadable(path) == 1 then
    for _, d in ipairs(vim.fn.readfile(path)) do
      if d ~= "" and vim.fn.isdirectory(d) == 1 then out[#out + 1] = d end
    end
  end
  return out
end

-- keep = true: just being re-laid out (window resized) — keep the same Pokémon
local function close(keep)
  if not keep then M.avatar_ws = nil end
  require("cvim.pokemon").ui_clear("start")
  for _, k in ipairs({ "win", "avatar_win" }) do
    if M[k] and vim.api.nvim_win_is_valid(M[k]) then pcall(vim.api.nvim_win_close, M[k], true) end
    M[k] = nil
  end
  M.items = nil
end

function M.is_open() return M.win ~= nil and vim.api.nvim_win_is_valid(M.win) end

local function open_dir(dir)
  close()
  require("cvim").open_folder(dir)
end

local function choose_other()
  vim.system({ "osascript",
    "-e", 'tell application "System Events" to activate',
    "-e", 'POSIX path of (choose folder with prompt "CVIM에서 열 폴더를 선택하세요")' },
    { text = true },
    vim.schedule_wrap(function(r)
      local dir = vim.trim(r.stdout or "")
      if r.code == 0 and dir ~= "" then open_dir(dir) end
      vim.system({ "osascript", "-e", 'tell application id "dev.cvim.app" to activate' })
    end))
end

local function activate(i)
  local item = M.items and M.items[i]
  if not item then return end
  if item.dir then open_dir(item.dir) elseif item.action then item.action() end
end

local function current_index()
  local row = vim.api.nvim_win_get_cursor(M.win)[1]
  for i, item in ipairs(M.items or {}) do
    if item.row == row then return i end
  end
end

local function move(delta)
  local idx = (current_index() or 1) + delta
  idx = (idx - 1) % #M.items + 1 -- wrap around like other pickers
  vim.api.nvim_win_set_cursor(M.win, { M.items[idx].row, 2 })
end

-- startup=true: launched without a folder (Esc does nothing, a folder must be chosen)
function M.open(startup)
  if M.is_open() then return vim.api.nvim_set_current_win(M.win) end
  M.startup = startup
  local dirs = recent_dirs()
  local lines, items, hls = {}, {}, {}
  local function add(text, hl) lines[#lines + 1] = text; if hl then hls[#hls + 1] = { #lines, hl } end end

  add("")
  add("  최근 폴더", "CvimStartHeader")
  if #dirs == 0 then add("    (아직 없음)", "Comment") end
  for i, d in ipairs(dirs) do
    if i > 9 then break end
    local name = vim.fn.fnamemodify(d, ":t")
    local parent = vim.fn.fnamemodify(d, ":~:h")
    add(string.format("  %d  %-24s %s", i, name, parent))
    items[#items + 1] = { row = #lines, dir = d, key = tostring(i) }
  end
  add("")
  add("  o  다른 폴더 선택…")
  items[#items + 1] = { row = #lines, action = choose_other, key = "o" }
  add("  h  홈 폴더")
  items[#items + 1] = { row = #lines, dir = vim.env.HOME, key = "h" }
  add("  d  📕 도감")
  items[#items + 1] = { row = #lines, action = function() require("cvim.dex").open() end, key = "d" }
  -- agent for folders opened from here (a folder's own last choice still wins)
  local agents = require("cvim.agents")
  add("  a  에이전트: " .. agents.label(agents.default()) .. "  (바꾸기)")
  items[#items + 1] = { row = #lines, key = "a", action = function()
    agents.remember(nil, agents.next(agents.default()))
    close(true); M.open(startup)
    vim.api.nvim_win_set_cursor(M.win, { M.items[#M.items].row, 2 })
  end }
  add("")
  add("  ↑↓ / j k 이동 · Enter·더블클릭 열기 · 숫자 바로 열기" .. (startup and "" or " · Esc 닫기"), "Comment")

  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  vim.bo[buf].filetype = "cvim-start"
  for _, h in ipairs(hls) do
    vim.api.nvim_buf_set_extmark(buf, ns, h[1] - 1, 0, { end_row = h[1], hl_group = h[2] })
  end
  for _, item in ipairs(items) do
    vim.api.nvim_buf_set_extmark(buf, ns, item.row - 1, 2, { end_col = 3, hl_group = "CvimStartKey" })
  end

  local width = 64
  local height = #lines
  -- room for the Pokémon at 1:1 (a cramped box forces shrinking, which breaks the pixels)
  local avatar_h = math.max(8, math.min(26, vim.o.lines - height - 6))
  local avatar_w = math.min(80, vim.o.columns - 4)
  local total = avatar_h + height + 2
  local row = math.max(0, math.floor((vim.o.lines - total) / 2))
  local col = math.max(0, math.floor((vim.o.columns - width) / 2))

  -- animated mascot above the list
  local abuf = require("cvim.avatar").new_buf()
  M.avatar_buf = abuf
  M.avatar_win = vim.api.nvim_open_win(abuf, false, {
    relative = "editor", row = row, col = math.max(0, math.floor((vim.o.columns - avatar_w) / 2)),
    width = avatar_w, height = avatar_h,
    style = "minimal", focusable = false, zindex = 50,
  })
  vim.wo[M.avatar_win].winhighlight = "Normal:Normal"

  M.win = vim.api.nvim_open_win(buf, true, {
    relative = "editor", row = row + avatar_h, col = col, width = width, height = height,
    style = "minimal", border = "rounded", zindex = 50,
    title = " ✻ CVIM — 폴더 열기 ", title_pos = "center",
  })
  vim.wo[M.win].cursorline = true
  vim.wo[M.win].winhighlight = "Normal:NormalFloat,FloatBorder:CvimPromptBorder,FloatTitle:CvimPromptTitle,CursorLine:CvimStartSel"
  M.items = items
  vim.api.nvim_win_set_cursor(M.win, { items[1].row, 2 })
  vim.cmd("stopinsert")

  local o = { buffer = buf, nowait = true, silent = true }
  local map = vim.keymap.set
  map("n", "<CR>", function() activate(current_index()) end, o)
  map("n", "l", function() activate(current_index()) end, o)
  map("n", "<2-LeftMouse>", function() activate(current_index()) end, o)
  map("n", "j", function() move(1) end, o)
  map("n", "k", function() move(-1) end, o)
  map("n", "<Down>", function() move(1) end, o)
  map("n", "<Up>", function() move(-1) end, o)
  for i, item in ipairs(items) do
    map("n", item.key, function() activate(i) end, o)
  end
  local function dismiss() if not startup then close() end end
  map("n", "<Esc>", dismiss, o)
  map("n", "q", dismiss, o)
  -- clicking around (the empty window behind) must not steal focus from the picker
  vim.api.nvim_create_autocmd("WinLeave", {
    buffer = buf,
    callback = function()
      vim.schedule(function()
        if not M.is_open() then return end
        local cur = vim.api.nvim_get_current_win()
        local dex = package.loaded["cvim.dex"]
        local float = vim.api.nvim_win_get_config(cur).relative ~= ""
        if cur ~= M.win and not float and not (dex and dex.is_open()) then
          vim.api.nvim_set_current_win(M.win)
          vim.cmd("stopinsert")
        end
      end)
    end,
  })
  -- keep the cursor on selectable rows
  vim.api.nvim_create_autocmd("CursorMoved", {
    buffer = buf,
    callback = function()
      if not current_index() then move(0) end
    end,
  })
end

-- avatar animation target while the start screen is up
function M.avatar_target()
  local dex = package.loaded["cvim.dex"]
  if dex and dex.is_open() then -- the Pokédex is on top: don't draw (natively) over it
    require("cvim.pokemon").ui_clear("start")
    return nil
  end
  if M.avatar_win and vim.api.nvim_win_is_valid(M.avatar_win) then
    M.avatar_ws = M.avatar_ws or { state = "idle", pokemon = require("cvim.pokemon").cached_random() }
    return { buf = M.avatar_buf, win = M.avatar_win, ws = M.avatar_ws, key = "start" }
  end
end

M.close = close

function M.setup()
  local th = require("cvim.theme").c
  vim.api.nvim_set_hl(0, "CvimStartHeader", { fg = th.accent, bold = true })
  vim.api.nvim_set_hl(0, "CvimStartKey", { fg = th.accent, bold = true })
  vim.api.nvim_set_hl(0, "CvimStartSel", { bg = th.bg_sel })
  vim.api.nvim_create_user_command("CvimOpen", function() M.open(false) end, {})
end

return M
