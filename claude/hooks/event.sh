#!/usr/bin/env bash
# Claude Code hook -> append one compact JSON line to ~/.cache/cvim/tabs/<CVIM_TAB_ID>.log
# usage: event.sh <EventName>   (hook payload on stdin)
# No deps (no jq): pulls a few string fields out with grep. Always exits 0 so Claude is never blocked.
[ -n "${CVIM_TAB_ID:-}" ] || { cat >/dev/null; exit 0; }
umask 077 # CVIM's data is the user's alone (POLICY 11.3)
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
detail=""
# error: StopFailure's kind (rate_limit, overloaded, server_error …)
# notification_type: Notification's kind (permission_prompt / idle_prompt …) — before its message
for k in file_path notebook_path command query url pattern description notification_type message trigger error; do
  detail="$(field "$k")"
  [ -n "$detail" ] && break
done
# keep log lines small
detail="$(printf '%s' "$detail" | cut -c1-200 | sed -E 's/\\+$//')"

printf '{"event":"%s","ts":%s,"tool":"%s","detail":"%s"}\n' \
  "$1" "$(date +%s)" "$tool" "$detail" >> "$dir/$CVIM_TAB_ID.log"
exit 0
