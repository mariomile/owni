import { mkdir, open, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

let counter = 0;

/**
 * Replace `file` with `data` atomically and durably: a reader sees the old content or the
 * new one, never a mix, and after this resolves the new content survives a crash (file and
 * directory entry are fsynced). `durable: false` skips the directory's fsync: after a power cut
 * the file holds the old content or the new, never a broken one, but the new may be lost. For
 * state whose loss is cosmetic (a progress line, a read marker).
 */
export async function writeFileAtomic(file: string, data: string | Uint8Array, { durable = true }: { readonly durable?: boolean } = {}): Promise<void> {
	const dir = dirname(file);
	await mkdir(dir, { recursive: true });
	const tmp = join(dir, `.${basename(file)}.${process.pid}.${counter++}.tmp`);
	const handle = await open(tmp, "w", 0o600);
	try {
		await (typeof data === "string" ? handle.writeFile(data, "utf8") : handle.writeFile(data));
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(tmp, file);
	if (!durable) return;
	const dirHandle = await open(dir, "r");
	try {
		await dirHandle.sync();
	} finally {
		await dirHandle.close();
	}
}
