-- Agent registry: which CLI coding agent a workspace runs, and how cvim learns its state.
--   state = "hooks"      Claude Code: hook/statusLine files (claude/settings.json)
--         = "codex_log"  Codex: tails its session log (~/.codex/sessions/**/rollout-*.jsonl)
--         = "activity"   anything else: terminal output activity (working / idle only)
-- Override or add agents in ~/.cvim/agents.lua (or $CVIM_AGENTS), returning a table like DEFS:
--   return { aider = { name = "Aider", icon = "⌘", cmd = { "aider" }, state = "activity" } }
-- The chosen agent is remembered per folder (~/.cache/cvim/agents.json).
local M = {}

local CACHE = vim.env.CVIM_CACHE_DIR or (vim.env.HOME .. "/.cache/cvim")
local CHOICE = CACHE .. "/agents.json"

M.ORDER = { "claude", "codex", "gemini", "opencode" }

local DEFS = {
  claude = {
    name = "Claude Code", short = "Claude", icon = "✻", color = "#D97757",
    cmd = { "claude" }, state = "hooks", ide = true,
  },
  codex = {
    name = "Codex", short = "Codex", icon = "◎", color = "#10A37F",
    -- the npm wrapper can be installed without its native binary; the app's copy always works
    cmd = { "/Applications/Codex.app/Contents/Resources/codex", "codex" }, state = "codex_log",
  },
  gemini = { name = "Gemini CLI", short = "Gemini", icon = "✦", color = "#4F8DF7", cmd = { "gemini" }, state = "activity" },
  opencode = { name = "OpenCode", short = "OpenCode", icon = "◆", color = "#E0E0E0", cmd = { "opencode" }, state = "activity" },
}

local function user_defs()
  local path = vim.env.CVIM_AGENTS or (vim.env.HOME .. "/.cvim/agents.lua")
  if vim.fn.filereadable(path) == 0 then return {} end
  local ok, t = pcall(dofile, path)
  if ok and type(t) == "table" then return t end
  vim.notify("cvim: " .. path .. " 읽기 실패: " .. tostring(t), vim.log.levels.WARN)
  return {}
end

local defs
function M.defs()
  if defs then return defs end
  defs = vim.deepcopy(DEFS)
  for key, d in pairs(user_defs()) do
    defs[key] = vim.tbl_extend("force", defs[key] or { name = key, icon = "▸", state = "activity" }, d)
    if not vim.tbl_contains(M.ORDER, key) then M.ORDER[#M.ORDER + 1] = key end
  end
  for key, d in pairs(defs) do
    d.key = key
    d.short = d.short or d.name
    if type(d.cmd) == "string" then d.cmd = { d.cmd } end
  end
  return defs
end

function M.get(key) return M.defs()[key] or M.defs().claude end

-- first runnable candidate of the agent's command (absolute path or found on PATH)
function M.bin(key)
  local d = M.defs()[key]
  if not d then return nil end
  for _, c in ipairs(d.cmd or {}) do
    local exe = c:match("^%S+")
    if exe and vim.fn.executable(exe) == 1 then return c end
  end
end

function M.available()
  local out = {}
  for _, key in ipairs(M.ORDER) do
    if M.defs()[key] and M.bin(key) then out[#out + 1] = key end
  end
  return out
end

-- ── remembered choice ───────────────────────────────────────────────────────
local function read_choice()
  local f = io.open(CHOICE, "r")
  if not f then return {} end
  local ok, t = pcall(vim.json.decode, f:read("*a"))
  f:close()
  return ok and type(t) == "table" and t or {}
end

local function write_choice(t)
  require("cvim.private").dir(CACHE)
  local f = io.open(CHOICE .. ".tmp", "w")
  if not f then return end
  f:write(vim.json.encode(t))
  f:close()
  os.rename(CHOICE .. ".tmp", CHOICE)
  require("cvim.private").file(CHOICE)
end

-- agent for a folder: env override > folder's last choice > global default > claude
function M.for_dir(dir)
  local env = vim.env.CVIM_AGENT
  if env and M.defs()[env] then return env end
  local t = read_choice()
  local candidates = { dir and t[dir] or false, t._default or false } -- (ipairs would stop at a nil)
  for i = 1, #candidates do
    local key = candidates[i]
    if key and M.defs()[key] and M.bin(key) then return key end
  end
  return "claude"
end

function M.default() return M.for_dir(nil) end

function M.remember(dir, key)
  local t = read_choice()
  if dir then t[dir] = key else t._default = key end
  write_choice(t)
end

-- next available agent after `key` (start screen "a" cycles through them)
function M.next(key)
  local list = M.available()
  if #list == 0 then return key end
  for i, k in ipairs(list) do
    if k == key then return list[i % #list + 1] end
  end
  return list[1]
end

function M.label(key)
  local d = M.get(key)
  return d.icon .. " " .. d.name
end

return M
