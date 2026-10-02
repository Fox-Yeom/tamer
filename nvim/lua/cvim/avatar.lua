-- Renders sprites into a scratch buffer with half-block cells (▀/▄) + truecolor highlights.
-- One cell = 2 vertical pixels. Scale grows with the window (responsive).
local sprites = require("cvim.sprites")
local M = {}

local ns = vim.api.nvim_create_namespace("cvim_avatar")
local hl_cache = {}
local frame_n = 0

local function hl(fg, bg)
  local name = "CvimPx_" .. (fg or "x"):gsub("#", "") .. "_" .. (bg or "x"):gsub("#", "")
  if not hl_cache[name] then
    vim.api.nvim_set_hl(0, name, { fg = fg, bg = bg })
    hl_cache[name] = true
  end
  return name
end

-- colorscheme change wipes custom groups
vim.api.nvim_create_autocmd("ColorScheme", { callback = function() hl_cache = {} end })

function M.new_buf()
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].bufhidden = "hide"
  vim.bo[buf].filetype = "cvim-avatar"
  -- a trackpad scroll would shift the sprite out of place
  for _, k in ipairs({ "<ScrollWheelUp>", "<ScrollWheelDown>", "<ScrollWheelLeft>", "<ScrollWheelRight>" }) do
    vim.keymap.set({ "n", "i" }, k, "<Nop>", { buffer = buf })
  end
  return buf
end

-- c = { W, H, [y][x] = "#rrggbb" | nil }. Each cell = 2 vertical pixels (▀/▄).
-- s >= 1 enlarges (integer), s < 1 shrinks (nearest-neighbour) to fit the window.
local function pick_scale(c, w, h)
  local s = math.min(w / c.W, (h - 2) * 2 / c.H)
  if s >= 1 then return math.max(1, math.min(math.floor(s), 3)) end
  return math.max(s, 0.2)
end

-- Pick the scale: 1:1 if it fits (cropping the transparent effect margins c.MX/c.MY if needed),
-- else exactly 1/2, 1/3, 1/4 — whole-pixel blocks averaged evenly. Fractional scales like 0.78
-- sample unevenly and are what made the pixels look broken.
local function fit(c, w, h)
  local maxw, maxh = w, (h - 2) * 2
  local s = math.min(maxw / c.W, maxh / c.H)
  if s >= 1 then return c, math.max(1, math.min(math.floor(s), 3)) end
  local iw, ih = c.W - 2 * (c.MX or 0), c.H - 2 * (c.MY or 0)
  for _, k in ipairs({ 1, 2, 3, 4 }) do
    local sk = 1 / k
    if iw * sk <= maxw and ih * sk <= maxh then
      local W, H = math.min(c.W, math.floor(maxw / sk)), math.min(c.H, math.floor(maxh / sk))
      if W == c.W and H == c.H then return c, sk end
      local ox, oy = math.floor((c.W - W) / 2), math.floor((c.H - H) / 2)
      local v = { W = W, H = H }
      for y = 0, H - 1 do v[y] = setmetatable({}, { __index = function(_, x) return c[y + oy] and c[y + oy][x + ox] end }) end
      return v, sk
    end
  end
  return c, math.max(s, 0.2)
end

local function rasterize(c, s, w)
  local pw, ph = math.floor(c.W * s), math.floor(c.H * s)
  local pad = math.max(0, math.floor((w - pw) / 2))
  local at
  if s >= 1 then
    at = function(px, py)
      local row = c[math.floor(py / s)]
      return row and row[math.floor(px / s)]
    end
  else
    -- shrinking pixel art: take the block's most common original colour (ties → the darker one,
    -- which keeps outlines). Averaging blends colours into mush; nearest drops pixels.
    local cache = {}
    at = function(px, py)
      local key = py * 4096 + px
      local hit = cache[key]
      if hit ~= nil then return hit or nil end
      local x0, x1 = math.floor(px / s), math.max(math.floor(px / s), math.floor((px + 1) / s) - 1)
      local y0, y1 = math.floor(py / s), math.max(math.floor(py / s), math.floor((py + 1) / s) - 1)
      local count, n, total = {}, 0, 0
      for y = y0, y1 do
        local row = c[y]
        for x = x0, x1 do
          total = total + 1
          local col = row and row[x]
          if col then
            count[col] = (count[col] or 0) + 1
            n = n + 1
          end
        end
      end
      local out = false
      if n > 0 and n * 2 >= total then
        local best, bc, bl = nil, -1, math.huge
        for col, k in pairs(count) do
          local l = tonumber(col:sub(2, 3), 16) * 3 + tonumber(col:sub(4, 5), 16) * 6 + tonumber(col:sub(6, 7), 16)
          if k > bc or (k == bc and l < bl) then best, bc, bl = col, k, l end
        end
        out = best
      end
      cache[key] = out
      return out or nil
    end
  end
  local lines, spans = {}, {}
  for row = 0, math.ceil(ph / 2) - 1 do
    local parts, col_byte = { string.rep(" ", pad) }, pad
    local run = nil
    local function flush()
      if run then table.insert(spans, run) run = nil end
    end
    for x = 0, pw - 1 do
      local top = at(x, row * 2)
      local bot = (row * 2 + 1 < ph) and at(x, row * 2 + 1) or nil
      local ch, group
      if top and bot then
        ch, group = "▀", hl(top, bot)
      elseif top then
        ch, group = "▀", hl(top, nil)
      elseif bot then
        ch, group = "▄", hl(bot, nil)
      else
        ch = " "
      end
      local len = #ch
      if group then
        if run and run.group == group and run.e == col_byte then
          run.e = col_byte + len
        else
          flush()
          run = { row = row, s = col_byte, e = col_byte + len, group = group }
        end
      else
        flush()
      end
      table.insert(parts, ch)
      col_byte = col_byte + len
    end
    flush()
    lines[#lines + 1] = table.concat(parts)
  end
  return lines, spans
end

local function center(text, w)
  local tw = vim.fn.strdisplaywidth(text)
  if tw >= w then return text end
  return string.rep(" ", math.floor((w - tw) / 2)) .. text
end

-- ws: workspace state from cvim.state
-- key: set for float avatars (start screen / Pokédex) so CVIM.app can draw them natively
function M.render(buf, win, ws, key)
  if not (vim.api.nvim_buf_is_valid(buf) and vim.api.nvim_win_is_valid(win)) then return end
  local w, h = vim.api.nvim_win_get_width(win), vim.api.nvim_win_get_height(win)
  local state = ws and ws.state or "idle"
  local poke = ws and ws.pokemon
  -- Pokémon, or a wobbling Poké Ball while it loads / if none is available
  local P = require("cvim.pokemon")
  local canvas = poke and P.frame(poke, ws, frame_n) or P.placeholder(frame_n) -- also drives motions/evolution
  local lines, spans
  local native = poke and P.native() and (ws.w or key)
  if key then
    if native then P.ui_avatar(key, win, ws) else P.ui_clear(key) end
  end
  if native then
    -- CVIM.app: macOS draws the GIF over this area (app/cvimpane.m); keep it empty
    lines, spans = {}, {}
    for _ = 1, math.max(0, h - 3) do lines[#lines + 1] = "" end
  else
    local view, scale = fit(canvas, w, h)
    lines, spans = rasterize(view, scale, w)
  end

  -- vertical centering
  local label = sprites.labels[state] or state
  if not poke then label = "몬스터볼…  " .. label end
  local detail = ws and ws.detail and ws.detail ~= "" and vim.fn.fnamemodify(ws.detail, ":t") or ""
  if poke then
    local P = require("cvim.pokemon")
    label = P.label(poke) .. "  " .. label
    if detail == "" or state == "idle" or state == "sleep" then detail = P.progress(ws) end
    local cap = P.caption(ws, frame_n) -- evolution
    if cap then label, detail = cap, "" end
  end
  if #detail > w - 2 then detail = detail:sub(1, w - 3) .. "…" end
  local body_h = #lines + 2
  local top_pad = native and 0 or math.max(0, math.floor((h - body_h) / 2))
  local out = {}
  for _ = 1, top_pad do out[#out + 1] = "" end
  for _, l in ipairs(lines) do out[#out + 1] = l end
  out[#out + 1] = center(label, w)
  out[#out + 1] = center(detail, w)

  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, out)
  vim.bo[buf].modifiable = false
  local view = vim.api.nvim_win_call(win, vim.fn.winsaveview)
  if view.topline ~= 1 or view.leftcol ~= 0 then
    vim.api.nvim_win_call(win, function() vim.fn.winrestview({ topline = 1, leftcol = 0, lnum = 1, col = 0 }) end)
  end
  vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
  for _, sp in ipairs(spans) do
    vim.api.nvim_buf_set_extmark(buf, ns, sp.row + top_pad, sp.s, { end_col = sp.e, hl_group = sp.group })
  end
  vim.api.nvim_buf_set_extmark(buf, ns, top_pad + #lines, 0, { end_row = top_pad + #lines + 1, hl_group = "Title" })
  vim.api.nvim_buf_set_extmark(buf, ns, top_pad + #lines + 1, 0, { end_row = top_pad + #lines + 2, end_col = 0, hl_group = "Comment", strict = false })
end

-- drive all visible avatar windows from one timer
function M.start(get_targets)
  if M.timer then return end
  M.timer = (vim.uv or vim.loop).new_timer()
  M.timer:start(0, 140, vim.schedule_wrap(function()
    frame_n = frame_n + 1
    for _, t in ipairs(get_targets()) do pcall(M.render, t.buf, t.win, t.ws, t.key) end
  end))
end

return M
