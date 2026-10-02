-- Per-workspace agent state. Every agent ends up in the same state machine (idle, thinking,
-- coding, …) fed by normalized events { event, tool, detail, ts } named after Claude's hooks.
-- Where the events come from depends on the agent's adapter (cvim.agents):
--   hooks      ~/.cache/cvim/tabs/<id>.log (jsonl from claude/hooks/event.sh)
--              ~/.cache/cvim/tabs/<id>.status.json (statusLine JSON snapshot)
--   codex_log  cvim.adapters.codex (Codex session log)
--   activity   cvim.adapters.activity (terminal output only)
local M = {}

local uv = vim.uv or vim.loop
M.dir = (vim.env.CVIM_STATE_DIR or (vim.env.HOME .. "/.cache/cvim")) .. "/tabs"

M.ws = {} -- id -> { state, since, tool, detail, status, usage, log = {}, offset, status_mtime, kind }
local listeners = {}

-- tool name -> avatar state
local TOOL_STATE = {
  Edit = "coding", MultiEdit = "coding", Write = "coding", NotebookEdit = "coding",
  WebSearch = "searching", WebFetch = "searching",
  Read = "reading", Grep = "reading", Glob = "reading", LS = "reading",
  Bash = "bash", BashOutput = "bash", KillShell = "bash",
  Task = "agent", Agent = "agent",
}

function M.tool_state(tool)
  if not tool or tool == "" then return "tool" end
  return TOOL_STATE[tool] or "tool"
end

local ADAPTERS = { codex_log = "cvim.adapters.codex", activity = "cvim.adapters.activity" }

-- kind: the agent's state source (see cvim.agents); defaults to Claude's hooks
function M.new(id, kind)
  local ws = { id = id, state = "idle", since = os.time(), log = {}, offset = 0, status = nil, kind = kind or "hooks" }
  M.ws[id] = ws
  require("cvim.private").dir(M.dir)
  -- start clean for this id
  os.remove(M.dir .. "/" .. id .. ".log")
  os.remove(M.dir .. "/" .. id .. ".status.json")
  return ws
end

function M.adapter(ws)
  local mod = ADAPTERS[ws.kind]
  return mod and require(mod)
end

-- a new agent process in the same workspace (agent switched / restarted)
function M.reset(ws, kind)
  local a = M.adapter(ws)
  if a and a.detach then a.detach(ws) end
  ws.kind, ws.state, ws.since = kind or ws.kind, "idle", os.time()
  ws.status, ws.usage, ws.offset, ws.status_mtime = nil, nil, 0, nil
  os.remove(M.dir .. "/" .. ws.id .. ".log")
  os.remove(M.dir .. "/" .. ws.id .. ".status.json")
end

function M.remove(id)
  local ws = M.ws[id]
  local a = ws and M.adapter(ws)
  if a and a.detach then a.detach(ws) end
  M.ws[id] = nil
  os.remove(M.dir .. "/" .. id .. ".log")
  os.remove(M.dir .. "/" .. id .. ".status.json")
end

function M.on_change(fn) table.insert(listeners, fn) end

function M.set(ws, state, ev)
  ws.state = state
  ws.since = os.time()
  if ev then
    ws.tool = ev.tool ~= "" and ev.tool or ws.tool
    ws.detail = ev.detail
  end
end
local set = M.set

-- normalized event -> state (+ activity log)
function M.apply(ws, ev)
  local e = ev.event
  if e == "SessionStart" then set(ws, "idle", ev)
  elseif e == "UserPromptSubmit" then set(ws, "thinking", ev)
  elseif e == "PreToolUse" then set(ws, M.tool_state(ev.tool), ev)
  elseif e == "PostToolUse" or e == "SubagentStop" then
    -- only inside a turn: Claude also sends SubagentStop after Stop (and on its own)
    local st = ws.state
    if st ~= "done" and st ~= "idle" and st ~= "sleep" then set(ws, "thinking") end
  elseif e == "Notification" then set(ws, "waiting", ev)
  elseif e == "Stop" then set(ws, "done")
  elseif e == "Interrupted" then set(ws, "idle", ev) -- cancelled turn: no "done" (no EXP)
  elseif e == "PreCompact" then set(ws, "compact", ev)
  elseif e == "SessionEnd" then set(ws, "sleep")
  end
  if e ~= "PostToolUse" then
    table.insert(ws.log, ev)
    if #ws.log > 300 then table.remove(ws.log, 1) end
  end
end

local function read_new_lines(ws)
  local path = M.dir .. "/" .. ws.id .. ".log"
  local st = uv.fs_stat(path)
  if not st or st.size <= ws.offset then return false end
  local fd = uv.fs_open(path, "r", 438)
  if not fd then return false end
  local data = uv.fs_read(fd, st.size - ws.offset, ws.offset) or ""
  uv.fs_close(fd)
  -- only consume complete lines
  local last_nl = data:match(".*()\n")
  if not last_nl then return false end
  ws.offset = ws.offset + last_nl
  for line in data:sub(1, last_nl):gmatch("[^\n]+") do
    local ok, ev = pcall(vim.json.decode, line)
    if ok and type(ev) == "table" then M.apply(ws, ev) end
  end
  return true
end

local function read_status(ws)
  local path = M.dir .. "/" .. ws.id .. ".status.json"
  local st = uv.fs_stat(path)
  if not st or st.mtime.sec + st.mtime.nsec / 1e9 == ws.status_mtime then return false end
  ws.status_mtime = st.mtime.sec + st.mtime.nsec / 1e9
  local f = io.open(path, "r")
  if not f then return false end
  local ok, js = pcall(vim.json.decode, f:read("*a"), { luanil = { object = true, array = true } })
  f:close()
  if ok and type(js) == "table" then ws.status = js end
  return true
end

local function g(t, ...)
  for _, k in ipairs({ ... }) do
    if type(t) ~= "table" then return nil end
    t = t[k]
  end
  return t
end

local function num(v) return type(v) == "number" and v or nil end

-- usage in one shape for every agent (tabline, Pokémon HP/PP later):
--   { model, ctx = %, five_hour = { pct, resets_at }, seven_day = { pct, resets_at }, cost = USD }
function M.usage(ws)
  if not ws then return nil end
  if ws.usage then return ws.usage end -- adapters fill this directly
  local st = ws.status
  if not st then return nil end
  local function win(k)
    local p = num(g(st, "rate_limits", k, "used_percentage"))
    return p and { pct = p, resets_at = num(g(st, "rate_limits", k, "resets_at")) } or nil
  end
  return {
    model = g(st, "model", "display_name"),
    ctx = num(g(st, "context_window", "used_percentage")),
    five_hour = win("five_hour"),
    seven_day = win("seven_day"),
    cost = num(g(st, "cost", "total_cost_usd")),
  }
end

-- time-based transitions
local function tick_timeouts(ws)
  local age = os.time() - ws.since
  if ws.state == "done" and age >= 6 then set(ws, "idle"); return true end
  if ws.state == "idle" and age >= 180 then set(ws, "sleep"); return true end
  return false
end

function M.poll()
  local changed = false
  for _, ws in pairs(M.ws) do
    local a, b
    local adapter = M.adapter(ws)
    if adapter then
      local ok, res = pcall(adapter.poll, ws)
      a = ok and res
    else
      a = read_new_lines(ws)
      b = read_status(ws)
    end
    local c = tick_timeouts(ws)
    changed = changed or a or b or c
  end
  if changed then
    for _, fn in ipairs(listeners) do pcall(fn) end
  end
end

function M.start()
  if M.timer then return end
  M.timer = uv.new_timer()
  M.timer:start(200, 250, vim.schedule_wrap(M.poll))
end

return M
