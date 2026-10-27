/** Isolated, synthetic context preparation only: pnpm exec tsx test/memory-context.bench.ts */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { readJsonFile } from "../src/core/locked-json.ts";
import { type Memory, memoryNote, MemoryStore, SHARED } from "../src/core/memory.ts";

const dir = mkdtempSync(join(tmpdir(), "owni-memory-bench-"));
const file = join(dir, "memory.json");
const subjects = Array.from({ length: 20 }, (_, i) => `test:synthetic-${i}`);
const records: Memory[] = subjects.flatMap((about, person) => Array.from({ length: 1000 }, (_, i) => ({
	id: `${person}-${i}`, about, text: `Synthetic fact ${i}: `.padEnd(190, "x"), source: "person", createdAt: "2026-01-01T00:00:00.000Z", ...(i >= 50 ? { archived: true as const } : {}),
})));

// The original runtime called these two independently: two reads/parses per request.
function baseline(subject: string): string {
	const all = readJsonFile<Memory[]>(file, []).filter((m) => m.archived !== true);
	const essential = [...all.filter((m) => m.about === subject), ...all.filter((m) => m.about === SHARED && subject !== SHARED)];
	const archived = readJsonFile<Memory[]>(file, []).filter((m) => m.archived === true && (m.about === subject || m.about === SHARED)).length;
	return memoryNote(essential, archived);
}
function prepare(store: MemoryStore, subject: string): string {
	const context = store.contextFor(subject);
	return memoryNote(context.memories, context.archived);
}
function measure(call: (subject: string) => string) {
	const durations: number[] = [];
	const originalParse = JSON.parse;
	let parses = 0;
	let outputCharacters = 0;
	JSON.parse = (text, reviver) => { parses++; return originalParse(text, reviver); };
	try {
		for (let i = 0; i < 30; i++) {
			const start = performance.now();
			outputCharacters += call(subjects[i % subjects.length]!).length;
			durations.push(performance.now() - start);
		}
	} finally { JSON.parse = originalParse; }
	const sorted = durations.toSorted((a, b) => a - b);
	return { requests: durations.length, parses, firstMs: durations[0], medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], totalMs: durations.reduce((a, b) => a + b, 0), outputCharacters };
}

try {
	writeFileSync(file, `${JSON.stringify(records, null, 2)}\n`);
	const warmup = new MemoryStore(dir);
	for (let i = 0; i < 5; i++) assert.equal(prepare(warmup, subjects[i]!), baseline(subjects[i]!));
	const before = measure(baseline);
	const store = new MemoryStore(dir);
	const after = measure((subject) => prepare(store, subject));
	assert.equal(before.outputCharacters, after.outputCharacters);
	console.log(JSON.stringify({ node: process.version, fixtureBytes: statSync(file).size, users: subjects.length, records: records.length, before, after, scope: "Includes synchronous filesystem reads/stat, parsing, filtering and memoryNote; warmed OS file cache, fresh store for measured after run. Excludes engine, model, network, and customer data." }, null, 2));
} finally { rmSync(dir, { recursive: true, force: true }); }
