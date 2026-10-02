-- claudecode.nvim integration (IDE protocol over WebSocket).
-- cvim keeps managing the Claude terminals itself (provider = "none"); we only pass the
-- server port to each Claude process so `/ide` connects automatically.
local M = {}

function M.setup(cvim)
  if vim.pack then
    pcall(vim.pack.add, { "https://github.com/coder/claudecode.nvim" }, { confirm = false })
  end
  local ok, claudecode = pcall(require, "claudecode")
  if not ok then
    vim.notify("cvim: claudecode.nvim not available, IDE integration off", vim.log.levels.WARN)
    return
  end

  claudecode.setup({
    log_level = "warn",
    track_selection = true,
    terminal = { provider = "none" },
    -- our side panes are nofile buffers; a separate tab keeps diffs away from them
    diff_opts = { layout = "vertical", open_in_new_tab = true, keep_terminal_focus = false },
  })
  M.enabled = true

  -- claudecode only skips terminals whose name contains "claude"; the shell pane ("zsh") and our
  -- scratch panes would show up in Claude as "⧉ In zsh". Track real files only, so Claude keeps
  -- the last file you looked at as context.
  local sel = require("claudecode.selection")
  local update = sel.update_selection
  sel.update_selection = function(...)
    if vim.bo.buftype ~= "" then return end
    return update(...)
  end

  local map = vim.keymap.set
  map("v", "<leader>as", "<Cmd>ClaudeCodeSend<CR>", { desc = "send selection to Claude" })
  map("n", "<leader>ab", "<Cmd>ClaudeCodeAdd %<CR>", { desc = "add buffer to Claude" })
  map("n", "<leader>aa", "<Cmd>ClaudeCodeDiffAccept<CR>", { desc = "accept diff" })
  map("n", "<leader>ad", "<Cmd>ClaudeCodeDiffDeny<CR>", { desc = "deny diff" })
  map("n", "<leader>ai", "<Cmd>ClaudeCodeStatus<CR>", { desc = "IDE status" })

  local grp = vim.api.nvim_create_augroup("cvim_ide", { clear = true })
  -- provider = "none" can't focus a terminal after a send; jump to this tab's Claude pane
  vim.api.nvim_create_autocmd("User", {
    group = grp,
    pattern = "ClaudeCodeSendComplete",
    callback = function() cvim.focus_claude() end,
  })
  -- diff waiting for review -> avatar asks for attention
  vim.api.nvim_create_autocmd("User", {
    group = grp,
    pattern = "ClaudeCodeDiffOpened",
    callback = function(ev)
      cvim.mark_review(true, type(ev.data) == "table" and ev.data.file_path or nil)
    end,
  })
  vim.api.nvim_create_autocmd("User", {
    group = grp,
    pattern = "ClaudeCodeDiffClosed",
    callback = function() cvim.mark_review(false) end,
  })
end

-- env for a Claude process so it auto-connects to this Neovim
function M.env()
  if not M.enabled then return {} end
  local ok, server = pcall(require, "claudecode.server.init")
  local port = ok and server.state and server.state.port
  if not port then return {} end
  return {
    CLAUDE_CODE_SSE_PORT = tostring(port),
    ENABLE_IDE_INTEGRATION = "true",
    FORCE_CODE_TERMINAL = "true",
  }
end

return M
