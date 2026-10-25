#!/usr/bin/env bash
# Owni's server inside the Mac app (docs/desktop.md, «Owni sul Mac»): Node, the compiled
# server and its production packages, where tauri.local.conf.json picks them up. Run on a Mac
# from the repository root, before `pnpm tauri build --config src-tauri/tauri.local.conf.json`.
set -euo pipefail

NODE_VERSION=24.22.1
root=$(cd "$(dirname "$0")/../.." && pwd)
tauri="$root/desktop/src-tauri"
out="$tauri/server"
bin="$tauri/binaries"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

rm -rf "$out" "$bin"
mkdir -p "$out" "$bin"

# Native Computer Use is part of the same app identity; no separate installation or daemon.
bash "$root/desktop/scripts/build-computer-helper.sh"

# The server, compiled: tsx is not needed at run time.
cd "$root"
pnpm install --frozen-lockfile
pnpm exec tsc -p tsconfig.build.json --outDir "$out/dist" --sourceMap false
cp -R src/web/ui "$out/dist/web/ui"
mkdir -p "$out/evals/segreteria"
cp evals/segreteria/checks.json "$out/evals/segreteria/"
cp package.json pnpm-lock.yaml LICENSE NOTICE desktop/server-entry.mjs "$out/"
# Real folders, no links: the app bundle copies files only.
(cd "$out" && pnpm install --prod --frozen-lockfile --ignore-scripts --config.node-linker=hoisted)
find "$out/node_modules" -name .bin -type d -prune -exec rm -rf {} +
# tsx (and its native esbuild) only runs the TypeScript sources: the app runs dist/.
rm -rf "$out/node_modules/tsx" "$out/node_modules/esbuild" "$out/node_modules/@esbuild"
rm "$out/pnpm-lock.yaml"

# Node for both kinds of Mac, checked against the release's checksums.
curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
for arch in arm64 x64; do
	name="node-v$NODE_VERSION-darwin-$arch.tar.gz"
	curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$name" -o "$work/$name"
	(cd "$work" && grep " $name\$" SHASUMS256.txt | shasum -a 256 -c -)
	tar -xzf "$work/$name" -C "$work"
done
cp "$work/node-v$NODE_VERSION-darwin-arm64/bin/node" "$bin/node-aarch64-apple-darwin"
cp "$work/node-v$NODE_VERSION-darwin-x64/bin/node" "$bin/node-x86_64-apple-darwin"
lipo -create "$bin/node-aarch64-apple-darwin" "$bin/node-x86_64-apple-darwin" -output "$bin/node-universal-apple-darwin"

# The server starts with this Node and answers, as the app will start it.
data="$work/data"
port=47899
# Its stdin stays open as the app's does: at its end the server stops (server-entry.mjs).
cd "$out"
sleep 120 | OWNI_DATA_DIR="$data" OWNI_WEB_HOST=127.0.0.1 OWNI_WEB_PORT=$port OWNI_MODEL_PROVIDER=faux NODE_ENV=production \
	"$bin/node-universal-apple-darwin" server-entry.mjs > "$work/server.log" 2>&1 &
server=$!
for _ in $(seq 1 60); do
	if curl -fs "http://127.0.0.1:$port/healthz" | grep -q '"ok":true'; then
		kill "$server"
		wait "$server" || true
		test -f "$data/owner-login-link.txt"
		du -sh "$out" "$bin"
		exit 0
	fi
	sleep 1
done
cat "$work/server.log"
exit 1
