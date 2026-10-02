-- Activity feed: recent agent events + `git status --short` of the workspace cwd.
local M = {}

local ICON = {
  UserPromptSubmit = "💬", Notification = "❓", Stop = "✅", SessionStart = "🚀",
  SessionEnd = "🛑", SubagentStop = "🤝", PreCompact = "🗜 ", Interrupted = "⏹ ",
}
local TOOL_ICON = {
  coding = "✏️ ", reading = "📖", searching = "🔍", bash = "💻", agent = "🤝", tool = "🛠 ",
}

function M.new_buf()
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].bufhidden = "hide"
  vim.bo[buf].filetype = "cvim-activity"
  return buf
end

local function line_for(ev)
  local t = os.date("%H:%M:%S", ev.ts or 0)
  local icon, what
  if ev.event == "PreToolUse" then
    icon = TOOL_ICON[require("cvim.state").tool_state(ev.tool)] or "🛠 "
    what = ev.tool or "?"
  else
    icon = ICON[ev.event] or "·"
    what = ev.event
  end
  local d = ev.detail or ""
  if d:match("^/") then d = vim.fn.fnamemodify(d, ":~:.") end
  d = d:gsub("\\n", " ")
  return string.format("%s %s %-9s %s", t, icon, what, d)
end

function M.refresh_git(ws, cwd)
  if not vim.system then return end
  vim.system({ "git", "-C", cwd, "status", "--short", "--branch" }, { text = true }, function(r)
    ws.git = r.code == 0 and vim.split(vim.trim(r.stdout or ""), "\n") or { "(not a git repo)" }
  end)
end

function M.render(buf, win, ws)
  if not (vim.api.nvim_buf_is_valid(buf) and ws) then return end
  local h = (win and vim.api.nvim_win_is_valid(win)) and vim.api.nvim_win_get_height(win) or 20
  local git = ws.git or {}
  local git_h = math.min(#git + 1, math.floor(h / 2))
  local feed_h = math.max(1, h - git_h)
  local out = {}
  local from = math.max(1, #ws.log - feed_h + 1)
  for i = #ws.log, from, -1 do out[#out + 1] = line_for(ws.log[i]) end -- newest first
  if #ws.log == 0 then out[1] = "  (no activity yet)" end
  while #out < feed_h do out[#out + 1] = "" end
  out[#out + 1] = "── git ─────────────────"
  for i = 1, git_h - 1 do if git[i] then out[#out + 1] = git[i] end end
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, out)
  vim.bo[buf].modifiable = false
end

return M
