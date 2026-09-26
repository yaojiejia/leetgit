#!/usr/bin/env bash
# Builds dist/leetgit-<version>.zip containing only the files Chrome needs.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./manifest.json').version")
mkdir -p dist
out="dist/leetgit-${version}.zip"
rm -f "$out"
zip -q -r "$out" manifest.json src options popup icons -x '*.test.js' -x '*/.DS_Store'
echo "built $out"
unzip -l "$out" | tail -n +4 | head -n -2 | awk '{print "  " $4}'
