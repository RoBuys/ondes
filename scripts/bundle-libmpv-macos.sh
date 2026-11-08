#!/usr/bin/env bash
# Prépare libmpv et ses dépendances (Homebrew, Apple Silicon) dans src-tauri/lib/macos, pour les embarquer dans l'app.
# Prérequis : brew install mpv dylibbundler
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=src-tauri/lib/macos
SRC="$(brew --prefix)/lib/libmpv.2.dylib"
[ -f "$SRC" ] || { echo "libmpv introuvable : brew install mpv" >&2; exit 1; }
rm -rf "$OUT" && mkdir -p "$OUT"
cp "$SRC" "$OUT/" && chmod u+w "$OUT/libmpv.2.dylib"
# Copie les dépendances non système et réécrit leurs liens en @loader_path (dossier de la bibliothèque).
dylibbundler -of -cd -b -x "$OUT/libmpv.2.dylib" -d "$OUT/" -p @loader_path/ >/dev/null 2>&1
install_name_tool -id @loader_path/libmpv.2.dylib "$OUT/libmpv.2.dylib" 2>/dev/null
# dylibbundler ajoute parfois plusieurs fois le même LC_RPATH, que dyld refuse (« duplicate LC_RPATH »).
for f in "$OUT"/*.dylib; do
  for rp in $(otool -l "$f" | awk '/cmd LC_RPATH/{getline; getline; print $2}' | sort | uniq -d); do
    while [ "$(otool -l "$f" | awk '/cmd LC_RPATH/{getline; getline; print $2}' | grep -cx "$rp")" -gt 1 ]; do
      install_name_tool -delete_rpath "$rp" "$f" 2>/dev/null
    done
  done
done
# Signature ad hoc (l'app désactive la validation des bibliothèques, voir Entitlements.plist).
for f in "$OUT"/*.dylib; do codesign --force --sign - "$f" >/dev/null 2>&1; done
dups=$(for f in "$OUT"/*.dylib; do otool -l "$f" | awk '/cmd LC_RPATH/{getline; getline; print $2}' | sort | uniq -d; done)
[ -z "$dups" ] || { echo "LC_RPATH en double : $dups" >&2; exit 1; }
left=$(for f in "$OUT"/*.dylib; do otool -L "$f" | tail -n +2 | grep -E "$(brew --prefix)|/usr/local" || true; done)
[ -z "$left" ] || { echo "Liens Homebrew restants :" >&2; echo "$left" >&2; exit 1; }
echo "libmpv prête : $(ls "$OUT" | wc -l | tr -d ' ') bibliothèques, $(du -sh "$OUT" | cut -f1)"
