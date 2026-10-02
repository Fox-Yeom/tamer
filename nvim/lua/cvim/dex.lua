-- Pokédex (⌘D / :CvimDex / start screen "d"): every Pokémon you've met, with an animated preview.
-- Enter makes the selected one this folder's partner.
local M = {}

local P = require("cvim.pokemon")
local ns = vim.api.nvim_create_namespace("cvim_dex")

local TYPE_ICON = {
  electric = "⚡", fire = "🔥", water = "💧", grass = "🍃", ice = "❄️", psychic = "🔮", ghost = "👻",
  dark = "🌑", poison = "☠️", ground = "⛰️", rock = "🪨", fighting = "👊", flying = "🌪️", bug = "🐛",
  dragon = "🐉", steel = "⚙️", fairy = "✨", normal = "⭐",
}
M.TYPE_ICON = TYPE_ICON
local TOTAL = 649

-- keep = true: just being re-laid out (window resized) — keep the selected entry
local function close(keep)
  M.keep_row = keep and M.win and vim.api.nvim_win_is_valid(M.win) and vim.api.nvim_win_get_cursor(M.win)[1] or nil
  for _, k in ipairs({ "win", "avatar_win" }) do
    if M[k] and vim.api.nvim_win_is_valid(M[k]) then pcall(vim.api.nvim_win_close, M[k], true) end
    M[k] = nil
  end
  M.avatar_ws, M.rows = nil, nil
  require("cvim.pokemon").ui_clear("dex")
  local start = package.loaded["cvim.start"]
  if not keep and start and start.is_open() then
    vim.schedule(function() if start.is_open() then vim.api.nvim_set_current_win(start.win) end end)
  end
end
M.close = close

function M.is_open() return M.win ~= nil and vim.api.nvim_win_is_valid(M.win) end

local function selected()
  if not M.is_open() then return nil end
  local row = vim.api.nvim_win_get_cursor(M.win)[1]
  return M.rows and M.rows[row]
end

-- preview the entry under the cursor (cached sprite; shiny variant if you've met one)
local function preview()
  local e = selected()
  if not e then return end
  local path = P.cached_path(e.id, e.shiny)
  if vim.fn.filereadable(path) == 0 then path = P.cached_path(e.id, false) end
  local data = vim.fn.filereadable(path) == 1 and P.load(path) or nil
  M.avatar_ws = { state = "idle", pokemon = data, react = { kind = "cute" } }
end

local function make_partner()
  local e = selected()
  local cvim = require("cvim")
  local w = cvim.workspaces[vim.api.nvim_get_current_tabpage()]
  if not (e and w) then return end
  if P.LOCKED then return vim.notify(P.LOCKED) end
  if e.caught == false then
    return vim.notify(string.format("%s: 아직 잡지 못했어요 — 잡은 포켓몬만 파트너가 될 수 있어요", e.name))
  end
  local ws = require("cvim.state").ws[w.id]
  close()
  P.reassign(w, ws, e.id, e.shiny, function() P.publish(w, ws); cvim.layout(w) end)
  vim.notify(string.format("%s을(를) 이 폴더의 파트너로 지정했어요", e.name))
end

function M.open()
  if M.is_open() then return vim.api.nvim_set_current_win(M.win) end
  -- opens on top of the start screen (if any); closing returns there
  vim.schedule(function()
    local w = require("cvim").workspaces[vim.api.nvim_get_current_tabpage()]
    if w then P.publish(w, require("cvim.state").ws[w.id]) end
  end)
  local dex = P.dex()
  local entries, shiny = {}, 0
  for id, e in pairs(dex) do
    e.id = tonumber(id)
    entries[#entries + 1] = e
    if e.shiny then shiny = shiny + 1 end
  end
  table.sort(entries, function(a, b) return a.id < b.id end)

  -- the buffer holds only entries (header → title, help → footer), so scrolling to the
  -- first entry really is the top. Columns are padded by display width (Hangul/emoji = 2 cells).
  local function pad(text, width)
    return text .. string.rep(" ", math.max(0, width - vim.fn.strdisplaywidth(text)))
  end
  local lines, rows, hls = {}, {}, {}
  for _, e in ipairs(entries) do
    local icons = ""
    for _, t in ipairs(e.types or {}) do icons = icons .. (TYPE_ICON[t] or "") end
    lines[#lines + 1] = string.format(" #%03d %s%s %s ×%-3d %s", e.id, e.caught == false and "○ " or e.shiny and "✨" or "  ",
      pad(e.name or "?", 12), pad(icons, 5), e.count or 1, os.date("%m/%d", e.first or os.time()))
    rows[#lines] = e
  end
  if #entries == 0 then lines[1] = "  아직 만난 포켓몬이 없어요" end
  M.title = string.format(" 📕 도감 · 만난 포켓몬 %d / %d · ✨ %d ", #entries, TOTAL, shiny)
  M.help = " ↑↓ PgUp/PgDn Home/End · Enter 파트너 · q "

  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  for _, h in ipairs(hls) do
    vim.api.nvim_buf_set_extmark(buf, ns, h[1] - 1, 0, { end_row = h[1], hl_group = h[2] })
  end
  for r in pairs(rows) do
    vim.api.nvim_buf_set_extmark(buf, ns, r - 1, 2, { end_col = 6, hl_group = "CvimStartKey" })
  end

  -- preview wide enough to draw sprites 1:1 (sprite + motion margins ≈ 60–110 px); shrinking
  -- with nearest-neighbour is what breaks the pixels
  local list_w = 46
  local prev_w = math.max(40, math.min(96, vim.o.columns - list_w - 8))
  -- tall enough for a crisp preview even with few entries (sprites are up to ~90px ≈ 45 rows)
  -- compact; the list scrolls (↑↓ j k, PageUp/PageDown, Home/End) instead of filling the screen
  local height = math.max(12, math.min(#lines, 26, vim.o.lines - 6))
  local total_w = list_w + prev_w + 4
  local row = math.max(0, math.floor((vim.o.lines - height) / 2) - 1)
  local col = math.max(0, math.floor((vim.o.columns - total_w) / 2))
  M.rows = rows
  M.win = vim.api.nvim_open_win(buf, true, {
    relative = "editor", row = row, col = col, width = list_w, height = height,
    style = "minimal", border = "rounded", zindex = 60, title = M.title, title_pos = "center",
    footer = M.help, footer_pos = "left",
  })
  vim.wo[M.win].cursorline = true
  vim.wo[M.win].winhighlight = "Normal:NormalFloat,FloatBorder:CvimPromptBorder,FloatTitle:CvimPromptTitle,CursorLine:CvimStartSel"

  local abuf = require("cvim.avatar").new_buf()
  M.avatar_win = vim.api.nvim_open_win(abuf, false, {
    relative = "editor", row = row, col = col + list_w + 2, width = prev_w, height = height,
    style = "minimal", border = "rounded", zindex = 60, focusable = false,
  })
  vim.wo[M.avatar_win].winhighlight = "Normal:NormalFloat,FloatBorder:CvimPromptBorder"
  M.avatar_buf = abuf
  vim.cmd("stopinsert")

  local first = next(rows) and math.huge or nil
  for r in pairs(rows) do first = math.min(first, r) end
  local row0 = M.keep_row and rows[M.keep_row] and M.keep_row or first
  M.keep_row = nil
  if row0 then vim.api.nvim_win_set_cursor(M.win, { row0, 2 }) end
  preview()

  local o = { buffer = buf, nowait = true, silent = true }
  -- keyboard scrolling over entry rows
  local entry_rows = {}
  for r in pairs(rows) do entry_rows[#entry_rows + 1] = r end
  table.sort(entry_rows)
  local function index_of(row)
    for i, r in ipairs(entry_rows) do if r >= row then return i end end
    return #entry_rows
  end
  local function footer()
    if not M.is_open() or #entry_rows == 0 then return end
    local i = index_of(vim.api.nvim_win_get_cursor(M.win)[1])
    pcall(vim.api.nvim_win_set_config, M.win, { footer = M.help .. string.format(" %d / %d ", i, #entry_rows), footer_pos = "left" })
  end
  local function go(i)
    if #entry_rows == 0 then return end
    i = math.max(1, math.min(#entry_rows, i))
    vim.api.nvim_win_set_cursor(M.win, { entry_rows[i], 2 })
    if i == 1 then vim.api.nvim_win_call(M.win, function() vim.fn.winrestview({ topline = 1 }) end) end
    footer()
  end
  -- single steps wrap around (top ↑ → bottom, bottom ↓ → top); pages stop at the ends
  local function step(d)
    return function()
      local i = index_of(vim.api.nvim_win_get_cursor(M.win)[1]) + d
      if math.abs(d) == 1 then i = (i - 1) % #entry_rows + 1 end
      go(i)
    end
  end
  local page = math.max(1, height - 4)
  for _, k in ipairs({ "j", "<Down>" }) do vim.keymap.set("n", k, step(1), o) end
  for _, k in ipairs({ "k", "<Up>" }) do vim.keymap.set("n", k, step(-1), o) end
  for _, k in ipairs({ "<PageDown>", "<C-d>", "<C-f>", "<Space>" }) do vim.keymap.set("n", k, step(page), o) end
  for _, k in ipairs({ "<PageUp>", "<C-u>", "<C-b>" }) do vim.keymap.set("n", k, step(-page), o) end
  for _, k in ipairs({ "<Home>", "gg" }) do vim.keymap.set("n", k, function() go(1) end, o) end
  for _, k in ipairs({ "<End>", "G" }) do vim.keymap.set("n", k, function() go(#entry_rows) end, o) end
  -- position in the footer: "3 / 40" (also after mouse clicks)
  footer()
  vim.api.nvim_create_autocmd("CursorMoved", { buffer = buf, callback = footer })

  vim.keymap.set("n", "<CR>", make_partner, o)
  vim.keymap.set("n", "<2-LeftMouse>", make_partner, o)
  vim.keymap.set("n", "q", close, o)
  vim.keymap.set("n", "<Esc>", close, o)
  vim.api.nvim_create_autocmd("CursorMoved", { buffer = buf, callback = preview })
  vim.api.nvim_create_autocmd("BufLeave", { buffer = buf, once = true, callback = function() vim.schedule(close) end })
end

function M.avatar_target()
  if M.avatar_win and vim.api.nvim_win_is_valid(M.avatar_win) and M.avatar_ws and M.avatar_ws.pokemon then
    return { buf = M.avatar_buf, win = M.avatar_win, ws = M.avatar_ws, key = "dex" }
  end
end

function M.setup()
  vim.api.nvim_create_user_command("CvimDex", M.open, { desc = "Pokédex" })
end

return M
