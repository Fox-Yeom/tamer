#!/usr/bin/env bash
# Claude Code hook -> append one compact JSON line to ~/.cache/cvim/tabs/<CVIM_TAB_ID>.log
# usage: event.sh <EventName>   (hook payload on stdin)
# No deps (no jq): pulls a few string fields out with grep. Always exits 0 so Claude is never blocked.
[ -n "${CVIM_TAB_ID:-}" ] || { cat >/dev/null; exit 0; }
umask 077 # the user's data is theirs alone (POL-DATA-03)
dir="${CVIM_STATE_DIR:-$HOME/.cache/cvim}/tabs"
mkdir -p "$dir"
input="$(tr -d '\n')"

# first JSON string value for key $1 (still JSON-escaped, so safe to re-embed)
field() {
  printf '%s' "$input" \
    | grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"([^\"\\\\]|\\\\.)*\"" \
    | head -1 \
    | sed -E 's/^"[^"]*"[[:space:]]*:[[:space:]]*"//; s/"$//'
}

tool="$(field tool_name)"
# detail: only what the state needs — never file paths, commands, search terms, URLs or message text
# (POL-DATA-02, 2026-10-05):
#   notification_type  Notification's kind (permission_prompt / idle_prompt …): input needed or just idle
#   error              StopFailure's kind (rate_limit, overloaded, server_error …)
#   trigger            PreCompact's kind (manual / auto)
detail=""
for k in notification_type error trigger; do
  detail="$(field "$k")"
  [ -n "$detail" ] && break
done
# an older Claude sends no notification_type: tell "just idle" from "needs you" by its message, keep only the kind
if [ -z "$detail" ] && [ "$1" = "Notification" ]; then
  case "$(field message)" in *"waiting for your input"*) detail="idle_prompt" ;; *) detail="input" ;; esac
fi
detail="$(printf '%s' "$detail" | cut -c1-40 | tr -cd 'A-Za-z0-9_.-')"

printf '{"event":"%s","ts":%s,"tool":"%s","detail":"%s"}\n' \
  "$1" "$(date +%s)" "$tool" "$detail" >> "$dir/$CVIM_TAB_ID.log"
exit 0
