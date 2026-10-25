#!/usr/bin/env bash
# Apple's frameworks only: a universal helper next to Owni's executable, signed by Tauri.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
bin="$root/desktop/src-tauri/binaries"
mkdir -p "$bin"
for target in aarch64 x86_64; do
  swift_arch="$target"
  if [ "$target" = aarch64 ]; then swift_arch=arm64; fi
  xcrun swiftc -parse-as-library -swift-version 5 -O \
    -target "$swift_arch-apple-macos12.0" \
    "$root/desktop/native/computer-use.swift" \
    -o "$bin/owni-computer-use-$target-apple-darwin"
done
lipo -create "$bin/owni-computer-use-aarch64-apple-darwin" \
  "$bin/owni-computer-use-x86_64-apple-darwin" \
  -output "$bin/owni-computer-use-universal-apple-darwin"
"$bin/owni-computer-use-universal-apple-darwin" --self-test
