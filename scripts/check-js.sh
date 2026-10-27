#!/bin/sh
# Syntax check of every browser-side and desktop JS file (the console, the OpenUI frame, the cloud UI,
# the desktop connect page). The vendored minified OpenUI bundle is not ours to check.
set -e
cd "$(dirname "$0")/.."
count=0
for file in $(find src/web src/cloud/ui desktop/connect -name '*.js' -not -name '*.min.js' | sort); do
	node --check "$file"
	count=$((count + 1))
done
echo "checked $count JS files"
