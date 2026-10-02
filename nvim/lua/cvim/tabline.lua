-- Always-on top bar: workspace tabs (left) + what the agent is doing and its context / usage (right).
local M = {}

local STATE_ICON = {
  idle = "😌", sleep = "💤", thinking = "💭", coding = "⌨️", reading = "📖", searching = "🔍",
  bash = "💻", agent = "🤝", tool = "🛠", waiting = "❓", done = "🎉", compact = "🗜", error = "💥",
}

function M.icon(state) return STATE_ICON[state] or "·" end

function M.setup_hl()
  local set = vim.api.nvim_set_hl
  set(0, "CvimTabFill", { bg = "#16161c", fg = "#8a8a8a" })
  set(0, "CvimTabSel", { bg = "#D97757", fg = "#1b1b1f", bold = true })
  set(0, "CvimTab", { bg = "#24242c", fg = "#b0b0b0" })
  set(0, "CvimBrand", { bg = "#D97757", fg = "#1b1b1f", bold = true })
  set(0, "CvimOk", { bg = "#16161c", fg = "#3DDC84" })
  set(0, "CvimWarn", { bg = "#16161c", fg = "#F5C542" })
  set(0, "CvimBad", { bg = "#16161c", fg = "#E5484D", bold = true })
  set(0, "CvimDim", { bg = "#16161c", fg = "#8a8a8a" })
  set(0, "CvimBtn", { bg = "#24242c", fg = "#d0d0d0", bold = true })
  set(0, "CvimBtnClose", { bg = "#E5484D", fg = "#ffffff", bold = true })
end

local function g(t, ...)
  for _, k in ipairs({ ... }) do
    if type(t) ~= "table" then return nil end
    t = t[k]
  end
  return t
end

local function level(p)
  if not p then return "CvimDim" end
  if p >= 80 then return "CvimBad" elseif p >= 50 then return "CvimWarn" end
  return "CvimOk"
end

local function bar(p, n)
  n = n or 8
  local fill = math.floor((p or 0) / 100 * n + 0.5)
  return string.rep("█", fill) .. string.rep("░", n - fill)
end

local function until_reset(epoch)
  if type(epoch) ~= "number" then return "" end
  local s = epoch - os.time()
  if s <= 0 then return "" end
  local h, m = math.floor(s / 3600), math.floor((s % 3600) / 60)
  if h >= 24 then return string.format(" ↻%dd%dh", math.floor(h / 24), h % 24) end
  return h > 0 and string.format(" ↻%dh%02dm", h, m) or string.format(" ↻%dm", m)
end

-- one line for what the agent is doing now ("입력 필요", "편집 init.lua", …); waiting is loud
local DOING = {
  thinking = "생각 중", coding = "편집", reading = "읽는 중", searching = "검색", bash = "실행",
  agent = "하위 에이전트", tool = "도구", waiting = "입력 필요", done = "완료", compact = "압축 중", error = "오류",
}

local function doing(ws)
  local what = ws and DOING[ws.state]
  if not what then return "" end
  local d = ws.detail and tostring(ws.detail) or ""
  if d:match("^/") then d = vim.fn.fnamemodify(d, ":t") end
  d = d:gsub("%%", "%%%%"):gsub("\\n", " "):sub(1, 28)
  if ws.state == "waiting" then return "%#CvimBad# ❗ " .. what .. " %#CvimDim#│" end
  if ws.state == "done" or ws.state == "thinking" or d == "" then d = "" else d = " " .. d end
  return "%#CvimDim# " .. STATE_ICON[ws.state] .. " " .. what .. d .. " │"
end

local function usage(u, agent)
  if not u then return "%#CvimDim# waiting for " .. agent .. "… " end
  local parts = {}
  if u.model then parts[#parts + 1] = "%#CvimDim# " .. u.model end
  if u.ctx then
    parts[#parts + 1] = string.format("%%#%s# ctx %s %d%%%%", level(u.ctx), bar(u.ctx), u.ctx)
  end
  if u.five_hour then
    parts[#parts + 1] = string.format("%%#%s# 5h %d%%%%%s", level(u.five_hour.pct), u.five_hour.pct,
      until_reset(u.five_hour.resets_at))
  end
  if u.seven_day then
    parts[#parts + 1] = string.format("%%#%s# 7d %d%%%%", level(u.seven_day.pct), u.seven_day.pct)
  end
  if u.cost then parts[#parts + 1] = string.format("%%#CvimDim# $%.2f", u.cost) end
  if #parts == 0 then return "%#CvimDim# " .. agent .. " " end
  return table.concat(parts, " %#CvimDim#│") .. " "
end

function M.render()
  local cvim = require("cvim")
  local out = { "%#CvimBrand# ✻ CVIM %#CvimTabFill# %<" }
  local cur = vim.api.nvim_get_current_tabpage()
  -- macOS tabs mode: the native tab bar lists the tabs; just show this workspace
  local tabs = require("cvim.wintabs").enabled() and { cur } or vim.api.nvim_list_tabpages()
  for i, tab in ipairs(tabs) do
    local w = cvim.workspaces[tab]
    local ws = w and require("cvim.state").ws[w.id]
    local name, icon = "tab", "·"
    if w then
      name, icon = vim.fn.fnamemodify(w.cwd, ":t"), ws and STATE_ICON[ws.state] or "·"
      if ws and ws.state == "waiting" then icon = "❗" .. icon end -- needs you
    else
      local buf = vim.api.nvim_win_get_buf(vim.api.nvim_tabpage_get_win(tab))
      local bn = vim.api.nvim_buf_get_name(buf)
      name = bn ~= "" and vim.fn.fnamemodify(bn, ":t") or name
      if vim.wo[vim.api.nvim_tabpage_get_win(tab)].diff then icon = "📝" end
    end
    local grp = tab == cur and "%#CvimTabSel#" or "%#CvimTab#"
    out[#out + 1] = string.format("%%%dT%s %d %s %s %%T%%#CvimTabFill# ", i, grp, i, icon, name)
  end
  out[#out + 1] = "%="
  local w = cvim.workspaces[cur]
  local ws = w and require("cvim.state").ws[w.id]
  local agent = w and require("cvim.agents").get(w.agent).short or "agent"
  out[#out + 1] = doing(ws)
  out[#out + 1] = usage(require("cvim.state").usage(ws), agent)
  out[#out + 1] = require("cvim.window").buttons()
  return table.concat(out)
end

return M
