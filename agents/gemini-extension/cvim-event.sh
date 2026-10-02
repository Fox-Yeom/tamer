#!/usr/bin/env bash
# Gemini CLI hook → CVIM (same one-line log as Claude's hooks). Only inside CVIM (CVIM_TAB_ID set
# by the CVIM app); anywhere else it reads its input and exits. Prints nothing (no model context).
[ -n "${CVIM_TAB_ID:-}" ] || { cat >/dev/null; exit 0; }
event="$(cd "$(dirname "$0")/../.." && pwd)/claude/hooks/event.sh"
if [ "$1" = "PreCompact" ]; then
  # Gemini fires PreCompress(auto) at the start of every turn, before it checks whether the history
  # is big enough to compress (ChatCompressionService.compress) — so "auto" says nothing. Only
  # /compress (manual) really compresses.
  input="$(cat)"
  case "$input" in *'"trigger":"auto"'* | *'"trigger": "auto"'*) exit 0 ;; esac
  printf "%s" "$input" | bash "$event" "$1"; exit 0
fi
exec bash "$event" "$1"
