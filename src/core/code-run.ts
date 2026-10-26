import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ChildAnswer } from "./code-run-child.ts";
import { spreadsheetRows } from "./documents.ts";

/**
 * Python for the agente (ADR 0119): every number it gives a person comes from code that ran,
 * never from sums in its head. Pyodide runs in a Node process of its own per run, with the
 * permission model on: it reads only Pyodide and its own file (sheets become CSV here first), writes
 * nothing to disk, starts no process or worker, has no environment, no network (locked in
 * code-run-child.ts) and no code from strings. A run that takes too long is killed; memory has a
 * ceiling. At most `maxRuns` at once in the process; the others wait their turn.
 */
export const CODE_RUN_LIMITS = {
	timeoutMs: 60_000,
	maxRuns: 2,
	waitMs: 45_000,
	maxStdout: 20_000,
	maxFiles: 20,
	maxFileBytes: 20 * 1024 * 1024,
	maxInBytes: 50 * 1024 * 1024,
	maxOutBytes: 50 * 1024 * 1024,
	heapMb: 256,
	wasmMb: 512,
} as const;

export class CodeRunError extends Error {}

export type CodeFile = { readonly path: string; readonly data: Uint8Array };

export type CodeRun = {
	readonly stdout: string;
	/** stdout went past `maxStdout`: the rest was dropped. */
	readonly cut: boolean;
	/** The last lines of the Python traceback, when the code failed. */
	readonly error?: string;
	/** Files under /workspace that are new or changed. */
	readonly files: readonly CodeFile[];
	/** New or changed files over the limits, not given back. */
	readonly skipped: readonly string[];
};

const AGAIN = "Python è occupato con altro, riprova tra poco";

let running = 0;
const waiting: (() => void)[] = [];

function turn(waitMs: number): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const go = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			const at = waiting.indexOf(go);
			if (at >= 0) waiting.splice(at, 1);
			reject(new CodeRunError(AGAIN));
		}, waitMs);
		waiting.push(go);
	});
}

const here = dirname(fileURLToPath(import.meta.url));
// From source (tsx, the tests) the child is TypeScript that Node runs by stripping the types; built, it is JavaScript.
const childFile = `${here}/${import.meta.url.endsWith(".ts") ? "code-run-child.ts" : "code-run-child.js"}`;
let pyodideDir: string | undefined;

/** Runs `code` with `files` under /workspace, its working directory. */
export async function runCode(code: string, files: readonly CodeFile[], options: { timeoutMs?: number; waitMs?: number; signal?: AbortSignal } = {}): Promise<CodeRun> {
	if (files.length > CODE_RUN_LIMITS.maxFiles) throw new CodeRunError(`al massimo ${CODE_RUN_LIMITS.maxFiles} file per volta`);
	if (files.reduce((sum, f) => sum + f.data.byteLength, 0) > CODE_RUN_LIMITS.maxInBytes) throw new CodeRunError(`i file insieme superano ${CODE_RUN_LIMITS.maxInBytes / 1024 / 1024} MB`);
	if (running >= CODE_RUN_LIMITS.maxRuns) await turn(options.waitMs ?? CODE_RUN_LIMITS.waitMs);
	running++;
	try {
		const given = new Set(files.map((f) => f.path));
		const sheets = files.flatMap((f) => (/\.(xlsx|ods)$/i.test(f.path) ? sheetFiles(f) : [])).filter((s) => !given.has(s.path));
		return await inChild(code, [...files, ...sheets], options.timeoutMs ?? CODE_RUN_LIMITS.timeoutMs, options.signal);
	} finally {
		running--;
		waiting.shift()?.();
	}
}

/** A sheet of an Excel or OpenDocument file, as a CSV Python reads with csv: «vendite.xlsx» → «vendite (Foglio1).csv». */
function sheetFiles(file: CodeFile): CodeFile[] {
	const sheets = spreadsheetRows(file.path, Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength), 200_000) ?? [];
	const base = file.path.replace(/\.[^./]+$/, "");
	const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
	return sheets.map((s) => ({ path: `${base} (${s.name.replace(/[/\\]/g, "-")}).csv`, data: Buffer.from(s.rows.map((r) => r.map(cell).join(",")).join("\n"), "utf8") }));
}

function inChild(code: string, files: readonly CodeFile[], timeoutMs: number, signal?: AbortSignal): Promise<CodeRun> {
	signal?.throwIfAborted();
	pyodideDir ??= realpathSync(dirname(createRequire(import.meta.url).resolve("pyodide/package.json")));
	const child = spawn(
		process.execPath,
		[
			"--permission",
			`--allow-fs-read=${pyodideDir}`,
			`--allow-fs-read=${realpathSync(childFile)}`,
			`--max-old-space-size=${CODE_RUN_LIMITS.heapMb}`,
			`--wasm-max-mem-pages=${(CODE_RUN_LIMITS.wasmMb * 1024 * 1024) / 65_536}`,
			"--disallow-code-generation-from-strings",
			"--disable-warning=ExperimentalWarning",
			childFile,
		],
		// No environment: Owni's keys stay in Owni.
		{ stdio: ["pipe", "pipe", "ignore"], env: {}, cwd: pyodideDir },
	);
	return new Promise<CodeRun>((resolve, reject) => {
		let settled = false;
		const chunks: Buffer[] = [];
		let size = 0;
		const settle = (outcome: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			child.kill("SIGKILL");
			outcome();
		};
		const timer = setTimeout(() => settle(() => reject(new CodeRunError(`il codice è andato oltre ${Math.round(timeoutMs / 1000)} secondi ed è stato fermato`))), timeoutMs);
		const abort = () => settle(() => reject(signal?.reason));
		signal?.addEventListener("abort", abort, { once: true });
		// The answer is one line of JSON: files in base64 at most a third bigger than `maxOutBytes`.
		const most = (CODE_RUN_LIMITS.maxOutBytes * 4) / 3 + CODE_RUN_LIMITS.maxStdout * 4 + 1024 * 1024;
		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > most) settle(() => reject(new CodeRunError("il codice ha dato indietro troppi dati")));
			else chunks.push(chunk);
		});
		child.on("error", () => settle(() => reject(new CodeRunError(AGAIN))));
		child.on("close", () =>
			settle(() => {
				let answer: ChildAnswer;
				try {
					answer = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChildAnswer;
				} catch {
					// No answer: the process ran out of memory or was killed from outside.
					return reject(new CodeRunError("il codice ha usato più memoria di quella che ha a disposizione"));
				}
				if (!answer.ok) return reject(new CodeRunError(answer.error));
				resolve({ stdout: answer.stdout, cut: answer.cut, ...(answer.error === undefined ? {} : { error: answer.error }), files: answer.files.map((f) => ({ path: f.path, data: Buffer.from(f.data, "base64") })), skipped: answer.skipped });
			}),
		);
		child.stdin.on("error", () => {});
		child.stdin.end(
			JSON.stringify({
				code,
				files: files.map((f) => ({ path: f.path, data: Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength).toString("base64") })),
				pyodide: pathToFileURL(`${pyodideDir}/pyodide.mjs`).href,
				maxStdout: CODE_RUN_LIMITS.maxStdout,
				maxFiles: CODE_RUN_LIMITS.maxFiles,
				maxFileBytes: CODE_RUN_LIMITS.maxFileBytes,
				maxOutBytes: CODE_RUN_LIMITS.maxOutBytes,
			}),
		);
	});
}
