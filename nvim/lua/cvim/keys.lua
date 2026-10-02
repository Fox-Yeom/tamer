-- Keymaps.
-- Cmd keys arrive as <D-…> because kitty.conf re-sends them as CSI-u (super modifier) while IS_CVIM is set.
-- Alt (<M-…>) versions work in any terminal, but only in normal mode so Claude's own Option shortcuts stay intact.
local M = {}

-- With the Korean input source active, macOS reports ⌘E as ⌘ㄷ, so Neovide sends <D-ㄷ>.
-- Map every ⌘+letter shortcut under its 2-set (두벌식) jamo as well.
local KO = {
  q = "ㅂ", w = "ㅈ", e = "ㄷ", r = "ㄱ", t = "ㅅ", y = "ㅛ", u = "ㅕ", i = "ㅑ", o = "ㅐ", p = "ㅔ",
  a = "ㅁ", s = "ㄴ", d = "ㅇ", f = "ㄹ", g = "ㅎ", h = "ㅗ", j = "ㅓ", k = "ㅏ", l = "ㅣ",
  z = "ㅋ", x = "ㅌ", c = "ㅊ", v = "ㅍ", b = "ㅠ", n = "ㅜ", m = "ㅡ",
}

function M.map(modes, lhs, rhs, opts)
  vim.keymap.set(modes, lhs, rhs, opts)
  local letter = lhs:match("^<D%-(%l)>$")
  if letter and KO[letter] then vim.keymap.set(modes, "<D-" .. KO[letter] .. ">", rhs, opts) end
end

function M.setup(cvim)
  local map = M.map
  local nt = { "n", "t" }
  local wintabs = require("cvim.wintabs")
  local function tab_go(i)
    return function()
      if wintabs.enabled() then return wintabs.select(i) end
      pcall(vim.cmd, "tabnext " .. i)
    end
  end

  -- leave terminal mode: double Esc (single Esc must reach Claude)
  map("t", "<Esc><Esc>", [[<C-\><C-n>]], { desc = "terminal -> normal" })

  -- pane navigation
  for _, d in ipairs({ "h", "j", "k", "l" }) do
    map(nt, "<M-" .. d .. ">", [[<C-\><C-n><C-w>]] .. d, { desc = "go pane " .. d })
  end

  -- workspaces (Cmd via kitty)
  map(nt, "<D-t>", function()
    if wintabs.enabled() then return wintabs.new_tab() end -- macOS tab with the start screen
    cvim.new_workspace(vim.fn.getcwd())
  end, { desc = "new workspace / tab" })
  map(nt, "<D-w>", cvim.close_workspace, { desc = "close workspace" })
  map({ "n", "t", "i" }, "<D-d>", function() require("cvim.dex").open() end, { desc = "Pokédex" })
  map({ "n", "t", "i" }, "<D-o>", function() require("cvim.start").open(false) end, { desc = "open folder" })
  map({ "n", "t", "i" }, "<D-e>", function() require("cvim.compose").toggle() end, { desc = "prompt composer" })
  map(nt, "<D-r>", function() require("cvim.gui").refit(); cvim.layout() end, { desc = "re-fit window + rebuild layout" })
  map(nt, "<D-]>", function() if wintabs.enabled() then wintabs.next() else vim.cmd("tabnext") end end, { desc = "next tab" })
  map(nt, "<D-[>", function() if wintabs.enabled() then wintabs.prev() else vim.cmd("tabprevious") end end, { desc = "prev tab" })
  for i = 1, 9 do map(nt, "<D-" .. i .. ">", tab_go(i), { desc = "workspace " .. i }) end
  -- ⌘G: run another agent here (also ⌘⇧A with the English input source). Not ⌘⇧A alone: with
  -- the Korean input source Neovide sends ⌘⇧A as <D-ㅁ> — the same key as ⌘A (select all) —
  -- because ㅁ has no shifted form. ⌘G arrives as <D-g>/<D-ㅎ> either way.
  local switch = function() cvim.switch_agent() end
  map({ "n", "t", "i", "x" }, "<D-g>", switch, { desc = "switch agent" })
  for _, lhs in ipairs({ "<D-A>", "<D-S-a>", "<D-S-A>" }) do
    vim.keymap.set({ "n", "t", "i", "x" }, lhs, switch, { desc = "switch agent" })
  end

  -- a selection in a terminal pane (⌘A, mouse drag) leaves Terminal-Normal, where typing does
  -- nothing. Ending the selection (Esc, or ⌘C in gui.lua) goes straight back to the terminal.
  vim.keymap.set("x", "<Esc>", function()
    return vim.bo.buftype == "terminal" and "<Esc>i" or "<Esc>"
  end, { expr = true, desc = "end selection (terminal: back to typing)" })
  -- iTerm-style mouse: a drag-selection in a terminal pane is copied on release and you keep
  -- typing; a plain click in a terminal pane goes back to typing too (it would leave you in
  -- Terminal-Normal otherwise)
  vim.keymap.set("x", "<LeftRelease>", function()
    return vim.bo.buftype == "terminal" and '<LeftRelease>"+yi' or "<LeftRelease>"
  end, { expr = true, desc = "copy on select (terminal)" })
  vim.keymap.set("n", "<LeftRelease>", function()
    return vim.bo.buftype == "terminal" and "<LeftRelease>i" or "<LeftRelease>"
  end, { expr = true, desc = "click in terminal: back to typing" })

  -- same in normal mode with Alt / leader
  vim.g.mapleader = " "
  map("n", "<M-t>", function() cvim.new_workspace(vim.fn.getcwd()) end)
  map("n", "<M-w>", cvim.close_workspace)
  map("n", "<M-z>", cvim.toggle_zoom, { desc = "zoom claude pane" })
  map(nt, "<M-z>", cvim.toggle_zoom)
  map("n", "<leader>n", "<Cmd>CvimNew<CR>")
  map("n", "<leader>e", "<Cmd>CvimCompose<CR>")
  map("n", "<M-e>", "<Cmd>CvimCompose<CR>")
  map("n", "<leader>r", "<Cmd>CvimRestart<CR>")
  map("n", "<leader>A", "<Cmd>CvimAgent<CR>")
  for i = 1, 9 do map("n", "<M-" .. i .. ">", tab_go(i)) end

  -- unmapped ⌘+letter in Insert / Cmdline / Terminal would be inserted literally ("<D-ㄹ>");
  -- swallow them instead. Runs last, so real mappings (incl. gui.lua's ⌘V/⌘C) are kept.
  vim.schedule(function()
    for _, mode in ipairs({ "i", "c", "t" }) do
      for letter, jamo in pairs(KO) do
        for _, lhs in ipairs({ "<D-" .. letter .. ">", "<D-" .. jamo .. ">" }) do
          if vim.fn.maparg(lhs, mode) == "" then vim.keymap.set(mode, lhs, "<Nop>") end
        end
      end
    end
  end)
end

return M
