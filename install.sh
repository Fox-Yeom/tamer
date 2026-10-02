#!/usr/bin/env bash
# Links cvim into place. Safe to re-run; never overwrites existing non-symlink files.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

link() { # src dst
  if [ -L "$2" ] || [ ! -e "$2" ]; then
    mkdir -p "$(dirname "$2")"; ln -sfn "$1" "$2"; echo "linked $2 -> $1"
  else
    echo "skip  $2 (exists, not a symlink)"
  fi
}

command -v nvim >/dev/null || brew install neovim
[ -d /Applications/kitty.app ] || brew install --cask kitty

link "$ROOT/nvim" "$HOME/.config/cvim"
link "$ROOT/bin/cvim" "$HOME/.local/bin/cvim"

KCONF="$HOME/.config/kitty/kitty.conf"
mkdir -p "$(dirname "$KCONF")"
touch "$KCONF"
if ! grep -q "cluade-custom/kitty/cvim.conf\|$ROOT/kitty/cvim.conf" "$KCONF"; then
  printf '\n# cvim\ninclude %s\n' "$ROOT/kitty/cvim.conf" >> "$KCONF"
  echo "added include to $KCONF"
fi
echo "done. open kitty and run: cvim"
