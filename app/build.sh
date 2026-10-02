#!/usr/bin/env bash
# Builds /Applications/CVIM.app as a standalone app: Neovide's binary rebranded as CVIM
# (own name, bundle id, Dock icon, recent folders), launching Neovim with the cvim config.
# Re-run after `brew upgrade neovide` or after changing the icon / sprite.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-/Applications}/CVIM.app"
NEOVIDE="/Applications/Neovide.app"
ID="dev.cvim.app"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ -x "$NEOVIDE/Contents/MacOS/neovide" ] || { echo "Neovide not found: brew install --cask neovide"; exit 1; }

# 1. bundle = copy of Neovide
pgrep -f "$OUT/Contents/MacOS/neovide" >/dev/null && { echo "CVIM is running; quit it (⌘Q) first"; exit 1; }
rm -rf "$OUT"
cp -R "$NEOVIDE" "$OUT"
rm -f "$OUT/Contents/Resources/Neovide.icns"

# 2. icon: app/icon-custom.png if present, else a generated pixel Poké Ball
if [ -f "$ROOT/app/icon-custom.png" ]; then
  mkdir -p "$WORK/CVIM.iconset"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ROOT/app/icon-custom.png" --out "$WORK/CVIM.iconset/icon_${s}x${s}.png" >/dev/null
    sips -z $((s*2)) $((s*2)) "$ROOT/app/icon-custom.png" --out "$WORK/CVIM.iconset/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$WORK/CVIM.iconset" -o "$OUT/Contents/Resources/CVIM.icns"
else
  # default: pixel Poké Ball
  python3 "$ROOT/app/make_icon.py" pokeball - "$OUT/Contents/Resources/CVIM.icns" "$WORK"
  cp "$WORK/icon.png" "$ROOT/app/icon.png"
fi

# 3. in-process extension: registers opened folders as macOS recent documents (Dock menu)
clang -dynamiclib -fobjc-arc -O2 -framework AppKit -framework CoreServices -framework QuartzCore \
  -o "$OUT/Contents/MacOS/libcvimdock.dylib" "$ROOT/app/cvimdock.m" "$ROOT/app/cvimoverlay.m" "$ROOT/app/cvimpane.m"

# 4. Info.plist: identity, folder document type, environment for Neovim
PL="$OUT/Contents/Info.plist"
PB=/usr/libexec/PlistBuddy
LOGIN_PATH="$("${SHELL:-/bin/zsh}" -lic 'printf %s "$PATH"' 2>/dev/null | tail -1)"
$PB -c "Set :CFBundleName CVIM" "$PL"
$PB -c "Add :CFBundleDisplayName string CVIM" "$PL" 2>/dev/null || $PB -c "Set :CFBundleDisplayName CVIM" "$PL"
$PB -c "Set :CFBundleIdentifier $ID" "$PL"
$PB -c "Set :CFBundleIconFile CVIM" "$PL" 2>/dev/null || $PB -c "Add :CFBundleIconFile string CVIM" "$PL"
$PB -c "Set :CFBundleShortVersionString 0.2" "$PL" 2>/dev/null || $PB -c "Add :CFBundleShortVersionString string 0.2" "$PL"
$PB -c "Delete :CFBundleDocumentTypes" "$PL" 2>/dev/null || true
$PB -c "Add :CFBundleDocumentTypes array" "$PL"
$PB -c "Add :CFBundleDocumentTypes:0 dict" "$PL"
$PB -c "Add :CFBundleDocumentTypes:0:CFBundleTypeName string Folder" "$PL"
$PB -c "Add :CFBundleDocumentTypes:0:CFBundleTypeRole string Viewer" "$PL"
$PB -c "Add :CFBundleDocumentTypes:0:LSHandlerRank string Alternate" "$PL"
$PB -c "Add :CFBundleDocumentTypes:0:LSItemContentTypes array" "$PL"
$PB -c "Add :CFBundleDocumentTypes:0:LSItemContentTypes:0 string public.folder" "$PL"
$PB -c "Delete :LSEnvironment" "$PL" 2>/dev/null || true
$PB -c "Add :LSEnvironment dict" "$PL"
$PB -c "Add :LSEnvironment:NVIM_APPNAME string cvim" "$PL"
$PB -c "Add :LSEnvironment:CVIM_ROOT string $ROOT" "$PL"
$PB -c "Add :LSEnvironment:CVIM_APP string $OUT" "$PL"
$PB -c "Add :LSEnvironment:NEOVIDE_TITLE_HIDDEN string 1" "$PL"
# macOS window tabs (iTerm2-style): every new window joins the tab bar; tabs can be dragged out
$PB -c "Add :LSEnvironment:NEOVIDE_SYSTEM_NATIVE_TABS string 1" "$PL"
# Neovide replaces the app icon at runtime with its own unless told otherwise
$PB -c "Add :LSEnvironment:NEOVIDE_ICON string $OUT/Contents/Resources/CVIM.icns" "$PL"
$PB -c "Add :LSEnvironment:PATH string $LOGIN_PATH" "$PL"
# Neovide spawns nvim through `login … zsh -c`, which loses PATH when launched from the Dock:
# give it nvim's absolute path, and let Neovim restore the full PATH (CVIM_PATH) for Claude/shells
$PB -c "Add :LSEnvironment:NEOVIM_BIN string $(command -v nvim)" "$PL"
$PB -c "Add :LSEnvironment:CVIM_PATH string $LOGIN_PATH" "$PL"
$PB -c "Add :LSEnvironment:DYLD_INSERT_LIBRARIES string $OUT/Contents/MacOS/libcvimdock.dylib" "$PL"
[ -n "${LANG:-}" ] && $PB -c "Add :LSEnvironment:LANG string $LANG" "$PL"

# recent folders are macOS-native (Dock menu, like VS Code); make sure they aren't disabled
defaults delete "$ID" NSRecentDocumentsLimit 2>/dev/null || true

# 5. sign (ad-hoc) and register with LaunchServices. The copy inherits Neovide's download
# quarantine flag; on a locally re-signed bundle Gatekeeper then silently refuses to launch it.
xattr -dr com.apple.quarantine "$OUT" 2>/dev/null || true
codesign --force --deep -s - "$OUT" >/dev/null 2>&1
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$OUT"
touch "$OUT"
echo "built $OUT"
