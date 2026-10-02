-- cvim colors. Tweak UI colors here.
-- Neovide has no terminal palette of its own, so Normal fg and the 16 terminal colors
-- must be set explicitly or Claude's text falls back to black.
local M = {}

M.c = {
  bg = "#16161c", bg_alt = "#1f1f27", bg_sel = "#2c2c38",
  fg = "#e6e6e6", fg_dim = "#8a8a8a", border = "#3a3a40",
  accent = "#D97757",
}

-- ANSI 0-15: black red green yellow blue magenta cyan white, then bright variants
M.terminal = {
  "#2a2a32", "#e5484d", "#3ddc84", "#f5c542", "#7cc4f2", "#c792ea", "#5fd7d7", "#d0d0d0",
  "#5c5c68", "#ff6b70", "#6ef0a4", "#ffd866", "#9fd6ff", "#dcb0ff", "#8ff0f0", "#ffffff",
}

function M.apply()
  local c = M.c
  vim.o.background = "dark"
  vim.cmd.colorscheme("default")
  local set = vim.api.nvim_set_hl
  set(0, "Normal", { fg = c.fg, bg = c.bg })
  set(0, "NormalNC", { fg = c.fg, bg = c.bg })
  set(0, "NormalFloat", { fg = c.fg, bg = c.bg_alt })
  set(0, "FloatBorder", { fg = c.border, bg = c.bg_alt })
  set(0, "WinSeparator", { fg = c.border })
  set(0, "WinBar", { fg = c.fg, bg = c.bg })
  set(0, "WinBarNC", { fg = c.fg_dim, bg = c.bg })
  set(0, "StatusLine", { fg = c.fg_dim, bg = c.bg_alt })
  set(0, "StatusLineNC", { fg = c.fg_dim, bg = c.bg_alt })
  set(0, "Pmenu", { fg = c.fg, bg = c.bg_alt })
  set(0, "PmenuSel", { fg = c.bg, bg = c.accent, bold = true })
  set(0, "Visual", { bg = c.bg_sel })
  set(0, "CursorLine", { bg = c.bg_alt })
  set(0, "LineNr", { fg = "#4a4a55" })
  set(0, "CursorLineNr", { fg = c.accent, bold = true })
  set(0, "Cursor", { fg = c.bg, bg = c.accent })
  set(0, "TermCursor", { fg = c.bg, bg = c.accent })
  for i, col in ipairs(M.terminal) do vim.g["terminal_color_" .. (i - 1)] = col end
end

return M
