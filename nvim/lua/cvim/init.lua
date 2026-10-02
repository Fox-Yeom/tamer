-- cvim: one Neovim tab = one workspace = agent terminal (Claude Code, Codex, …) + avatar + activity + shell
local state = require("cvim.state")
local avatar = require("cvim.avatar")
local activity = require("cvim.activity")
local tabline = require("cvim.tabline")
local ide = require("cvim.ide")
local agents = require("cvim.agents")

local M = {}
M.workspaces = {} -- tabpage handle -> workspace

local function repo_root()
  if vim.env.CVIM_ROOT and vim.env.CVIM_ROOT ~= "" then return vim.env.CVIM_ROOT end
  local src = debug.getinfo(1, "S").source:sub(2)
  return vim.fn.fnamemodify(vim.fn.resolve(src), ":h:h:h:h") -- nvim/lua/cvim/init.lua -> repo
end
M.root = repo_root()

local note_recent -- defined in the "folders" section below; used by new_workspace

-- user's own statusLine command, chained after ours so it keeps working inside Claude
local function user_statusline()
  local f = io.open(vim.env.HOME .. "/.claude/settings.json", "r")
  if not f then return nil end
  local ok, js = pcall(vim.json.decode, f:read("*a"))
  f:close()
  local cmd = ok and type(js) == "table" and type(js.statusLine) == "table" and js.statusLine.command
  if type(cmd) == "string" and not cmd:find("cvim", 1, true) and not cmd:find("statusline.sh\"$CVIM", 1, true) then
    return cmd
  end
end

-- ── terminals ───────────────────────────────────────────────────────────────
local function open_term(cmd, opts)
  local buf = vim.api.nvim_create_buf(false, false)
  vim.bo[buf].bufhidden = "hide"
  vim.api.nvim_buf_call(buf, function()
    vim.fn.jobstart(cmd, vim.tbl_extend("force", { term = true }, opts or {}))
  end)
  return buf
end

-- the agent's command line. Claude gets cvim's hooks/statusLine through --settings; the others
-- run as they are (their state comes from adapters, not from their config).
local function agent_cmd(key)
  if key == "claude" then
    local base = vim.env.CVIM_CLAUDE_CMD or "claude"
    return { vim.o.shell, "-c", base .. " --settings " .. vim.fn.shellescape(M.root .. "/claude/settings.json") }
  end
  local bin = agents.bin(key) or key
  local exe, rest = bin:match("^(%S+)(.*)$")
  return { vim.o.shell, "-c", vim.fn.shellescape(exe) .. (rest or "") }
end

-- (w.claude_buf is the agent terminal, whichever agent runs in it; the name predates Codex)
local function start_agent(w)
  local def = agents.get(w.agent)
  local env = {
    CVIM_TAB_ID = w.id,
    CVIM_ROOT = M.root,
    CVIM_STATE_DIR = vim.fn.fnamemodify(state.dir, ":h"),
  }
  if def.ide then env = vim.tbl_extend("force", ide.env(), env) end
  if w.agent == "claude" then env.CVIM_CHAIN_STATUSLINE = user_statusline() end
  local buf
  buf = open_term(agent_cmd(w.agent), {
    cwd = w.cwd,
    env = env,
    on_exit = function()
      -- a replaced agent (⌘G / restart) exits after its successor started: ignore it
      if w.claude_buf ~= buf then return end
      local ws = state.ws[w.id]
      if ws then ws.state, ws.since = "sleep", os.time() end
    end,
  })
  w.claude_buf = buf
  vim.b[w.claude_buf].cvim_role = "agent"
  vim.b[w.claude_buf].cvim_agent = w.agent
  local ws = state.ws[w.id]
  local adapter = ws and state.adapter(ws)
  if adapter then adapter.attach(ws, w.agent == "codex" and w.cwd or w.claude_buf) end
end

local function agent_hl(key)
  local def = agents.get(key)
  local name = "CvimAgent_" .. key
  vim.api.nvim_set_hl(0, name, { bg = def.color or "#D97757", fg = "#1b1b1f", bold = true })
  return name
end

-- ── layout ──────────────────────────────────────────────────────────────────
local function mode_for(cols)
  if cols >= 150 then return "wide" end   -- claude | avatar / activity / shell
  if cols >= 100 then return "medium" end -- claude | avatar / shell
  return "narrow"                          -- claude only (state lives in the tabline)
end

local function side_opts(win, title, fixh)
  local wo = vim.wo[win]
  wo.number, wo.relativenumber, wo.signcolumn = false, false, "no"
  wo.foldcolumn, wo.cursorline, wo.wrap, wo.list = "0", false, false, false
  wo.statuscolumn = ""
  wo.winfixwidth = true
  wo.winfixheight = fixh or false
  wo.winbar = "%#CvimTab# " .. title .. " %#Normal#"
end

local function layout_impl(w)
  local tab = w.tab
  if not vim.api.nvim_tabpage_is_valid(tab) then return end
  local prev_buf = vim.api.nvim_get_current_buf()
  local prev_win = vim.api.nvim_get_current_win()
  local prev_float = vim.api.nvim_win_get_config(prev_win).relative ~= ""
  local prev_mode = vim.api.nvim_get_mode().mode
  M._building = true

  -- find / pick main window, close the rest
  local main
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(tab)) do
    if vim.api.nvim_win_get_buf(win) == w.claude_buf then main = win end
  end
  main = main or vim.api.nvim_tabpage_get_win(tab)
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(tab)) do
    if win ~= main and vim.api.nvim_win_get_config(win).relative == "" then
      pcall(vim.api.nvim_win_close, win, true)
    end
  end
  vim.api.nvim_win_set_buf(main, w.claude_buf)
  local mwo = vim.wo[main]
  mwo.number, mwo.relativenumber, mwo.signcolumn = false, false, "no"
  mwo.winbar = "%#" .. agent_hl(w.agent) .. "# " .. agents.label(w.agent) .. " %#CvimTabFill# "
    .. vim.fn.fnamemodify(w.cwd, ":~") .. " %#CvimDim#⌘G 에이전트 바꾸기 "

  local cols, lines = vim.o.columns, vim.o.lines
  w.mode = w.zoom and "narrow" or mode_for(cols)
  w.wins = { claude = main }
  local editor = w.editor_open and not w.zoom and w.editor_buf and vim.api.nvim_buf_is_valid(w.editor_buf)
  -- medium width can't fit claude + editor + side column: drop the side column
  if editor and w.mode == "medium" then w.mode = "editor" end

  if w.mode ~= "narrow" and w.mode ~= "editor" then
    local side_w = math.floor(cols * (w.mode == "wide" and 0.36 or 0.40))
    -- avatar pane sized for the Pokémon at 1:1 when there's room (max 32 rows); otherwise it
    -- shrinks and the sprite drops to exactly 1/2 (crisp dominant-colour blocks), never in between.
    -- The activity feed folds away before the avatar gets squeezed.
    local avail = lines - 3
    local ws = state.ws[w.id]
    local poke = ws and ws.pokemon
    local AV_H = poke and math.min(32, math.ceil(poke.h / 2) + 4) or 22 -- sprite rows + label + caption + winbar
    if require("cvim.pokemon").native() then AV_H = 16 end -- macOS draws the GIF: compact pane
    local SHELL_MIN, ACT_MIN = 6, 5
    local with_activity = w.mode == "wide" and avail - AV_H >= SHELL_MIN + ACT_MIN
    local av_h = math.max(8, math.min(AV_H, avail - SHELL_MIN - (with_activity and ACT_MIN or 0)))
    local av = vim.api.nvim_open_win(w.avatar_buf, false, { split = "right", win = main, width = side_w })
    w.wins.avatar = av
    if not (w.shell_buf and vim.api.nvim_buf_is_valid(w.shell_buf)) then
      w.shell_buf = open_term({ vim.o.shell }, { cwd = w.cwd })
    end
    local below = av
    if with_activity then
      w.wins.activity = vim.api.nvim_open_win(w.activity_buf, false, { split = "below", win = av })
      below = w.wins.activity
    end
    w.wins.shell = vim.api.nvim_open_win(w.shell_buf, false, { split = "below", win = below })

    vim.api.nvim_win_set_height(av, av_h)
    if w.wins.activity then
      vim.api.nvim_win_set_height(w.wins.activity, math.max(ACT_MIN, math.floor((avail - av_h) / 2)))
    end
    side_opts(av, "🐾 Avatar", true)
    if w.wins.activity then side_opts(w.wins.activity, "📋 Activity") end
    side_opts(w.wins.shell, "🐚 Shell")
    vim.api.nvim_win_set_width(av, side_w)
  end

  -- editor pane (files Claude opens / you open) between claude and the side column
  if editor and w.mode ~= "narrow" then
    local ed = vim.api.nvim_open_win(w.editor_buf, false, { split = "right", win = main })
    w.wins.editor = ed
    local ewo = vim.wo[ed]
    ewo.number, ewo.signcolumn = true, "yes"
    ewo.winbar = "%#CvimTab# 📝 %f %m%#Normal#"
    vim.api.nvim_win_set_width(main, math.floor(cols * (w.mode == "wide" and 0.34 or 0.45)))
  end

  -- restore focus. Floats (prompt composer) survive the rebuild: stay there, in the same mode.
  if prev_float and vim.api.nvim_win_is_valid(prev_win) then
    vim.api.nvim_set_current_win(prev_win)
    if prev_mode:sub(1, 1) == "i" then vim.cmd("startinsert") end
  else
    local focus = main
    for _, win in pairs(w.wins) do
      if vim.api.nvim_win_get_buf(win) == prev_buf then focus = win end
    end
    vim.api.nvim_set_current_win(focus)
  end
  M.render_panels(w)
end

-- Layout closes the side panes first and rebuilds them, so a failure midway (e.g. "E36: Not enough
-- room" while the GUI is still sizing itself at startup) would leave only the Claude pane.
-- Always reset the guard and retry once the window has settled.
function M.layout(w)
  w = w or M.workspaces[vim.api.nvim_get_current_tabpage()]
  if not w then return end
  local ok, err = pcall(layout_impl, w)
  M._building = false
  if not ok then
    w.layout_retries = (w.layout_retries or 0) + 1
    if w.layout_retries <= 5 then
      vim.defer_fn(function() M.layout(w) end, 150 * w.layout_retries)
    else
      vim.notify("cvim: layout failed: " .. tostring(err), vim.log.levels.WARN)
    end
    return
  end
  w.layout_retries = 0
  pcall(require("cvim.compose").reposition, w)
  pcall(require("cvim.pokemon").publish, w, state.ws[w.id]) -- native avatar follows the pane
end

function M.title()
  local w = M.workspaces[vim.api.nvim_get_current_tabpage()]
  if not w then return "CVIM" end
  local ws = state.ws[w.id]
  return tabline.icon(ws and ws.state) .. " " .. vim.fn.fnamemodify(w.cwd, ":t")
end

function M.focus_claude()
  local w = M.workspaces[vim.api.nvim_get_current_tabpage()]
  if not (w and w.wins.claude and vim.api.nvim_win_is_valid(w.wins.claude)) then return end
  local win = w.wins.claude
  vim.api.nvim_set_current_win(win)
  -- called from mappings (e.g. composer ⌘⇧⏎ in Insert mode): a direct startinsert is lost when
  -- the mapping's mode ends, leaving Terminal-Normal ("nt") where Hangul does nothing. Defer it.
  vim.schedule(function()
    if vim.api.nvim_get_current_win() == win and vim.api.nvim_get_mode().mode ~= "t" then
      vim.cmd("startinsert")
    end
  end)
end

-- diff review (claudecode.nvim) -> avatar "waiting" on workspaces that are mid-edit
function M.mark_review(open, file)
  for _, w in pairs(M.workspaces) do
    local ws = state.ws[w.id]
    if ws then
      if open and (ws.state == "coding" or ws.state == "thinking" or ws.state == "tool") then
        ws.state, ws.since, ws.detail, ws.review = "waiting", os.time(), file or ws.detail, true
      elseif not open and ws.review then
        ws.state, ws.since, ws.review = "thinking", os.time(), nil
      end
    end
  end
  vim.cmd("redrawtabline")
end

function M.render_panels(w)
  local ws = state.ws[w.id]
  if w.wins.activity then activity.render(w.activity_buf, w.wins.activity, ws) end
end

-- ── workspaces ──────────────────────────────────────────────────────────────
function M.new_workspace(cwd, opts)
  cwd = vim.fn.fnamemodify(cwd or vim.fn.getcwd(), ":p"):gsub("/$", "")
  local cur = vim.api.nvim_get_current_tabpage()
  local fresh = (opts and opts.reuse and not M.workspaces[cur])
    or (not M.workspaces[cur] and #vim.api.nvim_tabpage_list_wins(cur) == 1
      and vim.api.nvim_buf_get_name(0) == "" and not vim.bo.modified)
  if not fresh then
    local wintabs = require("cvim.wintabs")
    if wintabs.enabled() then return wintabs.new_tab(cwd) end -- one workspace per macOS tab
    vim.cmd("tabnew")
  end
  local tab = vim.api.nvim_get_current_tabpage()
  vim.cmd("tcd " .. vim.fn.fnameescape(cwd))

  local w = {
    id = string.format("%d-%04d", os.time(), math.random(0, 9999)),
    tab = tab, cwd = cwd, wins = {},
    agent = opts and opts.agent or agents.for_dir(cwd),
    avatar_buf = avatar.new_buf(),
    activity_buf = activity.new_buf(),
  }
  M.workspaces[tab] = w
  note_recent(cwd)
  state.new(w.id, agents.get(w.agent).state)
  require("cvim.pokemon").assign(w, state.ws[w.id], function()
    require("cvim.pokemon").publish(w, state.ws[w.id])
    if w.wins.avatar then vim.schedule(function() M.layout(w) end) end
    vim.cmd("redrawtabline")
  end)
  start_agent(w)
  activity.refresh_git(state.ws[w.id], cwd)
  M.layout(w)
  vim.api.nvim_set_current_win(w.wins.claude)
  vim.cmd("startinsert")
  vim.cmd("redrawtabline")
  return w
end

-- ── folders (CVIM.app) ──────────────────────────────────────────────────────
local LAST_DIR = vim.fn.fnamemodify(state.dir, ":h") .. "/last_dir"

function M.default_dir()
  local f = io.open(LAST_DIR, "r")
  local dir = f and f:read("*l")
  if f then f:close() end
  if dir and vim.fn.isdirectory(dir) == 1 then return dir end
  return vim.env.HOME
end

-- remember the folder: last_dir for the next launch, and macOS recents for the Dock menu
local RECENT = vim.fn.fnamemodify(state.dir, ":h") .. "/recent_dirs"
M.recent_file = RECENT

note_recent = function(dir)
  local f = io.open(LAST_DIR, "w")
  if f then f:write(dir); f:close(); require("cvim.private").file(LAST_DIR) end
  -- newest-first list read by the Dock menu (app/cvimdock.m)
  local list = { dir }
  local old = vim.fn.filereadable(RECENT) == 1 and vim.fn.readfile(RECENT) or {}
  for _, line in ipairs(old) do
    if line ~= dir and line ~= "" and #list < 10 then list[#list + 1] = line end
  end
  vim.fn.writefile(list, RECENT)
  require("cvim.private").file(RECENT)
end

-- folder opened via Dock/Finder (drop on the icon, "Open With", Dock recent item) or the picker
function M.open_folder(dir)
  dir = vim.fn.fnamemodify(dir, ":p"):gsub("/$", "")
  require("cvim.start").close()
  if M.pending_start then
    M.pending_start = false
    return M.new_workspace(dir, { reuse = true })
  end
  for tab, w in pairs(M.workspaces) do -- already open: just switch to it
    if w.cwd == dir then return vim.api.nvim_set_current_tabpage(tab) end
  end
  return M.new_workspace(dir)
end

-- `nvim <dir>` / `neovide -p <dir>` leave directory buffers (and tabs) behind: drop them
function M.cleanup_startup()
  local cur = vim.api.nvim_get_current_tabpage()
  for _, tab in ipairs(vim.api.nvim_list_tabpages()) do
    if tab ~= cur and not M.workspaces[tab] then
      pcall(vim.cmd, vim.api.nvim_tabpage_get_number(tab) .. "tabclose!")
    end
  end
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    local name = vim.api.nvim_buf_get_name(b)
    if name ~= "" and vim.fn.isdirectory(name) == 1 and vim.bo[b].buftype == "" then
      pcall(vim.api.nvim_buf_delete, b, { force = true })
    end
  end
end

function M.close_workspace()
  local tab = vim.api.nvim_get_current_tabpage()
  local w = M.workspaces[tab]
  if not w then return vim.cmd("tabclose") end
  if vim.fn.confirm("Close workspace " .. vim.fn.fnamemodify(w.cwd, ":t") .. " (stops " .. agents.get(w.agent).short .. ")?", "&Yes\n&No", 2) ~= 1 then
    return
  end
  for _, b in ipairs({ w.claude_buf, w.shell_buf, w.avatar_buf, w.activity_buf }) do
    if b and vim.api.nvim_buf_is_valid(b) then
      local chan = vim.bo[b].channel
      if chan and chan > 0 then pcall(vim.fn.jobstop, chan) end
    end
  end
  state.remove(w.id); require("cvim.pokemon").unpublish(w.id)
  M.workspaces[tab] = nil
  if #vim.api.nvim_list_tabpages() == 1 then return vim.cmd("qa!") end
  vim.cmd("tabclose!")
  for _, b in ipairs({ w.claude_buf, w.shell_buf, w.avatar_buf, w.activity_buf }) do
    if b and vim.api.nvim_buf_is_valid(b) then pcall(vim.api.nvim_buf_delete, b, { force = true }) end
  end
end

-- restart the workspace's agent, optionally as a different one (key from cvim.agents)
function M.restart_agent(key)
  local w = M.workspaces[vim.api.nvim_get_current_tabpage()]
  if not w then return end
  local old = w.claude_buf
  if old and vim.api.nvim_buf_is_valid(old) then
    local chan = vim.bo[old].channel
    if chan and chan > 0 then pcall(vim.fn.jobstop, chan) end
  end
  w.agent = key or w.agent
  local ws = state.ws[w.id]
  if ws then state.reset(ws, agents.get(w.agent).state) end
  start_agent(w)
  M.layout(w)
  if old and vim.api.nvim_buf_is_valid(old) then pcall(vim.api.nvim_buf_delete, old, { force = true }) end
  vim.cmd("redrawtabline")
  M.focus_claude()
end
M.restart_claude = M.restart_agent

-- ⌘G / :CvimAgent [name]: run another agent in this workspace (remembered for the folder)
function M.switch_agent(key)
  local w = M.workspaces[vim.api.nvim_get_current_tabpage()]
  if not w then return end
  local function go(k)
    if not k or k == w.agent then return end
    if not agents.bin(k) then return vim.notify("cvim: " .. k .. " 실행 파일을 찾을 수 없어요", vim.log.levels.WARN) end
    agents.remember(w.cwd, k)
    M.restart_agent(k)
  end
  if key and key ~= "" then return go(key) end
  vim.ui.select(agents.available(), {
    prompt = "에이전트 (지금: " .. agents.get(w.agent).name .. ")",
    format_item = function(k) return agents.label(k) .. (k == w.agent and "  ← 지금" or "") end,
  }, go)
end

function M.toggle_zoom()
  local w = M.workspaces[vim.api.nvim_get_current_tabpage()]
  if not w then return end
  w.zoom = not w.zoom
  M.layout(w)
end

-- ── setup ───────────────────────────────────────────────────────────────────
function M.setup()
  require("cvim.private").sweep(vim.fn.fnamemodify(state.dir, ":h")) -- S1: owner-only data
  math.randomseed(os.time())
  tabline.setup_hl()
  vim.o.showtabline = 2
  vim.o.tabline = "%!v:lua.require'cvim.tabline'.render()"

  ide.setup(M)
  require("cvim.start").setup()
  require("cvim.pokemon").setup()
  require("cvim.dex").setup()
  vim.o.title = true
  vim.o.titlestring = "%{v:lua.require'cvim'.title()}"
  require("cvim.compose").setup()
  vim.o.autoread = true

  state.start()
  state.on_change(function()
    -- Claude may have written files: reload unmodified buffers
    pcall(vim.cmd, "silent! checktime")
    for _, w in pairs(M.workspaces) do
      local ws = state.ws[w.id]
      if ws and ws.state ~= w.last_state then
        if ws.state == "done" then
          activity.refresh_git(ws, w.cwd)
          -- EXP for the partner Pokémon; republish once it has evolved
          require("cvim.pokemon").on_done(w, ws, function()
            require("cvim.pokemon").publish(w, ws)
            vim.schedule(function() M.layout(w) end) -- evolved: new size
          end)
        end
        w.last_state = ws.state
        require("cvim.pokemon").publish(w, ws)
      end
      if w.wins and w.wins.activity and vim.api.nvim_win_is_valid(w.wins.activity) then
        M.render_panels(w)
      end
    end
    vim.cmd("redrawtabline")
    vim.o.titlestring = vim.o.titlestring -- refresh the tab/window title (state emoji)
  end)

  avatar.start(function()
    local t = {}
    for _, mod in ipairs({ "cvim.start", "cvim.dex" }) do
      local st = require(mod).avatar_target()
      if st then t[#t + 1] = st end
    end
    local w = M.workspaces[vim.api.nvim_get_current_tabpage()]
    if w and w.wins.avatar and vim.api.nvim_win_is_valid(w.wins.avatar) then
      t[#t + 1] = { buf = w.avatar_buf, win = w.wins.avatar, ws = state.ws[w.id] }
    end
    return t
  end)

  local grp = vim.api.nvim_create_augroup("cvim", { clear = true })
  local pending
  vim.api.nvim_create_autocmd("VimResized", {
    group = grp,
    callback = function()
      if pending then pending:stop() end
      pending = vim.defer_fn(function()
        pending = nil
        M.layout()
        -- centered floats were placed for the old size: rebuild them
        local start, dex = require("cvim.start"), require("cvim.dex")
        if start.is_open() then start.close(true); start.open(start.startup) end
        if dex.is_open() then dex.close(true); dex.open() end
      end, 80)
    end,
  })
  -- a tab resized while hidden: re-check mode when entering it
  vim.api.nvim_create_autocmd("TabEnter", {
    group = grp,
    callback = function()
      local w = M.workspaces[vim.api.nvim_get_current_tabpage()]
      if w and w.mode ~= (w.zoom and "narrow" or mode_for(vim.o.columns)) then M.layout(w) end
    end,
  })
  vim.api.nvim_create_autocmd("TabClosed", {
    group = grp,
    callback = function()
      local alive = {}
      for _, t in ipairs(vim.api.nvim_list_tabpages()) do alive[t] = true end
      for t, w in pairs(M.workspaces) do
        if not alive[t] then state.remove(w.id); require("cvim.pokemon").unpublish(w.id); M.workspaces[t] = nil end
      end
    end,
  })
  -- a real file shown in a workspace tab becomes its editor pane
  vim.api.nvim_create_autocmd("BufWinEnter", {
    group = grp,
    callback = function(ev)
      if M._building or vim.bo[ev.buf].buftype ~= "" or vim.wo.diff then return end
      local w = M.workspaces[vim.api.nvim_get_current_tabpage()]
      if not w or vim.api.nvim_buf_get_name(ev.buf) == "" then return end
      local was_open = w.editor_open
      w.editor_buf, w.editor_open = ev.buf, true
      if not was_open then vim.schedule(function() M.layout(w) end) end
    end,
  })
  vim.api.nvim_create_autocmd("WinClosed", {
    group = grp,
    callback = function(ev)
      if M._building then return end
      local w = M.workspaces[vim.api.nvim_get_current_tabpage()]
      if w and w.wins.editor == tonumber(ev.match) then
        w.editor_open, w.wins.editor = false, nil
        vim.schedule(function() M.layout(w) end)
      end
    end,
  })
  vim.api.nvim_create_autocmd({ "BufWinEnter", "WinEnter" }, {
    group = grp,
    pattern = "term://*",
    callback = function() vim.cmd("startinsert") end,
  })
  vim.api.nvim_create_autocmd("VimLeavePre", {
    group = grp,
    callback = function()
      for _, w in pairs(M.workspaces) do state.remove(w.id); require("cvim.pokemon").unpublish(w.id) end
    end,
  })

  vim.api.nvim_create_user_command("CvimNew", function(o) M.new_workspace(o.args ~= "" and o.args or nil) end,
    { nargs = "?", complete = "dir" })
  vim.api.nvim_create_user_command("CvimClose", M.close_workspace, {})
  vim.api.nvim_create_user_command("CvimLayout", function() M.layout() end, {})
  vim.api.nvim_create_user_command("CvimRestart", function() M.restart_agent() end, {})
  vim.api.nvim_create_user_command("CvimAgent", function(o) M.switch_agent(o.args) end, {
    nargs = "?", complete = function() return agents.available() end, desc = "switch this workspace's agent" })
  vim.api.nvim_create_user_command("CvimZoom", M.toggle_zoom, {})
  vim.api.nvim_create_user_command("CvimAvatarDemo", function(o)
    local w = M.workspaces[vim.api.nvim_get_current_tabpage()]
    local ws = w and state.ws[w.id]
    if ws then ws.state, ws.since, ws.detail = o.args, os.time() + 3600, "demo" end
  end, { nargs = 1, complete = function() return require("cvim.sprites").states end })

  require("cvim.keys").setup(M)
end

return M
