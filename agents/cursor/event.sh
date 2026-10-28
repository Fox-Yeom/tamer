#!/usr/bin/env bash
# Cursor CLI hook (AGT-22), run by the launcher in ~/.cursor/hooks. Stdin is Cursor's hook JSON.
#   in a Tamer tab (CVIM_TAB_ID): one compact line in $CVIM_STATE_DIR/tabs/$CVIM_TAB_ID.log, the same lines
#     as claude/hooks/event.sh (the tool's raw name — the core maps it, state.rs tool_state)
#   elsewhere (the launcher runs this only while Tamer runs with "Tamer 밖 작업" on): a finished turn of the
#     Cursor CLI in $CACHE/outside/cursor.jsonl — when, how long, the folder (POL-DATA-02 rule 3, POL-FUT-05)
# The same ~/.cursor/hooks.json runs in the Cursor editor: called from there, nothing is written (AGT-22 rule 4).
# Never logs commands, prompts or tool output; no path in the tab log. Always answers and exits 0 (POL-AGENT-04).
umask 077 # the user's data is theirs alone (POL-DATA-03)
input="$(tr -d '\n')"

# first JSON string value for key $1 (still JSON-escaped, so safe to re-embed)
field() {
  printf '%s' "$input" \
    | grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"([^\"\\\\]|\\\\.)*\"" \
    | head -1 \
    | sed -E 's/^"[^"]*"[[:space:]]*:[[:space:]]*"//; s/"$//'
}
hook="$(field hook_event_name)"
[ -n "${1:-}" ] && hook="$1"
# Cursor records an empty answer as a failed hook: an empty one, nothing else (POL-AGENT-04 rule 3)
answer() {
  if [ "$hook" = "beforeSubmitPrompt" ]; then printf '%s\n' '{"continue":true}'; else printf '%s\n' '{}'; fi
  exit 0
}

# who ran Cursor: up the parents, the nearest of the Cursor editor (a program inside Cursor.app) and the Cursor CLI
# (a program of its cursor-agent install, one named agent / cursor-agent, or node running it) — the CLI in the
# editor's terminal is the CLI. Only the program each runs is looked at, not the words after it (a shell's
# command line can mention anything)
caller() {
  local pid="$PPID" i=0 a w
  while [ "$i" -lt 12 ] && [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null; do
    a="$(ps -o args= -p "$pid" 2>/dev/null)"
    if printf '%s' "$a" | grep -qE '^[^ ]*/Cursor\.app/'; then echo editor; return; fi
    if printf '%s' "$a" | grep -qE '^[^ ]*cursor-agent|^[^ ]*/(node|bun) [^ ]*cursor-agent'; then echo cli; return; fi
    w="${a%% *}"; w="${w##*/}"
    case "$w" in agent|cursor-agent) echo cli; return ;; esac
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    i=$((i + 1))
  done
  echo unknown
}
from="$(caller)"
[ "$from" = editor ] && answer

if [ -n "${CVIM_TAB_ID:-}" ]; then
  status="$(field status)"
  tool="$(field tool_name | cut -c1-40 | tr -cd 'A-Za-z0-9_')"
  name=""
  case "$hook" in
    sessionStart) name="SessionStart"; tool="" ;;
    beforeSubmitPrompt) name="UserPromptSubmit"; tool="" ;;
    postToolUse) name="PreToolUse" ;;
    afterFileEdit) name="PreToolUse"; tool="Edit" ;;
    afterShellExecution) name="PreToolUse"; tool="Bash" ;;
    stop)
      case "$status" in aborted) name="Interrupted" ;; error) name="StopFailure" ;; *) name="Stop" ;; esac
      tool="" ;;
  esac
  detail=""
  [ "$name" = "StopFailure" ] && detail="error"
  if [ -n "$name" ]; then
    dir="${CVIM_STATE_DIR:-$HOME/.cache/tamer}/tabs"
    mkdir -p "$dir" 2>/dev/null
    printf '{"event":"%s","ts":%s,"tool":"%s","detail":"%s"}\n' "$name" "$(date +%s)" "$tool" "$detail" >> "$dir/$CVIM_TAB_ID.log" 2>/dev/null
  fi
  answer
fi

# ── elsewhere: the Cursor CLI's finished turns only (not one we can't tell from the editor's)
[ "$from" = cli ] || answer
out="${CVIM_CACHE_DIR:-$HOME/.cache/tamer}/outside"
turns="$out/cursor-turns"
cid="$(field conversation_id | tr -cd 'A-Za-z0-9_-' | cut -c1-80)"
[ -n "$cid" ] || answer
mkdir -p "$turns" 2>/dev/null
case "$hook" in
  # a background agent's turns aren't a person's work (STA-23 rule 3)
  sessionStart) printf '%s' "$input" | grep -qE '"is_background_agent"[[:space:]]*:[[:space:]]*true' && : > "$turns/$cid.bg" ;;
  beforeSubmitPrompt) [ -f "$turns/$cid.bg" ] || date +%s > "$turns/$cid" ;;
  stop)
    if [ "$(field status)" = "completed" ] && [ ! -f "$turns/$cid.bg" ]; then
      now="$(date +%s)" start="$(head -1 "$turns/$cid" 2>/dev/null | tr -cd '0-9')"
      took="null"; [ -n "$start" ] && took="$(( (now - start) * 1000 ))"
      cwd="${CURSOR_PROJECT_DIR:-}"
      if [ -n "$cwd" ]; then
        cwd="$(printf '%s' "$cwd" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
      else # the first workspace root (still JSON-escaped)
        cwd="$(printf '%s' "$input" | grep -oE '"workspace_roots"[[:space:]]*:[[:space:]]*\[[[:space:]]*"([^"\\]|\\.)*"' | head -1 | sed -E 's/^.*\[[[:space:]]*"//; s/"$//')"
      fi
      [ -n "$cwd" ] && printf '{"ts":%s,"took":%s,"cwd":"%s"}\n' "$now" "$took" "$cwd" >> "$out/cursor.jsonl" 2>/dev/null
    fi
    rm -f "$turns/$cid" 2>/dev/null ;;
esac
answer
