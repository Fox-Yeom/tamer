-- cvim entry (NVIM_APPNAME=cvim -> ~/.config/cvim -> <repo>/nvim)

-- CVIM.app: the Dock launch path loses the login PATH; restore it for Claude, shells, git
if vim.env.CVIM_PATH and vim.env.CVIM_PATH ~= "" then vim.env.PATH = vim.env.CVIM_PATH end
-- diagnostics: `open --env CVIM_LISTEN=/tmp/cvim.sock -a CVIM` then `nvim --server /tmp/cvim.sock …`
if vim.env.CVIM_LISTEN and vim.env.CVIM_LISTEN ~= "" then pcall(vim.fn.serverstart, vim.env.CVIM_LISTEN) end
local o = vim.opt
o.termguicolors = true
o.mouse = "a"
o.number = true
o.splitright = true
o.splitbelow = true
o.laststatus = 3
o.cmdheight = 1
o.scrollback = 100000
o.updatetime = 200
o.hidden = true
o.fillchars = { eob = " ", vert = "│" }
o.clipboard = "unnamedplus"

require("cvim.theme").apply()

-- bottom hint line
vim.o.statusline = "%#CvimDim# %{mode()}  │  ⌘T new  ⌘W close  ⌘1-9 switch  ⌥hjkl pane  ⌘O open  ⌘E prompt  ⌘G agent  ⌘D 도감  ⌥z zoom  Esc Esc normal %=%f "

require("cvim.gui").setup()
local cvim = require("cvim")
cvim.setup()

vim.api.nvim_create_autocmd("VimEnter", {
  callback = function()
    local argv = vim.fn.argv()
    local handed = #argv == 0 and require("cvim.wintabs").take_pending()
    if handed then
      cvim.new_workspace(handed, { reuse = true }) -- new macOS tab opened for this folder
    elseif #argv == 0 and vim.env.CVIM_APP then
      -- launched from Finder/Dock (cwd is "/"): a folder dropped on the icon arrives as a
      -- file drop right after startup; wait for it, otherwise show the folder picker
      cvim.pending_start = true
      vim.defer_fn(function()
        if cvim.pending_start then
          cvim.pending_start = false
          require("cvim.start").open(true) -- no folder given: let the user pick one
        end
      end, 600)
    elseif #argv == 0 then
      cvim.new_workspace(vim.fn.getcwd())
    elseif #argv == 1 and vim.fn.isdirectory(argv[1]) == 1 then
      cvim.new_workspace(argv[1], { reuse = true })
      cvim.cleanup_startup()
    else
      return
    end
    -- GUIs (Neovide) resize the grid a few times right after startup; re-fit once it settles
    for _, ms in ipairs({ 300, 1000 }) do vim.defer_fn(function() cvim.layout() end, ms) end
  end,
})
