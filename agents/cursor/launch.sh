#!/usr/bin/env bash
# tamer-cursor-event — installed into ~/.cursor/hooks by Tamer's agent connection window.
# Outside Tamer (no CVIM_TAB_ID) this reads stdin and exits 0, writing nothing.
# Inside Tamer it runs the app's agents/cursor/event.sh (updates with the app).
[ -n "${CVIM_TAB_ID:-}" ] && [ -n "${CVIM_ROOT:-}" ] && [ -f "${CVIM_ROOT}/agents/cursor/event.sh" ] || {
  cat >/dev/null
  printf '%s\n' '{}'
  exit 0
}
exec bash "${CVIM_ROOT}/agents/cursor/event.sh"
