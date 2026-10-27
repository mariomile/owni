import { createHash } from "node:crypto";
import { stat, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

/** Text worth compressing: fonts and pictures are compressed already. */
const TEXT = new Set([".js", ".css", ".html", ".svg", ".json", ".webmanifest", ".txt", ".md"]);

interface Asset {
	readonly stamp: string;
	readonly etag: string;
	readonly raw: Buffer;
	readonly br: Buffer | undefined;
}

const assets = new Map<string, Asset>();

/** The file as last read, read again only when its size or time changed. */
async function load(file: string): Promise<Asset> {
	const info = await stat(file, { bigint: true });
	const stamp = `${info.ino}:${info.size}:${info.mtimeNs}`;
	const known = assets.get(file);
	if (known?.stamp === stamp) return known;
	const raw = await readFile(file);
	const etag = `"${createHash("sha1").update(raw).digest("base64url")}"`;
	const br = TEXT.has(extname(file)) ? brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }) : undefined;
	const asset = { stamp, etag, raw, br: br !== undefined && br.length < raw.length ? br : undefined };
	assets.set(file, asset);
	return asset;
}

/** One name for these files as they are now: it changes as soon as any of them does. */
export async function versionOf(files: readonly string[]): Promise<string> {
	const hash = createHash("sha1");
	for (const file of files) hash.update((await load(file)).etag);
	return hash.digest("base64url").slice(0, 12);
}

/** A file of the interface: compressed when the browser accepts it, and a 304 when it already has this version. */
export async function sendAsset(req: IncomingMessage, res: ServerResponse, file: string, headers: Record<string, string>): Promise<void> {
	const asset = await load(file);
	const common = { ...headers, etag: asset.etag, vary: "accept-encoding" };
	if (req.headers["if-none-match"] === asset.etag) {
		res.writeHead(304, common);
		res.end();
		return;
	}
	const br = /\bbr\b/.test(String(req.headers["accept-encoding"] ?? "")) ? asset.br : undefined;
	const body = br ?? asset.raw;
	res.writeHead(200, { ...common, ...(br === undefined ? {} : { "content-encoding": "br" }), "content-length": String(body.length) });
	res.end(body);
}
