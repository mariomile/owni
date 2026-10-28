import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { DESKTOP_LIMITS, DESKTOP_TOOLS, DesktopError, type DesktopProvider, type DesktopResult } from "../core/desktop.ts";
import { pngSize } from "../core/png-read.ts";

export type LocalPermission = "screenRecording" | "accessibility";
export type LocalDesktopPermissions = {
	readonly kind: "local";
	readonly supported: boolean;
	readonly screenRecording: boolean;
	readonly accessibility: boolean;
	readonly problem?: string;
};

type HelperReply = {
	readonly ok?: boolean;
	readonly error?: string;
	readonly permissions?: LocalDesktopPermissions;
	readonly png?: string;
	readonly text?: string;
	readonly structured?: Record<string, unknown>;
};

/** The native app's own Mac, never a server selected through the connection form.
 * Construct only for an explicitly enabled loopback server (main/config.ts).
 * The per-agent `computer-use` connector remains the authorization boundary.
 */
export class LocalDesktopProvider implements DesktopProvider {
	readonly kind = "local" as const;
	readonly shared = true;
	private readonly helperPath: string;
	private readonly platform: NodeJS.Platform;
	private readonly timeoutMs: number;
	private tail: Promise<void> = Promise.resolve();
	private readonly children = new Set<ChildProcessWithoutNullStreams>();
	private closed = false;

	constructor(options: { readonly helperPath: string; readonly platform?: NodeJS.Platform; readonly timeoutMs?: number }) {
		this.helperPath = options.helperPath;
		this.platform = options.platform ?? process.platform;
		this.timeoutMs = options.timeoutMs ?? 15_000;
	}

	async permissions(): Promise<LocalDesktopPermissions> {
		const unavailable = this.unavailable();
		if (unavailable !== undefined) return { kind: "local", supported: false, screenRecording: false, accessibility: false, problem: unavailable };
		try {
			return this.permissionReply(await this.run({ tool: "permissions", args: {} }));
		} catch (error) {
			return { kind: "local", supported: false, screenRecording: false, accessibility: false, problem: error instanceof Error ? error.message : "Il componente Computer Use non risponde" };
		}
	}

	/** Called only by an explicit owner's Grant button. Opens Settings; never grants consent. */
	async requestPermission(kind: LocalPermission): Promise<LocalDesktopPermissions> {
		if (kind !== "screenRecording" && kind !== "accessibility") throw new DesktopError("Permesso Computer Use non valido");
		return this.permissionReply(await this.run({ tool: "request_permission", args: { kind } }));
	}

	async check(): Promise<string | undefined> {
		const status = await this.permissions();
		if (status.problem !== undefined) return status.problem;
		if (!status.screenRecording && !status.accessibility) return "Consenti Registrazione schermo e Accessibilità nelle impostazioni Computer Use";
		if (!status.screenRecording) return "Consenti Registrazione schermo nelle impostazioni Computer Use";
		if (!status.accessibility) return "Consenti Accessibilità nelle impostazioni Computer Use";
		return undefined;
	}

	async call(_key: string, tool: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<DesktopResult> {
		if (!(DESKTOP_TOOLS as readonly string[]).includes(tool)) throw new DesktopError("Operazione Computer Use non disponibile");
		const reply = await this.run({ tool, args }, signal);
		const images: DesktopResult["images"][number][] = [];
		if (tool === "get_desktop_state") {
			if (typeof reply.png !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(reply.png)) throw new DesktopError("Computer Use non ha restituito un'immagine PNG");
			const png = Buffer.from(reply.png, "base64");
			const size = pngSize(png);
			if (size === undefined || size.width < 1 || size.height < 1 || Math.max(size.width, size.height) > DESKTOP_LIMITS.maxImageDimension || png.length > DESKTOP_LIMITS.maxImageBytes) throw new DesktopError("L'immagine Computer Use supera i limiti consentiti");
			const width = Number(reply.structured?.screenshot_original_width);
			const height = Number(reply.structured?.screenshot_original_height);
			if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 32_768 || height > 32_768) throw new DesktopError("Computer Use ha restituito dimensioni dello schermo non valide");
			images.push({ mimeType: "image/png", data: png });
		}
		return { text: (reply.text ?? "").slice(0, DESKTOP_LIMITS.maxTextChars), images, ...(reply.structured === undefined ? {} : { structured: reply.structured }) };
	}

	async reset(_key: string): Promise<void> {
		throw new DesktopError("Questo è il Mac condiviso: non può essere cancellato o riavviato dall'agente");
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const child of this.children) child.kill("SIGTERM");
		await this.tail;
	}

	private unavailable(): string | undefined {
		if (this.platform !== "darwin") return "Computer Use locale è disponibile solo su macOS";
		if (!isAbsolute(this.helperPath)) return "Il componente nativo Computer Use non è configurato";
		if (this.closed) return "Computer Use è spento";
		return undefined;
	}

	private permissionReply(reply: HelperReply): LocalDesktopPermissions {
		const p = reply.permissions;
		if (p === undefined || p.kind !== "local" || typeof p.supported !== "boolean" || typeof p.screenRecording !== "boolean" || typeof p.accessibility !== "boolean") throw new DesktopError("Il componente Computer Use ha restituito permessi non validi");
		return p;
	}

	private run(request: { tool: string; args: Readonly<Record<string, unknown>> }, signal?: AbortSignal): Promise<HelperReply> {
		if (signal?.aborted === true) return Promise.reject(new DesktopError("Operazione Computer Use annullata"));
		// A single physical pointer/keyboard: each helper request finishes before the next.
		const work = this.tail.then(() => {
			const problem = this.unavailable();
			if (problem !== undefined) throw new DesktopError(problem);
			signal?.throwIfAborted();
			return this.invoke(request, signal);
		});
		this.tail = work.then(() => {}, () => {});
		if (signal === undefined) return work;
		// A cancelled request need not wait for another agent's action ahead of it. Its
		// queued slot remains in tail and checks the signal before spawning any helper.
		return new Promise((resolve, reject) => {
			const abort = () => reject(new DesktopError("Operazione Computer Use annullata"));
			signal.addEventListener("abort", abort, { once: true });
			work.then((reply) => { signal.removeEventListener("abort", abort); resolve(reply); }, (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); });
		});
	}

	private invoke(request: { tool: string; args: Readonly<Record<string, unknown>> }, signal?: AbortSignal): Promise<HelperReply> {
		return new Promise((resolve, reject) => {
			const input = JSON.stringify(request);
			if (Buffer.byteLength(input) > 32_768) return reject(new DesktopError("Richiesta Computer Use troppo grande"));
			const child = spawn(this.helperPath, [], { stdio: ["pipe", "pipe", "pipe"], shell: false, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME ?? "", LANG: "en_US.UTF-8" } });
			this.children.add(child);
			let output = "";
			let bytes = 0;
			let failure: Error | undefined;
			let force: ReturnType<typeof setTimeout> | undefined;
			const stop = (error: Error) => {
				if (failure !== undefined) return;
				failure = error;
				child.kill("SIGTERM");
				// The helper handles TERM between events and releases a held mouse/key first.
				force = setTimeout(() => child.kill("SIGKILL"), 1000);
				force.unref();
			};
			const abort = () => stop(new DesktopError("Operazione Computer Use annullata"));
			const timer = setTimeout(() => stop(new DesktopError("Computer Use non ha risposto in tempo")), this.timeoutMs);
			timer.unref();
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted === true) abort();
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (data: string) => {
				bytes += Buffer.byteLength(data);
				if (bytes > Math.ceil(DESKTOP_LIMITS.maxImageBytes * 4 / 3) + 16_384) stop(new DesktopError("Risposta Computer Use troppo grande"));
				else output += data;
			});
			// Never log native stderr: app names and screen contents belong to the local session.
			child.stderr.resume();
			child.stdin.on("error", () => {});
			child.once("error", () => { failure ??= new DesktopError("Il componente nativo Computer Use non è disponibile: ricostruisci l'app per Mac"); });
			child.once("close", (code) => {
				clearTimeout(timer);
				if (force !== undefined) clearTimeout(force);
				signal?.removeEventListener("abort", abort);
				this.children.delete(child);
				if (failure !== undefined) return reject(failure);
				let reply: HelperReply;
				try { reply = JSON.parse(output) as HelperReply; } catch { return reject(new DesktopError("Risposta del componente Computer Use non valida")); }
				if (reply === null || typeof reply !== "object") return reject(new DesktopError("Risposta del componente Computer Use non valida"));
				if (code !== 0 || reply.ok !== true) return reject(new DesktopError(typeof reply.error === "string" ? reply.error.slice(0, 500) : "Operazione Computer Use non riuscita"));
				resolve(reply);
			});
			child.stdin.end(input);
		});
	}
}
