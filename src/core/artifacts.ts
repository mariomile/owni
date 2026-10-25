import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-file.ts";

/** What one artifact may hold (ADR 0112). */
export const ARTIFACT_LIMITS = {
	/** The largest page, in bytes of UTF-8. */
	maxBytes: 512 * 1024,
	/** Versions kept of one artifact: after these, the agent makes a new one. */
	maxVersions: 30,
	/** Artifacts of one conversation. */
	maxPerThread: 50,
	maxTitle: 80,
} as const;

/** A page of a conversation, as an entry of its transcript points to it. */
export type ArtifactRef = { readonly id: string; readonly version: number; readonly title: string };

export type ArtifactVersion = { readonly version: number; readonly at: string; readonly bytes: number; readonly title: string; readonly key: string };
export type ArtifactMeta = { readonly id: string; readonly threadId: string; readonly createdAt: string; readonly versions: readonly ArtifactVersion[] };

/** A page the store refuses, said to the model. */
export class ArtifactError extends Error {}

const ARTIFACT_ID = /^a_[0-9a-f]{12}$/;
/** A thread id is a single path segment: dots only between other characters, so never `.` or `..`. */
const THREAD = /^(?=.{1,80}$)[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

/**
 * The HTML pages an agente makes in its conversations (ADR 0112): one folder per thread, one per
 * artifact, with `meta.json` and a `v<n>.html` per version, all 0600. A save carries the tool
 * call's key, so a call rerun after a crash finds its page instead of adding a version.
 */
export class ArtifactStore {
	private readonly writing = new Map<string, Promise<unknown>>();

	constructor(private readonly dir: string) {}

	static isId(id: string): boolean {
		return ARTIFACT_ID.test(id);
	}

	/** A new artifact, at version 1. */
	create(threadId: string, input: { readonly title: string; readonly html: string; readonly key: string }): Promise<ArtifactRef> {
		const id = `a_${createHash("sha256").update(`${threadId}:${input.key}`).digest("hex").slice(0, 12)}`;
		return this.serial(threadId, async () => {
			const meta = await this.meta(threadId, id);
			const ids = await this.ids(threadId);
			if (meta !== undefined) {
				// A rerun after a crash between the page and the list: the list catches up.
				if (!ids.includes(id)) await this.list(threadId, [...ids, id]);
				return ref(meta, meta.versions[0] as ArtifactVersion);
			}
			const { title, html } = checked(input.title, input.html);
			if (ids.length >= ARTIFACT_LIMITS.maxPerThread) throw new ArtifactError(`questa conversazione ha già ${ARTIFACT_LIMITS.maxPerThread} artifact: aggiorna uno di quelli che ci sono`);
			const at = new Date().toISOString();
			const version: ArtifactVersion = { version: 1, at, bytes: Buffer.byteLength(html), title, key: input.key };
			await this.write(threadId, { id, threadId, createdAt: at, versions: [version] }, html);
			await this.list(threadId, [...ids, id]);
			return ref({ id }, version);
		});
	}

	/** The next version of an artifact of the thread: the whole page again, not a diff. */
	update(threadId: string, id: string, input: { readonly title?: string; readonly html: string; readonly key: string }): Promise<ArtifactRef> {
		return this.serial(threadId, async () => {
			const meta = await this.meta(threadId, id);
			if (meta === undefined) throw new ArtifactError(`in questa conversazione non c'è l'artifact ${id}`);
			const done = meta.versions.find((v) => v.key === input.key);
			if (done !== undefined) return ref(meta, done);
			const last = meta.versions[meta.versions.length - 1] as ArtifactVersion;
			if (meta.versions.length >= ARTIFACT_LIMITS.maxVersions) throw new ArtifactError(`${id} ha già ${ARTIFACT_LIMITS.maxVersions} versioni: creane uno nuovo con artifact_create`);
			const { title, html } = checked(input.title ?? last.title, input.html);
			const version: ArtifactVersion = { version: last.version + 1, at: new Date().toISOString(), bytes: Buffer.byteLength(html), title, key: input.key };
			await this.write(threadId, { ...meta, versions: [...meta.versions, version] }, html);
			return ref(meta, version);
		});
	}

	async meta(threadId: string, id: string): Promise<ArtifactMeta | undefined> {
		if (!THREAD.test(threadId) || !ARTIFACT_ID.test(id)) return undefined;
		const text = await readOrUndefined(join(this.dir, threadId, id, "meta.json"));
		return text === undefined ? undefined : (JSON.parse(text.toString("utf8")) as ArtifactMeta);
	}

	/** Every artifact of a thread, in the order they were made. */
	async all(threadId: string): Promise<ArtifactMeta[]> {
		if (!THREAD.test(threadId)) return [];
		const out: ArtifactMeta[] = [];
		for (const id of await this.ids(threadId)) {
			const meta = await this.meta(threadId, id);
			if (meta !== undefined) out.push(meta);
		}
		return out;
	}

	/** The page of one version, or undefined when there is none. */
	async read(threadId: string, id: string, version: number): Promise<Buffer | undefined> {
		if (!THREAD.test(threadId) || !ARTIFACT_ID.test(id) || !Number.isInteger(version) || version < 1) return undefined;
		return readOrUndefined(join(this.dir, threadId, id, `v${version}.html`));
	}

	private async write(threadId: string, meta: ArtifactMeta, html: string): Promise<void> {
		const at = join(this.dir, threadId, meta.id);
		const last = meta.versions[meta.versions.length - 1] as ArtifactVersion;
		// The page first: a meta.json never names a version that is not on disk.
		await writeFileAtomic(join(at, `v${last.version}.html`), html);
		await writeFileAtomic(join(at, "meta.json"), `${JSON.stringify(meta)}\n`);
	}

	private async ids(threadId: string): Promise<string[]> {
		const text = await readOrUndefined(join(this.dir, threadId, "index.json"));
		return text === undefined ? [] : (JSON.parse(text.toString("utf8")) as string[]);
	}

	private list(threadId: string, ids: readonly string[]): Promise<void> {
		return writeFileAtomic(join(this.dir, threadId, "index.json"), `${JSON.stringify(ids)}\n`);
	}

	/** Saves of one thread go one at a time, in this process. */
	private serial<T>(threadId: string, work: () => Promise<T>): Promise<T> {
		if (!THREAD.test(threadId)) return Promise.reject(new ArtifactError("conversazione non valida"));
		const next = (this.writing.get(threadId) ?? Promise.resolve()).catch(() => {}).then(work);
		const settled = next.catch(() => {});
		this.writing.set(threadId, settled);
		void settled.then(() => {
			if (this.writing.get(threadId) === settled) this.writing.delete(threadId);
		});
		return next;
	}
}

function ref(meta: { readonly id: string }, version: ArtifactVersion): ArtifactRef {
	return { id: meta.id, version: version.version, title: version.title };
}

function checked(titleIn: string, html: string): { title: string; html: string } {
	const title = titleIn.trim().replace(/\s+/g, " ").slice(0, ARTIFACT_LIMITS.maxTitle);
	if (title === "") throw new ArtifactError("serve un titolo");
	if (html.trim() === "") throw new ArtifactError("la pagina è vuota");
	const bytes = Buffer.byteLength(html);
	if (bytes > ARTIFACT_LIMITS.maxBytes) throw new ArtifactError(`la pagina è di ${Math.ceil(bytes / 1024)} KB, il massimo è ${ARTIFACT_LIMITS.maxBytes / 1024} KB: togli i dati incorporati o le immagini in base64`);
	return { title, html };
}

async function readOrUndefined(file: string): Promise<Buffer | undefined> {
	try {
		return await readFile(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
