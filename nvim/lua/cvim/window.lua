-- Window buttons in the top bar: minimize (via kitty remote control) and close (quit cvim).
local M = {}

local function kitten()
  local p = vim.fn.exepath("kitten")
  if p ~= "" then return p end
  return "/Applications/kitty.app/Contents/MacOS/kitten"
end

function M.minimize()
  local sock = vim.env.KITTY_LISTEN_ON
  if sock and sock ~= "" then
    vim.system({ kitten(), "@", "--to", sock, "action", "--self", "minimize_macos_window" }, {}, function(r)
      if r.code ~= 0 then
        vim.schedule(function() vim.notify("cvim: minimize failed: " .. (r.stderr or ""), vim.log.levels.WARN) end)
      end
    end)
  else
    -- no kitty socket (other terminal / kitty not restarted): ask macOS directly
    vim.system({ "osascript", "-e",
      'tell application "System Events" to set miniaturized of front window of (first process whose frontmost is true) to true' })
  end
end

function M.close()
  if vim.fn.confirm("Quit CVIM? (all Claude sessions stop)", "&Quit\n&Cancel", 2) == 1 then
    vim.cmd("qa!")
  end
end

-- tabline click handlers (signature: minwid, clicks, button, mods)
_G.CvimBtnMin = function(_, _, button) if button == "l" then vim.schedule(M.minimize) end end
_G.CvimBtnClose = function(_, _, button) if button == "l" then vim.schedule(M.close) end end

function M.buttons()
  if vim.g.neovide then return "" end -- Neovide has native title bar buttons
  return "%#CvimBtn#%@v:lua.CvimBtnMin@  —  %X%#CvimBtnClose#%@v:lua.CvimBtnClose@  ✕  %X"
end

return M
