import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ARTIFACT_LIMITS, ArtifactStore } from "../src/core/artifacts.ts";
import type { ToolContext } from "../src/core/engine.ts";
import { createArtifactTools } from "../src/core/tools/artifact-tools.ts";
import { WebChannel } from "../src/web/channel.ts";
import { tempDataDir } from "./helpers.ts";

const PERSON = "p_000000000001";
const PAGE = "<!doctype html><title>Conti</title><h1>Conti</h1>";

/** A tool call: its steps are kept, so the same context run twice is a rerun after a crash. */
function context(thread: ToolContext["thread"], callId: string): ToolContext {
	const steps = new Map<string, unknown>();
	return {
		callId,
		signal: new AbortController().signal,
		progress: () => {},
		...(thread === undefined ? {} : { thread }),
		step: async (key, work) => {
			if (!steps.has(key)) steps.set(key, await work());
			return steps.get(key) as never;
		},
	};
}

async function setup() {
	const dir = tempDataDir();
	const channel = new WebChannel({ tenantId: "acme", instanceId: "ops" }, dir);
	const thread = await channel.createThread(PERSON);
	const [create, update] = createArtifactTools({
		artifacts: () => ({
			create: (threadId, input) => channel.artifacts.create(threadId, input),
			update: (threadId, id, input) => channel.artifacts.update(threadId, id, input),
			show: (threadId, artifact, key) => channel.sendArtifact(threadId, artifact, key),
		}),
	});
	return { dir, channel, thread, create: create as NonNullable<typeof create>, update: update as NonNullable<typeof update>, web: { channel: "web", threadId: thread.id } };
}

describe("artifacts (ADR 0112)", () => {
	it("a page is made, shown in the conversation, and each change is a new version; the earlier ones stay", async () => {
		const { dir, channel, thread, create, update, web } = await setup();
		const made = String(await create.execute({ title: "Conti di ottobre", html: PAGE }, context(web, "call-1")));
		const id = /id (a_[0-9a-f]{12})/.exec(made)?.[1] as string;
		expect(made).toContain("versione 1");
		expect(made).toContain(id);
		const changed = String(await update.execute({ id, html: `${PAGE}<p>v2</p>` }, context(web, "call-2")));
		expect(changed).toContain("versione 2");
		const renamed = String(await update.execute({ id, html: `${PAGE}<p>v3</p>`, title: "Conti finali" }, context(web, "call-3")));
		expect(renamed).toContain("«Conti finali»");

		const entries = await channel.transcript(thread.id);
		expect(entries.map((e) => e.artifact)).toEqual([
			{ id, version: 1, title: "Conti di ottobre" },
			{ id, version: 2, title: "Conti di ottobre" },
			{ id, version: 3, title: "Conti finali" },
		]);
		expect((await channel.artifacts.read(thread.id, id, 1))?.toString()).toBe(PAGE);
		expect((await channel.artifacts.read(thread.id, id, 3))?.toString()).toContain("v3");
		expect(await channel.artifacts.read(thread.id, id, 4)).toBeUndefined();
		expect((await channel.artifacts.meta(thread.id, id))?.versions.map((v) => v.version)).toEqual([1, 2, 3]);
		// Where it lives, readable only by Owni.
		const at = join(dir, "web", "artifacts", thread.id, id);
		for (const file of ["meta.json", "v1.html", "v3.html"]) expect((await stat(join(at, file))).mode & 0o777).toBe(0o600);
	});

	it("a call rerun after a crash adds no version and no second message", async () => {
		const { channel, thread, create, update, web } = await setup();
		const ctx = context(web, "call-1");
		const first = String(await create.execute({ title: "Piano", html: PAGE }, ctx));
		expect(String(await create.execute({ title: "Piano", html: PAGE }, ctx))).toBe(first);
		// Even with the steps lost: the store knows the call by its key.
		const id = /id (a_[0-9a-f]{12})/.exec(first)?.[1] as string;
		await update.execute({ id, html: `${PAGE}2` }, context(web, "call-2"));
		expect(String(await update.execute({ id, html: `${PAGE}2` }, context(web, "call-2")))).toContain("versione 2");
		expect(String(await create.execute({ title: "Piano", html: PAGE }, context(web, "call-1")))).toBe(first);
		expect((await channel.transcript(thread.id)).map((e) => e.artifact?.version)).toEqual([1, 2]);
		expect((await channel.artifacts.meta(thread.id, id))?.versions).toHaveLength(2);
	});

	it("a crash between the page and the conversation's list: the rerun puts it in the list", async () => {
		const { dir, channel, thread } = await setup();
		const made = await channel.artifacts.create(thread.id, { title: "Piano", html: PAGE, key: "k1" });
		const index = join(dir, "web", "artifacts", thread.id, "index.json");
		await writeFile(index, "[]\n");
		expect(await channel.artifacts.create(thread.id, { title: "Piano", html: PAGE, key: "k1" })).toEqual(made);
		expect(JSON.parse(await readFile(index, "utf8"))).toEqual([made.id]);
	});

	it("refuses pages too big, too many versions or artifacts, an unknown id, and works only in the console", async () => {
		const { channel, thread, create, update, web } = await setup();
		const big = `<p>${"x".repeat(ARTIFACT_LIMITS.maxBytes)}</p>`;
		expect(String(await create.execute({ title: "Grande", html: big }, context(web, "big")))).toMatch(/^Errore: .*il massimo è 512 KB/);
		expect(String(await update.execute({ id: "a_000000000000", html: PAGE }, context(web, "none")))).toMatch(/^Errore: .*non c'è l'artifact a_000000000000/);
		expect(String(await create.execute({ title: "Telegram", html: PAGE }, context({ channel: "telegram", threadId: "42" }, "tg")))).toMatch(/^Errore: gli artifact si vedono solo nella console.*file_send/);
		expect(String(await create.execute({ title: "Nessuno", html: PAGE }, context(undefined, "none")))).toMatch(/^Errore: /);

		const store = channel.artifacts;
		const made = await store.create(thread.id, { title: "Versioni", html: PAGE, key: "k0" });
		for (let n = 2; n <= ARTIFACT_LIMITS.maxVersions; n++) await store.update(thread.id, made.id, { html: `${PAGE}${n}`, key: `k${n}` });
		expect(String(await update.execute({ id: made.id, html: PAGE }, context(web, "one-more")))).toMatch(new RegExp(`già ${ARTIFACT_LIMITS.maxVersions} versioni: creane uno nuovo`));
		for (let n = 1; n < ARTIFACT_LIMITS.maxPerThread; n++) await store.create(thread.id, { title: `Pagina ${n}`, html: PAGE, key: `p${n}` });
		expect(String(await create.execute({ title: "Troppe", html: PAGE }, context(web, "too-many")))).toMatch(new RegExp(`già ${ARTIFACT_LIMITS.maxPerThread} artifact`));
		// Nothing refused reached the conversation.
		expect(await channel.transcript(thread.id)).toEqual([]);
	});

	it("reads nothing outside its folders", async () => {
		const store = new ArtifactStore(tempDataDir());
		expect(await store.meta("../..", "a_000000000000")).toBeUndefined();
		expect(await store.meta("..", "a_000000000000")).toBeUndefined();
		expect(await store.meta(".", "a_000000000000")).toBeUndefined();
		await expect(store.create("..", { title: "x", html: PAGE, key: "k" })).rejects.toThrow("conversazione non valida");
		expect(await store.read(PERSON, "../meta", 1)).toBeUndefined();
		expect(await store.read(PERSON, "a_000000000000", 0)).toBeUndefined();
		await expect(store.create("../x", { title: "x", html: PAGE, key: "k" })).rejects.toThrow("conversazione non valida");
	});
});
