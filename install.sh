#!/usr/bin/env bash
# Copies every mod in this repo (<folder>/mods/<name>/) into the Herdr app home.
# Copies, not links: Herdr does not load svg() icons or hot reload a symlinked mod.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DST="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods"

# git-panel keeps its own copy of file-icons' lookup: a mod cannot import from another mod.
for f in lookup.js icons.js; do
  cmp -s "$HERE/file-icons/mods/file-icons/$f" "$HERE/git-panel/mods/git-panel/$f" \
    || echo "  ⚠ git-panel/mods/git-panel/$f differs from file-icons: copy it again"
done

mkdir -p "$DST"
for mod in "$HERE"/*/mods/*/; do
  name="$(basename "$mod")"
  [ -L "$DST/$name" ] && rm "$DST/$name"
  rsync -a --delete --exclude gpui-kit.d.ts --exclude jsconfig.json "$mod" "$DST/$name/"
  echo "  ✓ $DST/$name ← $mod"
  if command -v herdr-app >/dev/null 2>&1; then
    herdr-app check "$DST/$name" >/dev/null 2>&1 || echo "    ⚠ herdr-app check $DST/$name failed"
  fi
done
