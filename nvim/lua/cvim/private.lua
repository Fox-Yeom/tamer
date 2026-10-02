-- CVIM's data is the user's alone (POLICY 11.3, S1): folders 700, files 600 under ~/.cache/cvim.
-- Neovim's umask can't change (files you edit would follow it), so each write fixes its file.
local M = {}
local uv = vim.uv or vim.loop

function M.dir(dir)
  vim.fn.mkdir(dir, "p", tonumber("700", 8))
  uv.fs_chmod(dir, tonumber("700", 8))
end

function M.file(path)
  uv.fs_chmod(path, tonumber("600", 8))
end

-- files from before / written by other tools: group and others lose access (no symlinks followed)
function M.sweep(root)
  if vim.fn.isdirectory(root) == 1 then vim.system({ "chmod", "-R", "go-rwx", root }) end
end

return M
