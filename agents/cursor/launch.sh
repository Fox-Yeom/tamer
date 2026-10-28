#!/usr/bin/env bash
# tamer-cursor-event — installed into ~/.cursor/hooks by Tamer's agent connection window (AGT-22).
# Inside Tamer (CVIM_TAB_ID, CVIM_ROOT) it runs the app's agents/cursor/event.sh (updates with the app).
# Outside Tamer it does the same only while Tamer runs with "Tamer 밖 작업" on — outside/cursor.on, which
# Tamer writes (the app's folder) and removes when it quits. Otherwise it reads stdin, answers, writes nothing.
# Cursor records an empty answer as a failed hook, so it always prints one. Always exits 0.
root=""
on="${CVIM_CACHE_DIR:-$HOME/.cache/tamer}/outside/cursor.on"
if [ -n "${CVIM_TAB_ID:-}" ]; then root="${CVIM_ROOT:-}"
elif [ -f "$on" ]; then root="$(head -1 "$on" 2>/dev/null)"; fi
if [ -n "$root" ] && [ -f "$root/agents/cursor/event.sh" ]; then exec bash "$root/agents/cursor/event.sh"; fi
case "$(cat)" in
  *'"beforeSubmitPrompt"'*) printf '%s\n' '{"continue":true}' ;;
  *) printf '%s\n' '{}' ;;
esac
exit 0
