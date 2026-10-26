import { Worker } from "node:worker_threads";
import { DocumentError, type DocumentText } from "./documents.ts";
import type { Chart, ChartSpec } from "./charts.ts";
import type { MadeDocument, MakeInput } from "./make-document.ts";
import type { PdfPageImage } from "./pdf-text.ts";

/**
 * Reads a document in a worker thread (ADR 0026), so a file made to be slow or huge costs at
 * most `timeoutMs` and `memoryMb` of one worker, never the event loop that serves every tenant.
 * At most `MAX_WORKERS` at once in the process; the others wait their turn.
 */
export const DOCUMENT_READER_LIMITS = { timeoutMs: 20_000, memoryMb: 512, maxWorkers: 2, waitMs: 45_000 } as const;

const AGAIN = "non sono riuscita a leggerlo ora, riprova tra poco";

const TOO_SLOW = "il documento è troppo complesso da leggere";

/**
 * A failure that may not happen again later: no worker free, a worker lost, or the time run out
 * (on a busy server a document that reads in time when it is quiet).
 */
export function isTransient(error: unknown): boolean {
	return error instanceof DocumentError && (error.message === AGAIN || error.message === TOO_SLOW);
}

/** A read that ran out of time: the same file is likely to run out again soon. */
export function isTimeout(error: unknown): boolean {
	return error instanceof DocumentError && error.message === TOO_SLOW;
}

let running = 0;
const waiting: (() => void)[] = [];

/**
 * `waitMs`: how long to wait for a free worker before giving up with "riprova tra poco", so
 * documents from the web cannot keep a person's file waiting without end.
 */
export async function readDocumentText(name: string, data: Uint8Array, options: { timeoutMs?: number; waitMs?: number } = {}): Promise<DocumentText> {
	if (running >= DOCUMENT_READER_LIMITS.maxWorkers) await turn(options.waitMs ?? DOCUMENT_READER_LIMITS.waitMs);
	running++;
	try {
		return await inWorker<DocumentText>({ name, data }, options.timeoutMs ?? DOCUMENT_READER_LIMITS.timeoutMs, "document");
	} finally {
		running--;
		waiting.shift()?.();
	}
}

/** The picture on a page of a PDF (a scan), read in a worker like the text (ADR 0028). */
export async function readPdfPage(data: Uint8Array, page: number, options: { timeoutMs?: number; waitMs?: number } = {}): Promise<PdfPageImage> {
	if (running >= DOCUMENT_READER_LIMITS.maxWorkers) await turn(options.waitMs ?? DOCUMENT_READER_LIMITS.waitMs);
	running++;
	try {
		const image = await inWorker<PdfPageImage>({ name: "pagina.pdf", data, page }, options.timeoutMs ?? DOCUMENT_READER_LIMITS.timeoutMs, "image");
		// Transferred as Uint8Arrays: Buffers again for whoever reads them.
		return { ...image, images: image.images.map((i) => ({ ...i, data: Buffer.from(i.data.buffer, i.data.byteOffset, i.data.byteLength) })) };
	} finally {
		running--;
		waiting.shift()?.();
	}
}

/** A Word, Excel or PDF file made in a worker like the reading (ADR 0029): a huge table or picture costs one worker, not the event loop. */
export async function makeDocumentFile(input: MakeInput, options: { timeoutMs?: number; waitMs?: number } = {}): Promise<MadeDocument & { data: Buffer }> {
	if (running >= DOCUMENT_READER_LIMITS.maxWorkers) await turn(options.waitMs ?? DOCUMENT_READER_LIMITS.waitMs);
	running++;
	try {
		const made = await inWorker<MadeDocument>({ name: "documento", data: new Uint8Array(0), make: input }, options.timeoutMs ?? DOCUMENT_READER_LIMITS.timeoutMs, "made");
		return { ...made, data: Buffer.from(made.data.buffer, made.data.byteOffset, made.data.byteLength) };
	} finally {
		running--;
		waiting.shift()?.();
	}
}

/** A chart drawn in a worker (ADR 0030): the picture is a few million pixels, kept off the event loop. */
export async function makeChartFile(spec: ChartSpec, options: { timeoutMs?: number; waitMs?: number } = {}): Promise<Chart & { data: Buffer }> {
	if (running >= DOCUMENT_READER_LIMITS.maxWorkers) await turn(options.waitMs ?? DOCUMENT_READER_LIMITS.waitMs);
	running++;
	try {
		const chart = await inWorker<Chart>({ name: "grafico", data: new Uint8Array(0), chart: spec }, options.timeoutMs ?? DOCUMENT_READER_LIMITS.timeoutMs, "made");
		return { ...chart, data: Buffer.from(chart.data.buffer, chart.data.byteOffset, chart.data.byteLength) };
	} finally {
		running--;
		waiting.shift()?.();
	}
}

function turn(waitMs: number): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const go = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			const at = waiting.indexOf(go);
			if (at >= 0) waiting.splice(at, 1);
			reject(new DocumentError(AGAIN));
		}, waitMs);
		waiting.push(go);
	});
}

type WorkerInput = { name: string; data: Uint8Array; page?: number; make?: MakeInput; chart?: ChartSpec };

function inWorker<T>(input: WorkerInput, timeoutMs: number, key: "document" | "image" | "made", signal?: AbortSignal): Promise<T> {
	// From source (tsx, the tests) the worker is TypeScript that Node runs by stripping the types, so
	// its files use only erasable syntax; built, it is JavaScript.
	const source = import.meta.url.endsWith(".ts");
	const worker = new Worker(new URL(source ? "./document-worker.ts" : "./document-worker.js", import.meta.url), {
		workerData: input,
		execArgv: [],
		resourceLimits: { maxOldGenerationSizeMb: DOCUMENT_READER_LIMITS.memoryMb, maxYoungGenerationSizeMb: 64 },
		stdout: true,
		stderr: true,
	});
	// Whatever the worker prints (Node's warnings) is drained, never shown.
	worker.stdout.resume();
	worker.stderr.resume();
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const settle = (outcome: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			void worker.terminate();
			outcome();
		};
		const timer = setTimeout(() => settle(() => reject(new DocumentError(input.chart !== undefined ? "il grafico è troppo complesso da disegnare" : key === "made" ? "il documento è troppo lungo da creare" : TOO_SLOW))), timeoutMs);
		worker.on("message", (message: { document?: T; image?: T; made?: T; error?: string }) =>
			settle(() => (message[key] !== undefined ? resolve(message[key]) : reject(new DocumentError(message.error ?? "il file è rovinato")))),
		);
		// A worker that fails is our problem, not the file's: the person can try again.
		worker.on("error", (error: Error & { code?: string }) =>
			settle(() => reject(new DocumentError(error.code === "ERR_WORKER_OUT_OF_MEMORY" ? input.chart !== undefined ? "il grafico è troppo grande da disegnare" : `il documento è troppo grande da ${key === "made" ? "creare" : "leggere"}` : AGAIN))),
		);
		worker.on("exit", () => settle(() => reject(new DocumentError(AGAIN))));
		// The turn is over (the person stopped it): the worker goes at once.
		const abort = () => settle(() => reject(signal?.reason));
		signal?.addEventListener("abort", abort, { once: true });
		worker.on("exit", () => signal?.removeEventListener("abort", abort));
	});
}
