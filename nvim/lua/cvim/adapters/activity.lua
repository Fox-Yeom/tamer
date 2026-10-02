-- Activity adapter for agents cvim has no log for (Gemini CLI, OpenCode, custom): watches the
-- agent's terminal buffer. Steady output = working ("thinking"), quiet = idle. It never reports
-- "done", so these agents don't earn Pokémon EXP (a heuristic shouldn't pay out).
local M = {}

local state = require("cvim.state")

local WINDOW = 8     -- polls (250 ms each) looked at
local BUSY_HITS = 3  -- output in ≥ 3 of the last 8 polls = working (typing echo alone isn't enough)
local QUIET_S = 5    -- s without output = idle again

function M.attach(ws, buf)
  ws.activity = { buf = buf, tick = 0, hits = {}, last = 0 }
end

function M.detach(ws) ws.activity = nil end

function M.poll(ws)
  local a = ws.activity
  if not (a and a.buf and vim.api.nvim_buf_is_valid(a.buf)) then return false end
  local tick = vim.api.nvim_buf_get_changedtick(a.buf)
  local changed = tick ~= a.tick
  a.tick = tick
  table.insert(a.hits, changed and 1 or 0)
  if #a.hits > WINDOW then table.remove(a.hits, 1) end
  local now = os.time()
  if changed then a.last = now end
  local hits = 0
  for _, h in ipairs(a.hits) do hits = hits + h end

  local busy = ws.state == "thinking"
  if not busy and hits >= BUSY_HITS then
    state.apply(ws, { event = "UserPromptSubmit", ts = now, detail = "출력 중" })
    return true
  elseif busy and now - a.last >= QUIET_S then
    state.set(ws, "idle")
    return true
  end
  return false
end

return M
