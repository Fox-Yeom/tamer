-- Codex state adapter: tails the session log Codex writes for every conversation
--   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local time>-<id>.jsonl   (CODEX_HOME = ~/.codex)
-- and turns it into cvim's normalized events. Codex's own config (notify, hooks) is left alone.
-- A workspace claims the newest log whose session_meta.cwd is its folder and that was written
-- after its Codex process started; a later conversation (/new) in the same folder takes over.
--
--   task_started                 -> UserPromptSubmit (thinking)
--   reasoning                    -> PostToolUse      (thinking, not logged)
--   exec_command / write_stdin   -> PreToolUse Bash  (Read/Grep for read-only commands)
--   apply_patch                  -> PreToolUse Edit  (first file in the patch)
--   web_search_call              -> PreToolUse WebSearch
--   request_user_input           -> Notification     (waiting)
--   other tool calls (MCP …)     -> PreToolUse <name>
--   task_complete                -> Stop             (done: Pokémon EXP)
--   turn_aborted                 -> Interrupted      (idle, no EXP)
--   compacted                    -> PreCompact
--   token_count                  -> usage (ctx %, 5h = primary, 7d = secondary)
local M = {}

local uv = vim.uv or vim.loop
local state = require("cvim.state")

local claimed = {} -- log path -> ws id
local SCAN_EVERY = 1 -- s between directory scans

function M.home() return vim.env.CODEX_HOME or (vim.env.HOME .. "/.codex") end

local function real(p) return p and (uv.fs_realpath(p) or p) or p end

-- workspace -> Codex process started now (cwd = its folder)
function M.attach(ws, cwd)
  M.detach(ws)
  ws.codex = { cwd = real(cwd), started = os.time() - 2, offset = 0, scanned = 0 }
end

function M.detach(ws)
  if ws.codex and ws.codex.file then claimed[ws.codex.file] = nil end
  ws.codex = nil
end

local function first_line(path)
  local f = io.open(path, "r")
  if not f then return nil end
  local l = f:read("*l")
  f:close()
  return l
end

-- newest unclaimed log for this folder written since the agent started
local function find_log(c)
  local best, best_t
  for _, day in ipairs({ 0, -1 }) do -- today and yesterday (a session can cross midnight)
    local dir = M.home() .. "/sessions/" .. os.date("%Y/%m/%d", os.time() + day * 86400)
    local h = uv.fs_scandir(dir)
    while h do
      local name = uv.fs_scandir_next(h)
      if not name then break end
      if name:match("^rollout%-.*%.jsonl$") then
        local path = dir .. "/" .. name
        local st = uv.fs_stat(path)
        if st and st.mtime.sec >= c.started and (not claimed[path] or path == c.file)
          and (not best_t or st.birthtime.sec > best_t) then
          local ok, meta = pcall(vim.json.decode, first_line(path) or "")
          local p = ok and type(meta) == "table" and meta.payload
          if type(p) == "table" and meta.type == "session_meta" and real(p.cwd) == c.cwd then
            best, best_t = path, st.birthtime.sec
          end
        end
      end
    end
  end
  return best
end

local READ_CMDS = { rg = "Grep", grep = "Grep", cat = "Read", sed = "Read", head = "Read", tail = "Read",
  nl = "Read", ls = "LS", find = "Glob", fd = "Glob", wc = "Read" }

local function short(s) return (tostring(s or ""):gsub("%s+", " ")):sub(1, 200) end

-- one log record -> normalized event (or nil); updates usage in place
function M.translate(ws, rec)
  local p = type(rec.payload) == "table" and rec.payload or {}
  local t, ts = p.type, os.time()
  if rec.type == "turn_context" then
    ws.usage = ws.usage or {}
    ws.usage.model = p.model and (p.model .. (p.effort and (" " .. p.effort) or "")) or ws.usage.model
    return nil
  end
  if rec.type == "compacted" then return { event = "PreCompact", ts = ts, detail = "compact" } end
  if t == "task_started" then
    ws.codex.window = p.model_context_window or ws.codex.window
    return { event = "UserPromptSubmit", ts = ts }
  elseif t == "task_complete" then
    return { event = "Stop", ts = ts, detail = short(p.last_agent_message):sub(1, 120) }
  elseif t == "turn_aborted" then
    return { event = "Interrupted", ts = ts, detail = p.reason }
  elseif t == "reasoning" then
    return { event = "PostToolUse", ts = ts }
  elseif t == "web_search_call" then
    local a = type(p.action) == "table" and p.action or {}
    return { event = "PreToolUse", ts = ts, tool = "WebSearch", detail = short(a.query or a.url) }
  elseif t == "function_call" or t == "custom_tool_call" then
    local name = p.name or "?"
    if name == "request_user_input" then return { event = "Notification", ts = ts, detail = "입력 요청" } end
    if name == "apply_patch" then
      local input = p.input or p.arguments or ""
      return { event = "PreToolUse", ts = ts, tool = "Edit",
        detail = input:match("%*%*%* %a+ File: ([^\n]+)") or "patch" }
    end
    if name == "exec_command" or name == "write_stdin" then
      local ok, args = pcall(vim.json.decode, p.arguments or "")
      local cmd = ok and type(args) == "table" and (args.cmd or args.chars) or ""
      local first = tostring(cmd):match("^%s*([%w_%-%.]+)") or ""
      return { event = "PreToolUse", ts = ts, tool = READ_CMDS[first] or "Bash", detail = short(cmd) }
    end
    return { event = "PreToolUse", ts = ts, tool = name, detail = short(p.arguments or p.input) }
  elseif t == "token_count" then
    ws.usage = ws.usage or {}
    local info, rl = p.info, p.rate_limits
    if type(info) == "table" then
      local last = type(info.last_token_usage) == "table" and info.last_token_usage.total_tokens
      local window = info.model_context_window or ws.codex.window
      if type(last) == "number" and type(window) == "number" and window > 0 then
        ws.usage.ctx = math.floor(last / window * 100 + 0.5)
      end
    end
    if type(rl) == "table" then
      for key, src in pairs({ five_hour = rl.primary, seven_day = rl.secondary }) do
        if type(src) == "table" and type(src.used_percent) == "number" then
          ws.usage[key] = { pct = src.used_percent, resets_at = src.resets_at }
        end
      end
    end
    ws.usage_changed = true
    return nil
  end
end

local function read_new(ws)
  local c = ws.codex
  local st = uv.fs_stat(c.file)
  if not st or st.size <= c.offset then return false end
  local fd = uv.fs_open(c.file, "r", 438)
  if not fd then return false end
  local data = uv.fs_read(fd, st.size - c.offset, c.offset) or ""
  uv.fs_close(fd)
  local last_nl = data:match(".*()\n")
  if not last_nl then return false end
  c.offset = c.offset + last_nl
  local changed = false
  for line in data:sub(1, last_nl):gmatch("[^\n]+") do
    local ok, rec = pcall(vim.json.decode, line)
    if ok and type(rec) == "table" then
      local ev = M.translate(ws, rec)
      if ev then state.apply(ws, ev); changed = true end
    end
  end
  if ws.usage_changed then ws.usage_changed, changed = nil, true end
  return changed
end

function M.poll(ws)
  local c = ws.codex
  if not c then return false end
  local now = os.time()
  if now - c.scanned >= SCAN_EVERY * (c.file and 3 or 1) then -- keep looking for a newer conversation
    c.scanned = now
    local found = find_log(c)
    if found and found ~= c.file then
      if c.file then claimed[c.file] = nil end
      c.file, c.offset = found, 0
      claimed[found] = ws.id
    end
  end
  return c.file and read_new(ws) or false
end

return M
