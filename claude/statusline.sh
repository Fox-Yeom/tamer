#!/usr/bin/env bash
# Claude Code statusLine: snapshot JSON for cvim tabline, then chain to the user's own statusline.
input="$(cat)"
if [ -n "${CVIM_TAB_ID:-}" ]; then
  # owner-only (POLICY 11.3), in a subshell so the user's chained statusline keeps its umask
  (
    umask 077
    dir="${CVIM_STATE_DIR:-$HOME/.cache/cvim}/tabs"
    mkdir -p "$dir"
    printf '%s' "$input" > "$dir/$CVIM_TAB_ID.status.json.tmp" \
      && mv "$dir/$CVIM_TAB_ID.status.json.tmp" "$dir/$CVIM_TAB_ID.status.json"
  )
fi
if [ -n "${CVIM_CHAIN_STATUSLINE:-}" ]; then
  printf '%s' "$input" | eval "$CVIM_CHAIN_STATUSLINE"
else
  printf 'cvim'
fi
