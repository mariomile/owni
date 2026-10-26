import { constants } from "node:fs";
import { spreadsheetRows } from "./documents.ts";

/**
 * One code_run (ADR 0119), in a process of its own that code-run.ts starts with Node's permission
 * model (reads only Pyodide and these files, writes nothing, no child processes, no workers) and no
 * code from strings. Node 24 has no switch for the network, so it is locked here before anything
 * the agente wrote runs. Reads its input as JSON on stdin, writes one JSON answer on stdout.
 * This file is run from source by Node: erasable TypeScript only.
 */

type FileIn = { readonly path: string; readonly data: string };
type Input = { readonly code: string; readonly files: readonly FileIn[]; readonly pyodide: string; readonly maxStdout: number; readonly maxFiles: number; readonly maxFileBytes: number; readonly maxOutBytes: number };
export type ChildAnswer =
	| { readonly ok: true; readonly stdout: string; readonly cut: boolean; readonly error?: string; readonly files: readonly FileIn[]; readonly skipped: readonly string[] }
	| { readonly ok: false; readonly error: string };

const DIR = "/workspace";
const write = process.stdout.write.bind(process.stdout);
// Pyodide's own notices are not the answer.
for (const k of ["log", "info", "warn", "error", "debug"] as const) console[k] = () => {};

function answer(value: ChildAnswer): void {
	write(`${JSON.stringify(value)}\n`, () => process.exit(0));
}

const refuse = (): never => {
	throw new Error("La rete non c'è in code_run");
};

async function lockNetwork(): Promise<void> {
	const names = ["net", "tls", "dgram", "dns", "http", "https", "http2"];
	const [net, tls, dgram, dns, http, https, http2] = (await Promise.all(names.map((m) => import(`node:${m}`)))).map((m) => m.default);
	net.Socket.prototype.connect = refuse;
	net.connect = net.createConnection = refuse;
	net.Server.prototype.listen = refuse;
	tls.connect = refuse;
	dgram.createSocket = refuse;
	dgram.Socket.prototype.bind = dgram.Socket.prototype.send = refuse;
	for (const d of [dns, dns.promises]) for (const k of Object.keys(d)) if (typeof d[k] === "function" && /^(lookup|resolve|reverse)/.test(k)) d[k] = refuse;
	for (const R of [dns.Resolver, dns.promises.Resolver]) for (const k of Object.getOwnPropertyNames(R.prototype)) if (/^(lookup|resolve|reverse)/.test(k)) R.prototype[k] = refuse;
	http.request = http.get = https.request = https.get = http2.connect = refuse;
	for (const k of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"]) Reflect.deleteProperty(globalThis, k);
	(await import("node:module")).syncBuiltinESMExports();
}

/** A sheet of an Excel or OpenDocument file, as a CSV Python reads with csv: «vendite.xlsx» → «vendite (Foglio1).csv». */
function sheetFiles(file: FileIn, bytes: Buffer): FileIn[] {
	const sheets = spreadsheetRows(file.path, bytes, 200_000) ?? [];
	const base = file.path.replace(/\.[^./]+$/, "");
	const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
	return sheets.map((s) => ({ path: `${base} (${s.name.replace(/[/\\]/g, "-")}).csv`, data: Buffer.from(s.rows.map((r) => r.map(cell).join(",")).join("\n"), "utf8").toString("base64") }));
}

async function main(): Promise<void> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Input;

	await lockNetwork();
	// The permission model refuses process.binding; Pyodide asks it only for the fs constants.
	Object.assign(process, { binding: (name: string) => (name === "constants" ? { fs: constants } : refuse()) });
	const { loadPyodide } = (await import(input.pyodide)) as typeof import("pyodide");
	let stdout = "";
	let cut = false;
	const out = (text: string) => {
		if (stdout.length + text.length + 1 > input.maxStdout) cut = true;
		else stdout += `${text}\n`;
	};
	const py = await loadPyodide({ jsglobals: {}, stdout: out, stderr: out, env: { HOME: DIR } });
	// What Pyodide needed to start, gone before the agente's code runs.
	Reflect.deleteProperty(globalThis, "require");
	for (const k of ["getBuiltinModule", "binding", "_linkedBinding", "dlopen"]) Reflect.deleteProperty(process, k);

	const before = new Map<string, string>();
	const put = (file: FileIn) => {
		const at = `${DIR}/${file.path}`;
		py.FS.mkdirTree(at.slice(0, at.lastIndexOf("/")));
		py.FS.writeFile(at, Buffer.from(file.data, "base64"));
		before.set(file.path, file.data);
	};
	py.FS.mkdirTree(DIR);
	for (const file of input.files) {
		const bytes = Buffer.from(file.data, "base64");
		put(file);
		if (/\.(xlsx|ods)$/i.test(file.path)) for (const sheet of sheetFiles(file, bytes)) if (!before.has(sheet.path)) put(sheet);
	}
	py.FS.chdir(DIR);

	let error: string | undefined;
	try {
		await py.runPythonAsync(input.code);
	} catch (e) {
		// The traceback from the agente's own code on, without Pyodide's frames before it.
		const lines = (e instanceof Error ? e.message : String(e)).trimEnd().split("\n");
		const own = lines.findIndex((l) => l.includes('File "<exec>"'));
		error = (own > 0 ? ["Traceback (most recent call last):", ...lines.slice(own)] : lines).join("\n").slice(-3000);
	}

	// New or changed files under /workspace go back; the rest stays here.
	const files: FileIn[] = [];
	const skipped: string[] = [];
	let total = 0;
	const walk = (dir: string, rel: string) => {
		for (const name of py.FS.readdir(dir) as string[]) {
			if (name === "." || name === "..") continue;
			const at = `${dir}/${name}`;
			const path = rel ? `${rel}/${name}` : name;
			const mode = py.FS.stat(at).mode;
			if (py.FS.isDir(mode)) walk(at, path);
			else if (py.FS.isFile(mode)) {
				const data = Buffer.from(py.FS.readFile(at) as Uint8Array);
				const encoded = data.toString("base64");
				if (before.get(path) === encoded) continue;
				if (files.length >= input.maxFiles || data.length > input.maxFileBytes || total + data.length > input.maxOutBytes) skipped.push(path);
				else {
					total += data.length;
					files.push({ path, data: encoded });
				}
			}
		}
	};
	walk(DIR, "");
	answer({ ok: true, stdout, cut, ...(error === undefined ? {} : { error }), files, skipped });
}

main().catch((e: unknown) => answer({ ok: false, error: e instanceof Error ? e.message : String(e) }));
