#!/usr/bin/env bash
# Cursor CLI hook -> one compact JSON line in $CVIM_STATE_DIR/tabs/$CVIM_TAB_ID.log
# (same lines as claude/hooks/event.sh). Stdin is Cursor's hook JSON.
# No-op outside Tamer. Always exits 0. Never logs paths, commands, prompts, or tool output.
# stdout is a hook response. Empty stdout is recorded as a failed hook, so always print {}.
[ -n "${CVIM_TAB_ID:-}" ] || { cat >/dev/null; printf '%s\n' '{}'; exit 0; }
umask 077
dir="${CVIM_STATE_DIR:-$HOME/.cache/tamer}/tabs"
mkdir -p "$dir"
input="$(tr -d '\n')"

# first JSON string value for key $1 (still JSON-escaped, so safe to re-embed)
field() {
  printf '%s' "$input" \
    | grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"([^\"\\\\]|\\\\.)*\"" \
    | head -1 \
    | sed -E 's/^"[^"]*"[[:space:]]*:[[:space:]]*"//; s/"$//'
}

hook="$(field hook_event_name)"
[ -n "$1" ] && hook="$1"
raw="$(field tool_name)"
status="$(field status)"

# Cursor tool names -> the ones Tamer's state machine already knows
case "$raw" in
  Shell) tool="Bash" ;;
  StrReplace|EditNotebook) tool="Edit" ;;
  *) tool="$(printf '%s' "$raw" | cut -c1-40 | tr -cd 'A-Za-z0-9_')" ;;
esac

name=""
case "$hook" in
  sessionStart) name="SessionStart" ; tool="" ;;
  postToolUse) name="PreToolUse" ;;
  afterFileEdit) name="PreToolUse" ; tool="Edit" ;;
  afterShellExecution) name="PreToolUse" ; tool="Bash" ;;
  stop)
    case "$status" in
      aborted) name="Interrupted" ;;
      error) name="StopFailure" ;;
      *) name="Stop" ;;
    esac
    tool=""
    ;;
esac
detail=""
if [ "$name" = "StopFailure" ]; then detail="error"; fi
detail="$(printf '%s' "$detail" | cut -c1-40 | tr -cd 'A-Za-z0-9_.-')"
if [ -n "$name" ]; then
  printf '{"event":"%s","ts":%s,"tool":"%s","detail":"%s"}\n' \
    "$name" "$(date +%s)" "$tool" "$detail" >> "$dir/$CVIM_TAB_ID.log"
fi
printf '%s\n' '{}'
exit 0
