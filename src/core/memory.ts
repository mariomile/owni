import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, updateJsonFile } from "./locked-json.ts";
import { findHits, fold, parseQuery, termPatterns } from "./text-match.ts";

/**
 * The memoria of an instance: facts and preferences it keeps across conversations, about one
 * person (`about` = "<channel>:<userId>") or shared by everyone who talks to it (`about` = "*").
 * The person it is about can see and delete it; shared ones are the owner's, from the console.
 * A person's memories only reach the instance in a conversation with that person alone.
 */
export type Memory = {
	readonly id: string;
	readonly about: string;
	readonly text: string;
	readonly source: "owni" | "person";
	readonly createdAt: string;
	/**
	 * In the archivio (ADR 0062): kept, and found with memory_search when a conversation needs
	 * it, but not sent with every message. Details: a client's birthday, a past decision.
	 */
	readonly archived?: true;
};

export const SHARED = "*";
const MAX_TEXT = 500;
// One snapshot per store, bounded by the source size; larger archives are read without retention.
const MAX_CACHED_BYTES = 8 * 1024 * 1024;
export const MEMORY_LIMITS = {
	/** The essential ones reach the instance with each message, so the cap is also what it reads each time. */
	essential: 50,
	/** The archivio, per person (and for the shared ones): searched, never sent whole. */
	archived: 1000,
	/** What one search gives back. */
	found: 10,
} as const;

export function subjectOf(channel: string, userId: string): string {
	return `${channel}:${userId}`;
}

export class MemoryStore {
	private readonly file: string;
	private snapshot: { identity: string; memories: Memory[] } | undefined;
	constructor(instanceDir: string) {
		this.file = join(instanceDir, "memory.json");
	}

	list(): Memory[] {
		return readJsonFile<Memory[]>(this.file, []);
	}

	/** Essential memories and archive count from one snapshot, refreshed even after another process writes. */
	contextFor(subject: string): { memories: Memory[]; archived: number } {
		const own: Memory[] = [];
		const shared: Memory[] = [];
		let archived = 0;
		for (const memory of this.contextSnapshot()) {
			if (memory.about !== subject && memory.about !== SHARED) continue;
			if (memory.archived === true) archived++;
			// Copies keep callers from changing the cached snapshot.
			else (memory.about === subject ? own : shared).push({ ...memory });
		}
		return { memories: [...own, ...shared], archived };
	}

	private contextSnapshot(): Memory[] {
		const before = memoryIdentity(this.file);
		if (before !== undefined && this.snapshot?.identity === before.key) return this.snapshot.memories;
		this.snapshot = undefined;
		if (before === undefined) return [];
		const memories = this.list();
		// Do not tag a read with a replacement's identity if a writer published during the read.
		if (before.cacheable && memoryIdentity(this.file)?.key === before.key) this.snapshot = { identity: before.key, memories };
		return memories;
	}

	/** What applies to this person: their own memories, then the shared ones; the archivio too with `archived`. */
	forSubject(subject: string, archived = false): Memory[] {
		if (!archived) return this.contextFor(subject).memories;
		const all = this.list();
		return [...all.filter((m) => m.about === subject), ...all.filter((m) => m.about === SHARED && subject !== SHARED)];
	}

	/** How many of this person's memories, and of the shared ones, are in the archivio. */
	archivedFor(subject: string): number {
		return this.contextFor(subject).archived;
	}

	/**
	 * Remember a fact: essential (sent with every message) unless `archived`. When the essential
	 * ones of that person are at the cap, the oldest goes to the archivio instead of refusing.
	 */
	add(input: { about: string; text: string; source: Memory["source"]; archived?: boolean }): Memory {
		const text = input.text.trim().replace(/\s+/g, " ");
		if (text === "") throw new MemoryError("La memoria è vuota");
		if (text.length > MAX_TEXT) throw new MemoryError(`Al massimo ${MAX_TEXT} caratteri per memoria`);
		const memory: Memory = { id: randomBytes(5).toString("hex"), about: input.about, text, source: input.source, createdAt: new Date().toISOString(), ...(input.archived === true ? { archived: true as const } : {}) };
		updateJsonFile<Memory[]>(this.file, [], (all) => {
			const theirs = all.filter((m) => m.about === input.about);
			const essential = theirs.filter((m) => m.archived !== true);
			const archive = theirs.length - essential.length;
			const moving = input.archived !== true && essential.length >= MEMORY_LIMITS.essential ? essential[0] : undefined;
			if (archive + (input.archived === true || moving !== undefined ? 1 : 0) > MEMORY_LIMITS.archived) throw new MemoryError(`L'archivio è pieno (${MEMORY_LIMITS.archived} memorie): cancellane qualcuna`);
			return [...all.map((m) => (m === moving ? { ...m, archived: true as const } : m)), memory];
		});
		return memory;
	}

	/**
	 * This person's memories and the shared ones, archivio included, that hold the query's words:
	 * the ones holding more of them first, then the newest. Same words as file_search («fatture» finds «fattura»).
	 */
	search(subject: string, query: string): { found: Memory[]; more: number } {
		const terms = parseQuery(query);
		if (terms.length === 0) return { found: [], more: 0 };
		const patterns = termPatterns(terms);
		const scored = this.forSubject(subject, true)
			.map((m) => ({ m, n: new Set(findHits(fold(m.text), terms, patterns).map((h) => h.term)).size }))
			.filter((x) => x.n > 0)
			.sort((a, b) => b.n - a.n || b.m.createdAt.localeCompare(a.m.createdAt));
		return { found: scored.slice(0, MEMORY_LIMITS.found).map((x) => x.m), more: Math.max(0, scored.length - MEMORY_LIMITS.found) };
	}

	/** Delete if `may` allows it; returns the deleted memory, or undefined. */
	remove(id: string, may: (memory: Memory) => boolean): Memory | undefined {
		let removed: Memory | undefined;
		updateJsonFile<Memory[]>(this.file, [], (all) => {
			const found = all.find((m) => m.id === id);
			if (found === undefined || !may(found)) return all;
			removed = found;
			return all.filter((m) => m !== found);
		});
		return removed;
	}
}

function memoryIdentity(file: string): { key: string; cacheable: boolean } | undefined {
	try {
		const stat = statSync(file, { bigint: true });
		return { key: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`, cacheable: stat.size <= BigInt(MAX_CACHED_BYTES) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export class MemoryError extends Error {
	override readonly name = "MemoryError";
}

/** Who wrote last in each thread of an instance, so a tool knows whom a conversation is with. */
export class Participants {
	private readonly file: string;
	private cache: Record<string, string> | undefined;
	constructor(instanceDir: string) {
		this.file = join(instanceDir, "participants.json");
	}

	get(threadKey: string): string | undefined {
		this.cache ??= readJsonFile<Record<string, string>>(this.file, {});
		return this.cache[threadKey];
	}

	set(threadKey: string, subject: string): void {
		if (this.get(threadKey) === subject) return;
		this.cache = updateJsonFile<Record<string, string>>(this.file, {}, (all) => ({ ...all, [threadKey]: subject }));
	}

	/** A thread with more than one person (a group chat): nobody's memory applies there. */
	clear(threadKey: string): void {
		if (this.get(threadKey) === undefined) return;
		this.cache = updateJsonFile<Record<string, string>>(this.file, {}, ({ [threadKey]: _gone, ...rest }) => rest);
	}
}

/** Where the memory note starts in a message (the local development model cuts it off there). */
export const MEMORY_NOTE_MARKER = "\n\n[Memoria]";

/**
 * The block added after a person's message: what the instance remembers that applies to them,
 * inside one block so it stays out of their words.
 */
export function memoryNote(memories: readonly Memory[], archived = 0): string {
	if (memories.length === 0 && archived === 0) return "";
	const lines = memories.map((m) => `- ${m.text} (${m.about === SHARED ? "condivisa, " : ""}id ${m.id})`);
	const archive = archived === 0 ? "" : `\nAltre ${archived} in archivio: se la conversazione tocca qualcosa che potresti sapere (un cliente, una data, una decisione), cercale con memory_search.`;
	const remembered = lines.length === 0 && archive === "" ? "" : ` Cose che ricordi di chi ti scrive; usale solo se servono, aggiornale con memory_remember e memory_forget:${lines.length === 0 ? "" : `\n${lines.join("\n")}`}${archive}`;
	return `${MEMORY_NOTE_MARKER}${remembered}`;
}
