-- Pokémon avatars. Each folder gets its own partner Pokémon (random the first time, then fixed),
-- which gains EXP for every finished Claude task and evolves every EVOLVE_EVERY completions.
-- Gen-V animated sprites come from PokéAPI via pokemon/fetch.py (cached locally only;
-- unofficial fan feature). Frames play like the GIF; Claude's state and clicks add motions:
-- type-specific attack, cute (애교), hop, look-around, sleep, evolution, ...
local M = {}

-- CVIM_CACHE_DIR: isolate data (tests must not touch the real partners / Pokédex / overlay)
local CACHEDIR = vim.env.CVIM_CACHE_DIR or (vim.env.HOME .. "/.cache/cvim")
local CACHE = CACHEDIR .. "/pokemon"
local FOLDERS = CACHEDIR .. "/folders.json" -- folder path -> { id, shiny, xp, since_evo, final }
local DEX = CACHEDIR .. "/pokedex.json" -- id -> { name, count, shiny, first, last, types }
local ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,-/:;<=>?@[]^_{|}~"
local TICK = 140 -- ms per avatar frame (avatar.lua timer)
local MX, MY = 12, 8 -- canvas margin around the sprite for motions / effects
M.EVOLVE_EVERY = 8 -- finished Claude tasks per evolution

-- ── storage ─────────────────────────────────────────────────────────────────
local function read_json(path)
  if vim.fn.filereadable(path) == 0 then return {} end
  local ok, t = pcall(vim.json.decode, table.concat(vim.fn.readfile(path), "\n"))
  return (ok and type(t) == "table") and t or {}
end

local function write_json(path, t)
  require("cvim.private").dir(CACHEDIR)
  vim.fn.writefile({ vim.json.encode(t) }, path .. ".tmp")
  os.rename(path .. ".tmp", path)
  require("cvim.private").file(path)
end

-- read-modify-write (several Neovims — one per macOS tab — share these files)
local function update_json(path, fn)
  local t = read_json(path)
  fn(t)
  write_json(path, t)
  return t
end

function M.folder(path) return read_json(FOLDERS)[path] end

local function set_folder(path, rec)
  update_json(FOLDERS, function(t) t[path] = rec end)
end

function M.dex() return read_json(DEX) end

local function record_dex(data)
  update_json(DEX, function(t)
    local k = tostring(data.id)
    local e = t[k] or { first = os.time(), count = 0 }
    e.name = data.name_ko or data.name_en
    e.count = e.count + 1
    e.last = os.time()
    e.shiny = e.shiny or data.shiny or nil
    e.caught = nil -- a partner is caught (`caught = false`: only seen in the wild, CVIM Desktop)
    e.types = data.types
    t[k] = e
  end)
end

-- ── sprite data ─────────────────────────────────────────────────────────────
local loaded = {} -- path -> decoded data

function M.load(path)
  if loaded[path] then return loaded[path] end
  local ok, data = pcall(function() return vim.json.decode(table.concat(vim.fn.readfile(path), "\n")) end)
  if not ok or type(data) ~= "table" then return nil end
  local lut = {}
  for i = 1, #ALPHABET do lut[ALPHABET:byte(i)] = data.palette[i] end
  data.lut = lut
  data.total = 0
  for _, f in ipairs(data.frames) do data.total = data.total + f.d end
  data.path = path
  loaded[path] = data
  return data
end

function M.cached_path(id, shiny)
  return string.format("%s/%d%s.json", CACHE, id, shiny and "s" or "")
end

local function fetch(args, cb)
  local cmd = { "python3", require("cvim").root .. "/pokemon/fetch.py" }
  vim.list_extend(cmd, args)
  vim.system(cmd, { text = true }, vim.schedule_wrap(function(r)
    cb(r.code == 0 and vim.trim(r.stdout or "") or "")
  end))
end

function M.label(data)
  return (data.shiny and "✨" or "") .. (data.name_ko or data.name_en or "???")
end

-- Poké Ball wobbling while a Pokémon loads (instead of any other mascot)
local BALL
function M.placeholder(n)
  if not BALL then
    BALL = {}
    local N, c = 20, 9.5
    for y = 0, N - 1 do
      BALL[y] = {}
      for x = 0, N - 1 do
        local d = math.sqrt((x - c) ^ 2 + (y - c) ^ 2)
        local col
        if d > N / 2 - 0.5 then col = nil
        elseif d > N / 2 - 1.6 or d <= 3.4 and d > 2 or (math.abs(y - c) <= 0.8 and d > 3.4) then col = "#1b1b1f"
        elseif d <= 2 then col = "#f4f1ea"
        elseif y < c then col = (x < c - 2 and y < c - 3) and "#ff8a70" or "#e3350d"
        else col = "#f4f1ea" end
        BALL[y][x] = col
      end
    end
  end
  local W, H = 36, 30
  local c = { W = W, H = H }
  for y = 0, H - 1 do c[y] = {} end
  local phase = n % 14
  local dx = ({ 0, -2, -3, -2, 0, 2, 3, 2, 0, 0, 0, 0, 0, 0 })[phase + 1]
  for y = 0, 19 do
    for x = 0, 19 do
      local col = BALL[y][x]
      if col == "#f4f1ea" and math.sqrt((x - 9.5) ^ 2 + (y - 9.5) ^ 2) <= 2 and phase >= 9 then col = "#ffe14a" end
      if col then c[y + 6][x + 8 + dx] = col end
    end
  end
  return c
end

-- a random already-cached Pokémon (start screen)
function M.cached_random()
  local files = vim.fn.glob(CACHE .. "/*.json", false, true)
  if #files == 0 then return nil end
  return M.load(files[math.random(#files)])
end

-- ── partner per folder ──────────────────────────────────────────────────────
-- w: workspace, ws: its state. Shows the folder's partner. Partners are chosen in CVIM Desktop (v2)
-- now (box rules, desktop/electron/core/partner.cjs): no random new one here, no unpinned rerolls.
function M.assign(w, ws, on_ready, explicit)
  local rec = M.folder(w.cwd)
  if not (rec and rec.id) then return end -- no partner: choose one in CVIM Desktop
  local function ready(data, path)
    if not rec.id then
      rec = { id = data.id, shiny = data.shiny or false, xp = 0, since_evo = 0, pinned = rec.pinned }
      set_folder(w.cwd, rec)
    end
    record_dex(data)
    ws.pokemon, ws.pokemon_path, ws.partner, ws.loading = data, path, rec, nil
    ws.w = w
    ws.react = { kind = "cute" } -- greet on arrival
    ws.events = { seq = (ws.events and ws.events.seq or 0) + 1, kind = "cute" }
    if on_ready then on_ready(data) end
  end
  rec = rec or {}
  -- known partner already cached: show it right away (no placeholder flash)
  if rec.id then
    local path = M.cached_path(rec.id, rec.shiny)
    local data = vim.fn.filereadable(path) == 1 and M.load(path)
    if data then return ready(data, path) end
  end
  ws.loading = true -- a Poké Ball wobbles until the download finishes
  fetch(rec.id and { tostring(rec.id), rec.shiny and "shiny" or nil } or { "random" }, function(path)
    local data = path ~= "" and M.load(path)
    if data then ready(data, path) else ws.loading = nil end
  end)
end

M.LOCKED = "파트너 고르기·바꾸기는 CVIM Desktop(v2)에서 해요 (박스 규칙)"

-- 📌 (locked: partners are managed in CVIM Desktop)
function M.toggle_pin(w, ws)
  if M.LOCKED then vim.notify(M.LOCKED); return true end
  local rec = ws.partner or M.folder(w.cwd) or {}
  rec.pinned = rec.pinned == false
  ws.partner = rec
  set_folder(w.cwd, rec)
  return rec.pinned
end

-- pick a new random partner for the folder (:CvimReroll) or a specific one (from the Pokédex)
function M.reassign(w, ws, id, shiny, on_ready)
  if M.LOCKED then return vim.notify(M.LOCKED) end
  local pinned = not (ws.partner and ws.partner.pinned == false)
  if id then
    set_folder(w.cwd, { id = id, shiny = shiny or false, xp = 0, since_evo = 0, pinned = pinned })
  else
    update_json(FOLDERS, function(t) t[w.cwd] = nil end)
  end
  M.assign(w, ws, function(data)
    if ws.partner.pinned ~= pinned then M.toggle_pin(w, ws) end
    if on_ready then on_ready(data) end
  end, id ~= nil)
end

-- a Claude task finished in this folder: EXP, maybe evolve
function M.on_done(w, ws, on_evolved)
  local rec = ws.partner
  if not rec then return end
  rec.xp = (rec.xp or 0) + 1
  rec.since_evo = (rec.since_evo or 0) + 1
  set_folder(w.cwd, rec)
  if rec.final or rec.since_evo < M.EVOLVE_EVERY then return end
  fetch({ "evolve", tostring(rec.id) }, function(next_id)
    if next_id == "" then
      rec.final = true
      return set_folder(w.cwd, rec)
    end
    fetch({ next_id, rec.shiny and "shiny" or nil }, function(path)
      local to = path ~= "" and M.load(path)
      if not to then return end
      ws.evolving = { from = ws.pokemon, to = to, to_path = path, on_done = on_evolved }
      M.event(ws, "evolve", { from = ws.pokemon_path:gsub("%.json$", ".gif"), to = path:gsub("%.json$", ".gif") })
      rec.id, rec.since_evo = to.id, 0
      set_folder(w.cwd, rec)
      record_dex(to)
    end)
  end)
end

-- EXP shown under the avatar
function M.progress(ws)
  local rec = ws and ws.partner
  if not rec then return "" end
  if rec.pinned == false then return "🎲 열 때마다 새로 뽑기" end
  if rec.final then return string.format("EXP %d · 최종 진화", rec.xp or 0) end
  return string.format("EXP %d · 진화까지 %d", rec.xp or 0, M.EVOLVE_EVERY - (rec.since_evo or 0))
end

-- ── motions ─────────────────────────────────────────────────────────────────
local function blend(hex, to, a)
  local r1, g1, b1 = tonumber(hex:sub(2, 3), 16), tonumber(hex:sub(4, 5), 16), tonumber(hex:sub(6, 7), 16)
  local r2, g2, b2 = tonumber(to:sub(2, 3), 16), tonumber(to:sub(4, 5), 16), tonumber(to:sub(6, 7), 16)
  return string.format("#%02x%02x%02x", r1 + (r2 - r1) * a, g1 + (g2 - g1) * a, b1 + (b2 - b1) * a)
end

local GLYPH = {
  heart = { ".x.x.", "xxxxx", "xxxxx", ".xxx.", "..x.." },
  star = { "..x..", ".xxx.", "xxxxx", ".xxx.", "..x.." },
  spark = { "x...x", ".x.x.", "..x..", ".x.x.", "x...x" },
  boom = { "x...x...x", ".x..x..x.", "..x.x.x..", "...xxx...", "xxxxxxxxx", "...xxx...", "..x.x.x..", ".x..x..x.", "x...x...x" },
  bolt = { "....xxx", "...xxx.", "..xxx..", ".xxxxxx", "...xxx.", "..xxx..", ".xx....", "x......" },
  flame = { "...x...", "..xx...", "..xxx.x", ".xxxxxx", "xxx.xxx", "xx...xx", "xx...xx", ".xxxxx." },
  drop = { "..x..", ".xxx.", ".xxx.", "xxxxx", "xxxxx", "xxxxx", ".xxx." },
  leaf = { "....xxx", "..xxxx.", ".xxxx..", "xxxx...", "x......" },
  snow = { "x..x..x", ".x.x.x.", "..xxx..", "xxxxxxx", "..xxx..", ".x.x.x.", "x..x..x" },
  ring = { "..xxx..", ".x...x.", "x.....x", "x.....x", "x.....x", ".x...x.", "..xxx.." },
  rock = { ".xxxx.", "xxxxxx", "xxxxxx", "xxxxx.", ".xxx.." },
  wind = { "xxxxxx...", "......x..", "..xxxxx.x", ".......x.", "xxxxx...." },
  q = { "xxx", "..x", ".xx", "...", ".x." },
  z = { "xxx", ".x.", "xxx" },
  dot = { "xx", "xx" },
}

-- primary type -> impact glyph + two colors (the overlay shows its own emoji per type)
local TYPE_FX = {
  electric = { "bolt", "#ffe14a", "#ffffff" }, fire = { "flame", "#ff7b22", "#ffd23f" },
  water = { "drop", "#4aa3ff", "#bfe3ff" }, grass = { "leaf", "#5fd35f", "#c9f27a" },
  ice = { "snow", "#7fe7ff", "#ffffff" }, psychic = { "ring", "#ff6fb5", "#ffd0ea" },
  ghost = { "ring", "#8f6bd8", "#d0bfff" }, dark = { "ring", "#5a4a7a", "#a08fd0" },
  poison = { "drop", "#b45fd8", "#e2b6ff" }, ground = { "rock", "#c79a5b", "#e8cc94" },
  rock = { "rock", "#a89060", "#d8c48a" }, fighting = { "boom", "#ff8c3a", "#ffd0a0" },
  flying = { "wind", "#ffffff", "#bfe0ff" }, bug = { "leaf", "#a8c83a", "#e8f59a" },
  dragon = { "boom", "#6a5cff", "#b9b2ff" }, steel = { "spark", "#b8c4d0", "#ffffff" },
  fairy = { "star", "#ff9ed8", "#ffffff" }, normal = { "boom", "#ffd84a", "#ffffff" },
}

local function stamp(c, glyph, x0, y0, color)
  for y, row in ipairs(GLYPH[glyph]) do
    for x = 1, #row do
      if row:sub(x, x) == "x" then
        local yy, xx = y0 + y - 1, x0 + x - 1
        if c[yy] and xx >= 0 and xx < c.W then c[yy][xx] = color end
      end
    end
  end
end

local WORKING = { thinking = true, coding = true, reading = true, searching = true, bash = true, tool = true, agent = true, compact = true }
local REACT_TICKS = 18
local EVOLVE_TICKS = 44

-- which GIF frame at a given time (ms), honoring per-frame durations
local function frame_at(data, ms)
  local t = ms % data.total
  for _, f in ipairs(data.frames) do
    if t < f.d then return f end
    t = t - f.d
  end
  return data.frames[1]
end

local function draw(c, data, frame, ox, oy, flip, tint, tint_a)
  local lut = data.lut
  for y, row in ipairs(frame.rows) do
    local cy = oy + y - 1
    if c[cy] then
      for x = 1, #row do
        local col = lut[row:byte(x)]
        if col then
          if tint then col = blend(col, tint, tint_a) end
          c[cy][ox + (flip and (data.w - x) or (x - 1))] = col
        end
      end
    end
  end
end

-- evolution: classic white silhouettes flickering faster between the two forms, then a flash
local function evolution_frame(ws, n)
  local e = ws.evolving
  e.t0 = e.t0 or n
  local t = n - e.t0
  local from, to = e.from, e.to
  local W, H = math.max(from.w, to.w) + MX * 2, math.max(from.h, to.h) + MY * 2
  local c = { W = W, H = H, MX = MX, MY = MY }
  for y = 0, H - 1 do c[y] = {} end
  local period = math.max(1, 6 - math.floor(t / 6))
  local reveal = t >= EVOLVE_TICKS - 10
  local data = (reveal or math.floor(t / period) % 2 == 1) and to or from
  local tint_a = reveal and math.max(0, 1 - (t - (EVOLVE_TICKS - 10)) / 8) or 1
  draw(c, data, data.frames[1], math.floor((W - data.w) / 2), math.floor((H - data.h) / 2), false, "#ffffff", tint_a)
  for i = 0, 3 do -- sparkles circling
    local a = t / 3 + i * 1.57
    stamp(c, "star", math.floor(W / 2 + math.cos(a) * (W / 2 - 4)) - 2, math.floor(H / 2 + math.sin(a) * (H / 2 - 4)) - 2, "#fff6b0")
  end
  if t >= EVOLVE_TICKS then
    ws.evolve_msg = { text = string.format("축하합니다! %s는 %s로 진화했다!", M.label(from), M.label(to)), till = n + 50 }
    ws.pokemon, ws.pokemon_path, ws.evolving = to, e.to_path, nil
    ws.react = { kind = "cute" }
    if e.on_done then e.on_done(to) end
  end
  return c
end

-- caption under the avatar while evolving / right after
function M.caption(ws, n)
  if ws.evolving then return string.format("어라…!? %s의 모습이…!", M.label(ws.evolving.from)) end
  if ws.evolve_msg and n < ws.evolve_msg.till then return ws.evolve_msg.text end
end

-- ws: { state, since, react = {kind, t0}, evolving }, n: global tick counter
function M.frame(data, ws, n)
  if ws.evolving then return evolution_frame(ws, n) end
  local state = ws.state or "idle"
  local W, H = data.w + MX * 2, data.h + MY * 2
  local c = { W = W, H = H, MX = MX, MY = MY }
  for y = 0, H - 1 do c[y] = {} end

  local speed, dx, dy, flip, tint, tint_a, freeze = 1, 0, 0, false, nil, 0, false
  local fx = {} -- effects drawn on top

  if WORKING[state] then
    speed = state == "thinking" and 0.7 or 1.6
    if state ~= "thinking" then dy = (n % 6 < 3) and 0 or -1 end
    if state == "searching" then flip = math.floor(n / 12) % 2 == 1 end
    if state == "thinking" then
      for i = 0, math.floor(n / 3) % 4 - 1 do fx[#fx + 1] = { "dot", MX + data.w - 6 + i * 3, 1, "#cfcfcf" } end
    end
  elseif state == "waiting" then
    dy = (math.floor(n / 3) % 2 == 0) and 0 or -2
    fx[#fx + 1] = { "q", W - 6, 1, "#f5c542" }
  elseif state == "error" then
    dx = (n % 2 == 0) and -1 or 1
    tint, tint_a = "#e5484d", 0.45
  elseif state == "sleep" then
    freeze, tint, tint_a = true, "#16161c", 0.45
    local z = math.floor(n / 4) % 3
    for i = 0, z do fx[#fx + 1] = { "z", W - 6 - i * 4, 5 - i * 2, "#9da7ff" } end
  elseif state == "done" then
    -- finish = attack, once
    ws.react = ws.react or {}
    if ws.react.done_for ~= ws.since then ws.react = { kind = "attack", done_for = ws.since } end
  end

  -- reactions (click / completion / greeting)
  local r = ws.react
  if r and r.kind then
    r.t0 = r.t0 or n
    local t = n - r.t0
    if t >= REACT_TICKS then
      ws.react = { done_for = r.done_for }
    elseif r.kind == "attack" then
      speed = 2
      if t < 4 then dx = -2 -- wind up
      elseif t < 8 then dx = 4 -- lunge
        if t == 5 or t == 6 then tint, tint_a = "#ffffff", 0.7 end
      elseif t < 15 then dx = (t % 2 == 0) and 2 or 0
        local k = t - 8 -- type-specific impact at the front
        local tfx = TYPE_FX[(data.types or {})[1] or "normal"] or TYPE_FX.normal
        local fxx = flip and 1 or W - 10
        local mid = math.floor(H / 2) - 4
        fx[#fx + 1] = { tfx[1], fxx, mid, k % 2 == 0 and tfx[2] or tfx[3] }
        fx[#fx + 1] = { tfx[1], fxx - 3 - k, mid - 6 - k, tfx[3] }
        fx[#fx + 1] = { "spark", fxx + 1 - (k % 3), mid + 9 + k, tfx[2] }
      end
    elseif r.kind == "cute" then
      local hop = { 0, -2, -4, -2, 0, 0, -2, -4, -2, 0, 0, 0, 0, 0, 0, 0, 0, 0 }
      dy = hop[t + 1] or 0
      flip = t >= 5 and t < 10
      local hy = MY + 2 - math.floor(t / 2)
      fx[#fx + 1] = { "heart", MX - 4, hy, "#ff7aa8" }
      if t > 3 then fx[#fx + 1] = { "heart", W - MX - 2, hy + 3, "#ff9ec0" } end
    end
  end

  local frame = freeze and data.frames[1] or frame_at(data, n * TICK * speed)
  draw(c, data, frame, MX + dx, MY + dy, flip, tint, tint_a)
  for _, e in ipairs(fx) do stamp(c, e[1], e[2], e[3], e[4]) end
  return c
end

-- click on the avatar: attack or cute
function M.poke(ws)
  if not ws or ws.evolving then return end
  ws.react = { kind = (math.random() < 0.5) and "attack" or "cute", done_for = ws.react and ws.react.done_for }
  M.event(ws, ws.react.kind)
end

-- ── native avatar (CVIM.app) ───────────────────────────────────────────────
-- In the app the sprite is drawn by macOS (app/cvimpane.m, an image view over the avatar pane)
-- — crisp like the desktop overlay, where the terminal-cell version magnifies each pixel ~8×.
-- Neovim only draws the caption and tells the app where the pane is.
function M.native()
  return vim.g.neovide == true and (vim.env.CVIM_APP or "") ~= ""
end

-- sprite area of the avatar pane in grid cells (0-based), or nil when hidden
local menu_open = false
local function floats_up()
  for _, mod in ipairs({ "cvim.start", "cvim.dex" }) do
    local m = package.loaded[mod]
    if m and m.is_open and m.is_open() then return true end
  end
  return menu_open
end

function M.avatar_rect(w)
  local win = w and w.wins and w.wins.avatar
  if not (M.native() and win and vim.api.nvim_win_is_valid(win)) then return nil end
  if floats_up() then return nil end -- the native image would cover the float
  if vim.api.nvim_win_get_tabpage(win) ~= vim.api.nvim_get_current_tabpage() then return nil end
  local info = vim.fn.getwininfo(win)[1]
  if not info then return nil end
  return {
    row = info.winrow - 1 + (info.winbar or 0), col = info.wincol - 1,
    w = info.width, h = math.max(1, info.height - 3), -- last lines: name / state / EXP
    cols = vim.o.columns, lines = vim.o.lines,
    pad = { vim.g.neovide_padding_top or 0, vim.g.neovide_padding_left or 0,
            vim.g.neovide_padding_bottom or 0, vim.g.neovide_padding_right or 0 },
  }
end

-- avatars in floats (start screen, Pokédex preview): app/cvimpane.m draws them too.
-- ui[key] = { win, ws }; written to ~/.cache/cvim/ui/<pid>.json when it changes
local UIDIR = CACHEDIR .. "/ui"
local ui, ui_last = {}, nil

local function ui_flush()
  local items = {}
  for key, it in pairs(ui) do
    local win, ws = it.win, it.ws
    if vim.api.nvim_win_is_valid(win) and ws.pokemon and ws.pokemon.path then
      local pos = vim.fn.screenpos(win, 1, 1) -- text area of the float (inside its border)
      local h = vim.api.nvim_win_get_height(win)
      if pos.row > 0 then
        items[#items + 1] = {
          key = key,
          rect = { row = pos.row - 1, col = pos.col - 1, w = vim.api.nvim_win_get_width(win), h = math.max(1, h - 3),
                   cols = vim.o.columns, lines = vim.o.lines,
                   pad = { vim.g.neovide_padding_top or 0, vim.g.neovide_padding_left or 0,
                           vim.g.neovide_padding_bottom or 0, vim.g.neovide_padding_right or 0 } },
          gif = ws.pokemon.path:gsub("%.json$", ".gif"),
          type = (ws.pokemon.types or {})[1] or "normal",
          state = ws.state or "idle",
          event = ws.events or vim.NIL,
        }
      end
    end
  end
  table.sort(items, function(a, b) return a.key < b.key end)
  local body = vim.json.encode({ pid = vim.fn.getpid(), title = require("cvim").title(), items = items })
  if body == ui_last then return end
  ui_last = body
  require("cvim.private").dir(UIDIR)
  local path = UIDIR .. "/" .. vim.fn.getpid() .. ".json"
  vim.fn.writefile({ body }, path .. ".tmp")
  os.rename(path .. ".tmp", path)
  require("cvim.private").file(path)
end

-- called by avatar.lua for a float avatar every frame (cheap: only writes on change)
function M.ui_avatar(key, win, ws)
  ui[key] = { win = win, ws = ws }
  ui_flush()
end

function M.ui_clear(key)
  if not ui[key] then return end
  ui[key] = nil
  ui_flush()
  -- the workspace avatar was hidden while the float was up
  local w = require("cvim").workspaces[vim.api.nvim_get_current_tabpage()]
  if w then vim.schedule(function() M.publish(w, require("cvim.state").ws[w.id]) end) end
end

-- one-shot animations for the native view (click / menu / greeting / evolution)
function M.event(ws, kind, extra)
  ws.events = ws.events or { seq = 0 }
  ws.events.seq = ws.events.seq + 1
  ws.events.kind = kind
  ws.events.extra = extra
  if ws.w then M.publish(ws.w, ws) else ui_flush() end
end

-- ── desktop overlay presence (read by app/cvimoverlay.m) ────────────────────
local OVERLAY = CACHEDIR .. "/overlay"

function M.publish(w, ws)
  if not (w and ws and ws.pokemon and ws.pokemon_path) then return end
  require("cvim.private").dir(OVERLAY)
  local data = {
    id = w.id,
    folder = vim.fn.fnamemodify(w.cwd, ":t"),
    path = w.cwd,
    state = ws.state,
    since = ws.since,
    name = M.label(ws.pokemon),
    gif = ws.pokemon_path:gsub("%.json$", ".gif"),
    type = (ws.pokemon.types or {})[1] or "normal",
    opened = tonumber(w.id:match("^(%d+)")) or 0,
    rect = M.avatar_rect(w) or vim.NIL,
    event = ws.events or vim.NIL,
    pid = vim.fn.getpid(),
  }
  local path = OVERLAY .. "/" .. w.id .. ".json"
  vim.fn.writefile({ vim.json.encode(data) }, path .. ".tmp")
  os.rename(path .. ".tmp", path)
  require("cvim.private").file(path)
end

function M.unpublish(id)
  os.remove(OVERLAY .. "/" .. id .. ".json")
end

-- right-click menu on an avatar
local menu_win
local function close_menu()
  if menu_win and vim.api.nvim_win_is_valid(menu_win) then pcall(vim.api.nvim_win_close, menu_win, true) end
  menu_win = nil
  if menu_open then
    menu_open = false
    M.ui_clear("menu") -- re-publish the workspace avatar
  end
end

function M.menu(ws, w, mouse)
  close_menu()
  local items = {}
  if w then items[#items + 1] = { "🔒 파트너 바꾸기 → CVIM Desktop", function() vim.notify(M.LOCKED) end } end
  items[#items + 1] = { "⚔️  공격", function() ws.react = { kind = "attack", done_for = ws.react and ws.react.done_for }; M.event(ws, "attack") end }
  items[#items + 1] = { "💕 애교", function() ws.react = { kind = "cute", done_for = ws.react and ws.react.done_for }; M.event(ws, "cute") end }
  items[#items + 1] = { "📕 도감", function() require("cvim.dex").open() end }

  local lines = {}
  for i, it in ipairs(items) do lines[i] = string.format(" %d  %s ", i, it[1]) end
  local width = 0
  for _, l in ipairs(lines) do width = math.max(width, vim.fn.strdisplaywidth(l)) end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  local prev = vim.api.nvim_get_current_win()
  local prev_mode = vim.api.nvim_get_mode().mode
  menu_open = true
  if w then M.publish(w, ws) end -- hide the native image under the menu
  menu_win = vim.api.nvim_open_win(buf, true, {
    relative = "editor", row = math.max(0, mouse.screenrow - 1), col = math.max(0, mouse.screencol - 1),
    width = width, height = #lines, style = "minimal", border = "rounded", zindex = 200,
    title = " " .. (ws.pokemon and M.label(ws.pokemon) or "포켓몬") .. " ", title_pos = "left",
  })
  vim.wo[menu_win].cursorline = true
  vim.wo[menu_win].winhighlight = "Normal:NormalFloat,FloatBorder:CvimPromptBorder,FloatTitle:CvimPromptTitle,CursorLine:CvimStartSel"
  vim.cmd("stopinsert")
  local function back()
    close_menu()
    if vim.api.nvim_win_is_valid(prev) then
      vim.api.nvim_set_current_win(prev)
      if prev_mode == "t" or prev_mode:sub(1, 1) == "i" then vim.schedule(function() vim.cmd("startinsert") end) end
    end
  end
  local function pick(i)
    local it = items[i or vim.api.nvim_win_get_cursor(0)[1]]
    back()
    if it then it[2]() end
  end
  local o = { buffer = buf, nowait = true, silent = true }
  vim.keymap.set("n", "<CR>", function() pick() end, o)
  vim.keymap.set("n", "<LeftRelease>", function() pick() end, o)
  for i = 1, #items do vim.keymap.set("n", tostring(i), function() pick(i) end, o) end
  for _, k in ipairs({ "<Esc>", "q", "<RightMouse>" }) do vim.keymap.set("n", k, back, o) end
  vim.api.nvim_create_autocmd("WinLeave", { buffer = buf, once = true, callback = function() vim.schedule(close_menu) end })
end

-- workspace state for an avatar window under the mouse, if any
local function avatar_ws(winid)
  for _, mod in ipairs({ "cvim.start", "cvim.dex" }) do
    local m = package.loaded[mod]
    if m and m.avatar_win == winid then return m.avatar_ws end
  end
  for _, w in pairs(require("cvim").workspaces) do
    if w.wins and w.wins.avatar == winid then return require("cvim.state").ws[w.id] end
  end
end

function M.setup()
  -- clicking an avatar pokes it instead of moving focus there
  vim.keymap.set({ "n", "i", "t" }, "<LeftMouse>", function()
    local ws = avatar_ws(vim.fn.getmousepos().winid)
    if ws then M.poke(ws); return "" end
    return "<LeftMouse>"
  end, { expr = true, desc = "poke Pokémon / click" })

  -- right-click an avatar: reroll / pin / attack / cute / Pokédex
  vim.keymap.set({ "n", "i", "t" }, "<RightMouse>", function()
    local mouse = vim.fn.getmousepos()
    local ws = avatar_ws(mouse.winid)
    if not ws then return "<RightMouse>" end
    local w
    for _, ww in pairs(require("cvim").workspaces) do
      if ww.wins and ww.wins.avatar == mouse.winid then w = ww end
    end
    vim.schedule(function() M.menu(ws, w, mouse) end)
    return ""
  end, { expr = true, desc = "Pokémon menu" })

  vim.api.nvim_create_autocmd("VimLeavePre", {
    callback = function() os.remove(UIDIR .. "/" .. vim.fn.getpid() .. ".json") end,
  })

  vim.api.nvim_create_user_command("CvimPin", function()
    local w = require("cvim").workspaces[vim.api.nvim_get_current_tabpage()]
    if w then M.toggle_pin(w, require("cvim.state").ws[w.id]) end
  end, { desc = "pin / unpin this folder's partner Pokémon" })

  vim.api.nvim_create_user_command("CvimReroll", function()
    local w = require("cvim").workspaces[vim.api.nvim_get_current_tabpage()]
    if not w then return end
    local ws = require("cvim.state").ws[w.id]
    M.reassign(w, ws, nil, nil, function() M.publish(w, ws); require("cvim").layout(w) end)
  end, { desc = "new random partner Pokémon for this folder" })
end

return M
