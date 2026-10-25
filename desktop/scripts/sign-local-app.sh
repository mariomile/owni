#!/usr/bin/env bash
# Seal a completed local --no-sign bundle without replacing Node's vendor signature.
# Run after packaging and after the final resource copy, with Owni closed.
set -euo pipefail

if [ "$(uname -s)" != Darwin ] || [ "$#" -ne 1 ]; then
  echo "Usage (macOS): bash desktop/scripts/sign-local-app.sh /path/to/Owni.app" >&2
  exit 1
fi

app="$1"
# A stable Apple Development / Developer ID identity keeps TCC grants across builds.
# The ad-hoc fallback is for local testing; its cdhash changes when the code changes.
identity="${OWNI_CODESIGN_IDENTITY:--}"
identifier=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")
if [ "$identifier" != app.owni.desktop ]; then
  echo "Expected an Owni app bundle (app.owni.desktop)." >&2
  exit 1
fi
test -x "$app/Contents/MacOS/owni-desktop"
test -x "$app/Contents/MacOS/owni-computer-use"
test -x "$app/Contents/MacOS/node"

# Sign nested code first. Do not use --deep for signing: Node keeps its original signature.
codesign --verify --strict --all-architectures "$app/Contents/MacOS/node"
codesign --force --sign "$identity" --identifier app.owni.desktop.computer-use \
  "$app/Contents/MacOS/owni-computer-use"
codesign --force --sign "$identity" --identifier app.owni.desktop "$app"
codesign --verify --deep --strict --all-architectures --verbose=2 "$app"
