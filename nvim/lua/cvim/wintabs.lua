-- macOS native window tabs (CVIM.app on Neovide, iTerm2-style).
-- Each tab is its own Neovide window + Neovim + Claude. Neovim can't ask Neovide for a window,
-- so we post Darwin notifications that app/cvimdock.m (loaded into CVIM) turns into AppKit calls.
-- A folder for the new tab is handed over through ~/.cache/cvim/next_folder.
local M = {}

local NEXT = vim.fn.fnamemodify((vim.env.CVIM_STATE_DIR or (vim.env.HOME .. "/.cache/cvim")), ":p") .. "next_folder"

function M.enabled()
  return vim.g.neovide == true and (vim.env.CVIM_APP or "") ~= ""
end

local function post(name)
  vim.system({ "/usr/bin/notifyutil", "-p", name }, { detach = true })
end

-- new tab, optionally opening `dir` there (otherwise it shows the start screen)
function M.new_tab(dir)
  if dir then vim.fn.writefile({ dir, tostring(os.time()) }, NEXT); require("cvim.private").file(NEXT) end
  post("dev.cvim.tab.new")
end

function M.select(n) post("dev.cvim.tab." .. n) end
function M.next() post("dev.cvim.tab.next") end
function M.prev() post("dev.cvim.tab.prev") end

-- called by a freshly started tab: the folder it was opened for, if any
function M.take_pending()
  if vim.fn.filereadable(NEXT) == 0 then return nil end
  local lines = vim.fn.readfile(NEXT)
  os.remove(NEXT)
  local dir, ts = lines[1], tonumber(lines[2] or "0") or 0
  if dir and os.time() - ts < 20 and vim.fn.isdirectory(dir) == 1 then return dir end
end

return M
