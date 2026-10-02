-- Procedural pixel sprites for the Claude-ish mascot.
-- A frame is a canvas: W x H grid of palette keys (nil = transparent).
-- sprites.frame(state, n) -> canvas, where n is a monotonically increasing frame counter.
local M = {}

M.W, M.H = 22, 14

M.palette = {
  o = "#D97757", -- claude orange
  d = "#B4583A", -- shade
  k = "#1B1B1F", -- eyes
  w = "#F4F1EA", -- white
  g = "#8A8A8A", -- gray
  G = "#D9D9D9", -- light gray (lit key)
  K = "#3A3A40", -- dark (keyboard / screen)
  y = "#F5C542", -- sparkle / question
  b = "#7CC4F2", -- glass
  t = "#3DDC84", -- terminal green
  r = "#E5484D", -- error red
  R = "#9E2A2E", -- error shade
  z = "#9DA7FF", -- zzz
}

local function canvas()
  local c = {}
  for y = 0, M.H - 1 do c[y] = {} end
  return c
end

local function px(c, x, y, col)
  if y >= 0 and y < M.H and x >= 0 and x < M.W then c[y][x] = col end
end

local function rect(c, x1, y1, x2, y2, col)
  for y = y1, y2 do
    for x = x1, x2 do px(c, x, y, col) end
  end
end

-- opts: dy, eyes(open|blink|closed|up|left|right|down|happy|x), arms(side|up|wave|typeA|typeB|hold), body, shade
local function mascot(c, o)
  local dy = o.dy or 0
  local body, shade = o.body or "o", o.shade or "d"
  -- body
  rect(c, 4, 3 + dy, 15, 10 + dy, body)
  rect(c, 4, 10 + dy, 15, 10 + dy, shade)
  -- legs
  for _, x in ipairs({ 5, 7, 12, 14 }) do rect(c, x, 11 + dy, x, 12 + dy, shade) end
  -- arms
  local a = o.arms or "side"
  if a == "side" then
    rect(c, 2, 6 + dy, 3, 7 + dy, body); rect(c, 16, 6 + dy, 17, 7 + dy, body)
  elseif a == "up" then
    rect(c, 2, 2 + dy, 3, 4 + dy, body); rect(c, 16, 2 + dy, 17, 4 + dy, body)
  elseif a == "wave" then
    rect(c, 2, 6 + dy, 3, 7 + dy, body); rect(c, 16, 2 + dy, 17, 4 + dy, body)
  elseif a == "typeA" then
    rect(c, 2, 8 + dy, 3, 9 + dy, body); rect(c, 16, 7 + dy, 17, 8 + dy, body)
  elseif a == "typeB" then
    rect(c, 2, 7 + dy, 3, 8 + dy, body); rect(c, 16, 8 + dy, 17, 9 + dy, body)
  elseif a == "hold" then
    rect(c, 2, 6 + dy, 3, 7 + dy, body); rect(c, 16, 7 + dy, 17, 8 + dy, body)
  end
  -- eyes (base at x=7 and x=12, y=5..6)
  local e = o.eyes or "open"
  local ex, ey = 0, 0
  if e == "up" then ey = -1 elseif e == "down" then ey = 1
  elseif e == "left" then ex = -1 elseif e == "right" then ex = 1 end
  if e == "blink" or e == "closed" then
    px(c, 6, 6 + dy, "k"); px(c, 7, 6 + dy, "k"); px(c, 12, 6 + dy, "k"); px(c, 13, 6 + dy, "k")
  elseif e == "happy" then
    for _, cx in ipairs({ 7, 12 }) do
      px(c, cx - 1, 6 + dy, "k"); px(c, cx, 5 + dy, "k"); px(c, cx + 1, 6 + dy, "k")
    end
  elseif e == "x" then
    for _, cx in ipairs({ 7, 12 }) do
      px(c, cx - 1, 4 + dy, "k"); px(c, cx + 1, 4 + dy, "k"); px(c, cx, 5 + dy, "k")
      px(c, cx - 1, 6 + dy, "k"); px(c, cx + 1, 6 + dy, "k")
    end
  else
    for _, cx in ipairs({ 7, 12 }) do rect(c, cx + ex, 5 + dy + ey, cx + ex, 6 + dy + ey, "k") end
  end
end

local function blink(n) return (n % 28 == 0 or n % 28 == 1) and "blink" or nil end

local F = {}

F.idle = function(c, n)
  local dy = (n % 16 < 8) and 0 or 0
  mascot(c, { dy = dy, eyes = blink(n) or "open", arms = "side" })
end

F.sleep = function(c, n)
  mascot(c, { dy = 1, eyes = "closed", arms = "side" })
  local z = math.floor(n / 4) % 3
  -- three little z's drifting up-right
  for i = 0, z do
    local zx, zy = 16 + i * 2, 3 - i
    px(c, zx, zy, "z"); px(c, zx + 1, zy, "z")
  end
end

F.thinking = function(c, n)
  local look = ({ "up", "up", "left", "up", "up", "right" })[math.floor(n / 6) % 6 + 1]
  mascot(c, { eyes = blink(n) or look, arms = "side" })
  local dots = math.floor(n / 3) % 4
  for i = 1, dots do px(c, 6 + i * 3, 0, "g"); px(c, 7 + i * 3, 0, "g") end
end

F.coding = function(c, n)
  local phase = math.floor(n / 2) % 2 == 0
  mascot(c, { eyes = "down", arms = phase and "typeA" or "typeB" })
  -- keyboard in front
  rect(c, 1, 11, 18, 12, "K")
  for x = 2, 17, 2 do px(c, x, 11, "g") end
  -- random lit keys
  local seed = math.floor(n / 2)
  for i = 0, 2 do
    local kx = 2 + ((seed * 7 + i * 5) % 8) * 2
    px(c, kx, 11, "G")
  end
end

F.reading = function(c, n)
  local look = (math.floor(n / 5) % 2 == 0) and "left" or "down"
  mascot(c, { eyes = blink(n) or look, arms = "hold" })
  -- page in hands
  rect(c, 3, 8, 9, 12, "w")
  for y = 9, 11 do
    local len = (y + math.floor(n / 4)) % 3
    rect(c, 4, y, 6 + len, y, "g")
  end
end

F.searching = function(c, n)
  local bob = (math.floor(n / 3) % 2 == 0) and 0 or 1
  mascot(c, { eyes = "right", arms = "wave" })
  -- magnifier
  local cx, cy = 19, 2 + bob
  rect(c, cx - 1, cy - 1, cx + 1, cy + 1, "b")
  for _, p in ipairs({ { -2, -1 }, { -2, 0 }, { -2, 1 }, { 2, -1 }, { 2, 0 }, { 2, 1 }, { -1, -2 }, { 0, -2 }, { 1, -2 }, { -1, 2 }, { 0, 2 }, { 1, 2 } }) do
    px(c, cx + p[1], cy + p[2], "g")
  end
  px(c, cx - 2, cy + 3, "g"); px(c, cx - 3, cy + 4, "g")
  if n % 6 < 2 then px(c, cx - 1, cy - 1, "w") end
end

F.bash = function(c, n)
  local phase = math.floor(n / 2) % 2 == 0
  mascot(c, { eyes = "right", arms = phase and "typeA" or "typeB" })
  -- tiny terminal screen top-right
  rect(c, 16, 0, 21, 4, "K")
  px(c, 17, 1, "t"); px(c, 18, 2, "t"); px(c, 17, 3, "t") -- '>'
  if n % 6 < 3 then rect(c, 19, 3, 20, 3, "t") end      -- blinking cursor
end

F.agent = function(c, n)
  mascot(c, { eyes = blink(n) or "right", arms = "side" })
  -- mini clone
  local hop = (math.floor(n / 3) % 2 == 0) and 0 or -1
  rect(c, 17, 8 + hop, 21, 11 + hop, "o")
  px(c, 18, 9 + hop, "k"); px(c, 20, 9 + hop, "k")
  px(c, 18, 12 + hop, "d"); px(c, 20, 12 + hop, "d")
end

F.tool = function(c, n)
  local phase = math.floor(n / 3) % 2 == 0
  mascot(c, { eyes = blink(n) or "open", arms = phase and "wave" or "side" })
  -- spinning gear-ish sparkle
  local s = math.floor(n / 2) % 4
  local pts = { { 19, 1 }, { 20, 2 }, { 19, 3 }, { 18, 2 } }
  rect(c, 18, 1, 20, 3, "g"); px(c, 19, 2, "K")
  px(c, pts[s + 1][1], pts[s + 1][2], "y")
end

F.waiting = function(c, n)
  local bob = (math.floor(n / 4) % 2 == 0) and 0 or -1
  mascot(c, { eyes = blink(n) or "open", arms = "wave", dy = bob })
  -- '?'
  local qx, qy = 18, 0
  rect(c, qx, qy, qx + 2, qy, "y"); px(c, qx + 2, qy + 1, "y")
  px(c, qx + 1, qy + 2, "y"); px(c, qx + 1, qy + 4, "y")
end

F.done = function(c, n)
  local dy = (math.floor(n / 2) % 2 == 0) and 0 or -1
  mascot(c, { eyes = "happy", arms = "up", dy = dy })
  local seed = math.floor(n / 2)
  for i = 0, 3 do
    local sx = (seed * 5 + i * 7) % M.W
    local sy = (seed * 3 + i * 4) % 4
    if sx < 4 or sx > 15 then px(c, sx, sy, "y") end
  end
end

F.compact = function(c, n)
  local squish = math.floor(n / 3) % 2 == 0
  mascot(c, { eyes = "closed", arms = "side", dy = squish and 1 or 0 })
  if squish then rect(c, 4, 3, 15, 3, nil) end
  rect(c, 0, 7, 1, 7, "g"); rect(c, 18, 7, 19, 7, "g")
end

F.error = function(c, n)
  local shake = (n % 4 < 2) and 0 or 0
  mascot(c, { eyes = "x", arms = "side", body = "r", shade = "R", dy = shake })
end

M.states = vim.tbl_keys(F)

-- canvas of hex colors: { W, H, [y][x] = "#rrggbb" }
function M.frame(state, n)
  local c = canvas()
  ;(F[state] or F.idle)(c, n)
  local out = { W = M.W, H = M.H }
  for y = 0, M.H - 1 do
    out[y] = {}
    for x, k in pairs(c[y]) do out[y][x] = M.palette[k] end
  end
  return out
end

-- label shown under the sprite
M.labels = {
  idle = "😌 Idle", sleep = "💤 Sleeping", thinking = "💭 Thinking",
  coding = "⌨️  Coding", reading = "📖 Reading", searching = "🔍 Web search",
  bash = "💻 Terminal", agent = "🤝 Subagent", tool = "🛠  Tool",
  waiting = "❓ Needs you", done = "🎉 Done", compact = "🗜  Compacting", error = "💥 Error",
}

return M
