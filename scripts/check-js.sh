#!/bin/sh
# Syntax check of every browser-side and desktop JS file (the console, the OpenUI frame, the cloud UI,
# the desktop connect page). The vendored minified OpenUI bundle is not ours to check.
# Fails if a root is missing or no file is found, so a moved directory cannot turn the check into a no-op.
set -eu
cd "$(dirname "$0")/.."
roots="src/web src/cloud/ui desktop/connect"
for root in $roots; do
	[ -d "$root" ] || { echo "check-js: $root is missing" >&2; exit 1; }
done
list=$(mktemp)
trap 'rm -f "$list"' EXIT
find $roots -name '*.js' -not -name '*.min.js' | sort > "$list"
count=$(wc -l < "$list" | tr -d ' ')
[ "$count" -gt 0 ] || { echo "check-js: no JS files found" >&2; exit 1; }
while IFS= read -r file; do
	node --check "$file"
done < "$list"
echo "checked $count JS files"
