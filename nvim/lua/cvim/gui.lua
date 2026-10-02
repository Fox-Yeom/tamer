-- Neovide (GUI) settings. No-op in a terminal.
local M = {}

-- Neovide 0.16 bug: when the window lands on a monitor with a different scale (e.g. external 1x
-- display -> built-in Retina 2x) it rescales the font but never recomputes the grid size, so Neovim
-- keeps a grid ~2x larger than the window and the right/bottom panes end up off-screen.
-- A font change makes Neovide recompute the grid from the real window size, so nudge guifont.
function M.refit()
  if not vim.g.neovide then return end
  local font = vim.o.guifont
  local nudged = font:gsub(":h([%d%.]+)", function(h) return ":h" .. (tonumber(h) + 0.01) end, 1)
  if nudged == font then return end
  vim.o.guifont = nudged
  vim.defer_fn(function()
    vim.o.guifont = font
    vim.defer_fn(function() require("cvim").layout() end, 120)
  end, 60)
end

function M.setup()
  if not vim.g.neovide then return end
  local g = vim.g

  -- Fira Code: its quadrant blocks (▛▜▘▝, used by Claude Code's logo) fill the whole cell.
  -- Neovide draws ▀▄█▌▐ itself but takes quadrants from the font, and Menlo's leave gaps.
  -- Falls back to Menlo if Fira Code isn't installed.
  vim.o.guifont = "Fira Code,Menlo:h14"
  g.neovide_theme = "dark"                        -- dark native title bar
  g.neovide_cursor_vfx_mode = ""
  g.neovide_input_macos_option_key_is_meta = "both" -- ⌥ = Meta: cvim ⌥hjkl/⌥z + Claude's Option shortcuts
  g.neovide_input_ime = true                      -- Korean IME
  require("cvim.ime").setup()                     -- show Hangul while composing
  require("cvim.drop").setup()                    -- Finder drag & drop -> path into Claude
  g.neovide_remember_window_size = true
  g.neovide_padding_top, g.neovide_padding_bottom = 4, 4
  g.neovide_padding_left, g.neovide_padding_right = 6, 6
  -- Claude's TUI moves the cursor a lot; keep animations short so it doesn't smear
  g.neovide_cursor_animation_length = 0.04
  g.neovide_cursor_short_animation_length = 0.02
  g.neovide_cursor_trail_size = 0.2
  g.neovide_cursor_animate_command_line = false
  g.neovide_scroll_animation_length = 0.15
  g.neovide_hide_mouse_when_typing = true

  local all = { "n", "v", "s", "x", "o", "i", "l", "c", "t" }
  local kmap = require("cvim.keys").map -- also maps the Korean-layout variant (⌘ㅍ for ⌘V, …)
  -- ⌘V: paste everywhere (in a terminal it goes to the job as a bracketed paste)
  -- ⌘V: text paste, or a clipboard image (screenshot) attached to Claude
  kmap(all, "<D-v>", function() require("cvim.drop").paste() end, { desc = "paste" })
  kmap("v", "<D-c>", function() -- copy; in a terminal pane go back to typing afterwards
    return vim.bo.buftype == "terminal" and '"+yi' or '"+y'
  end, { expr = true, desc = "copy" })
  kmap("n", "<D-a>", "ggVG", { desc = "select all" })
  -- ⌘= / ⌘- / ⌘0: zoom
  local function scale(d)
    return function() g.neovide_scale_factor = d and (g.neovide_scale_factor or 1) * d or 1 end
  end
  vim.keymap.set(all, "<D-=>", scale(1.1), { desc = "zoom in" })
  vim.keymap.set(all, "<D-->", scale(1 / 1.1), { desc = "zoom out" })
  vim.keymap.set(all, "<D-0>", scale(nil), { desc = "zoom reset" })
  kmap(all, "<D-q>", function() require("cvim.window").close() end, { desc = "quit" })

  -- re-fit after startup (window may settle on another monitor) and when focus returns
  vim.api.nvim_create_autocmd("UIEnter", {
    callback = function()
      for _, ms in ipairs({ 400, 1500 }) do vim.defer_fn(M.refit, ms) end
    end,
  })
  vim.api.nvim_create_user_command("CvimRefit", M.refit, {})
end

return M
