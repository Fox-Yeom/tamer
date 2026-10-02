-- Finder drag & drop and clipboard images into Claude, like iTerm2.
-- Neovide calls neovide.private.dropfile(path) per dropped file (default: `:drop` = open it).
-- In a workspace we instead type the shell-escaped path into the terminal (Claude turns image
-- paths into [Image #N] attachments). Dropping onto the editor pane still opens the file.
local M = {}

-- same escaping iTerm2 uses for dropped paths: backslash before shell-special chars
function M.escape(path)
  return (path:gsub("([%s!\"#$&'()*,;<=>?%[%]\\^`{|}~])", "\\%1"))
end

local function workspace()
  return require("cvim").workspaces[vim.api.nvim_get_current_tabpage()]
end

local function term_chan(buf)
  return buf and vim.api.nvim_buf_is_valid(buf) and vim.bo[buf].channel or 0
end

-- bracketed paste so Claude/zsh treat it as pasted text, not typed keys
local function paste_to(buf, text)
  local chan = term_chan(buf)
  if chan == 0 then return false end
  vim.api.nvim_chan_send(chan, "\27[200~" .. text .. "\27[201~")
  return true
end

-- which terminal gets the drop: the focused one (Claude or shell), otherwise Claude
local function target()
  local w = workspace()
  local cur = vim.api.nvim_get_current_buf()
  if vim.bo[cur].buftype == "terminal" then return cur, w end
  return w and w.claude_buf, w
end

function M.drop(path, tabs, fallback)
  -- folders (dropped on the Dock icon, "Open With CVIM", Dock recents, or on the window):
  -- open as a workspace tab
  if vim.fn.isdirectory(path) == 1 then return require("cvim").open_folder(path) end
  local w = workspace()
  local cur = vim.api.nvim_get_current_buf()
  -- editor pane / outside a workspace: keep Neovide's default (open the file)
  if not w or (vim.bo[cur].buftype == "" and vim.api.nvim_buf_get_name(cur) ~= "") then
    return fallback(path, tabs)
  end
  local buf = target()
  if not paste_to(buf, M.escape(path) .. " ") then return fallback(path, tabs) end
  -- composer open: attach to Claude but keep writing in the composer
  if vim.b[cur].cvim_prompt then return end
  if buf == w.claude_buf and w.wins.claude and vim.api.nvim_win_is_valid(w.wins.claude) then
    vim.api.nvim_set_current_win(w.wins.claude)
  end
  vim.cmd("startinsert")
end

local function clipboard_has_image()
  local r = vim.system({ "osascript", "-e", "clipboard info" }, { text = true }):wait(1000)
  local info = r and r.stdout or ""
  return info:find("PNGf") or info:find("TIFF") or info:find("JPEG")
end

-- ⌘V: text -> paste; image only (e.g. ⌘⇧⌃4 screenshot) -> Ctrl+V so Claude attaches it
function M.paste()
  local text = vim.fn.getreg("+")
  local buf = vim.api.nvim_get_current_buf()
  if text == "" and vim.bo[buf].buftype == "terminal" and clipboard_has_image() then
    vim.api.nvim_chan_send(term_chan(buf), "\22")
    return
  end
  vim.api.nvim_paste(text, true, -1)
end

function M.setup()
  if not vim.g.neovide then return end
  local function install()
    local nv = _G.neovide
    if type(nv) ~= "table" or type(nv.private) ~= "table" or nv.private.cvim_drop then return end
    local fallback = nv.private.dropfile
    nv.private.dropfile = function(path, tabs) M.drop(path, tabs, fallback) end
    nv.private.cvim_drop = true
  end
  install()
  vim.api.nvim_create_autocmd("UIEnter", { callback = install })
end

return M
