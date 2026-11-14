#!/usr/bin/env bash
# Copies libmpv and its dependencies (Homebrew, Apple Silicon) into src-tauri/lib/macos, to bundle them into the app.
# Requirements: brew install mpv dylibbundler
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=src-tauri/lib/macos
SRC="$(brew --prefix)/lib/libmpv.2.dylib"
[ -f "$SRC" ] || { echo "libmpv not found: brew install mpv" >&2; exit 1; }
rm -rf "$OUT" && mkdir -p "$OUT"
cp "$SRC" "$OUT/" && chmod u+w "$OUT/libmpv.2.dylib"
# Copies non-system dependencies and rewrites their links to @loader_path (the library's own folder).
dylibbundler -of -cd -b -x "$OUT/libmpv.2.dylib" -d "$OUT/" -p @loader_path/ >/dev/null 2>&1
install_name_tool -id @loader_path/libmpv.2.dylib "$OUT/libmpv.2.dylib" 2>/dev/null
# dylibbundler sometimes adds the same LC_RPATH several times, which dyld rejects ("duplicate LC_RPATH").
for f in "$OUT"/*.dylib; do
  for rp in $(otool -l "$f" | awk '/cmd LC_RPATH/{getline; getline; print $2}' | sort | uniq -d); do
    while [ "$(otool -l "$f" | awk '/cmd LC_RPATH/{getline; getline; print $2}' | grep -cx "$rp")" -gt 1 ]; do
      install_name_tool -delete_rpath "$rp" "$f" 2>/dev/null
    done
  done
done
# Ad hoc signature (the app disables library validation, see Entitlements.plist).
for f in "$OUT"/*.dylib; do codesign --force --sign - "$f" >/dev/null 2>&1; done
dups=$(for f in "$OUT"/*.dylib; do otool -l "$f" | awk '/cmd LC_RPATH/{getline; getline; print $2}' | sort | uniq -d; done)
[ -z "$dups" ] || { echo "Duplicate LC_RPATH: $dups" >&2; exit 1; }
left=$(for f in "$OUT"/*.dylib; do otool -L "$f" | tail -n +2 | grep -E "$(brew --prefix)|/usr/local" || true; done)
[ -z "$left" ] || { echo "Leftover Homebrew links:" >&2; echo "$left" >&2; exit 1; }
echo "libmpv ready: $(ls "$OUT" | wc -l | tr -d ' ') libraries, $(du -sh "$OUT" | cut -f1)"
