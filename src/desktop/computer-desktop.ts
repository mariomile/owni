import { ComputerError, type ComputerProvider } from "../core/computer.ts";
import { DESKTOP_TOOLS, DesktopError, type DesktopProvider, type DesktopResult } from "../core/desktop.ts";

/**
 * The agente's screen in its own computer (ADR 0135): Chromium on a virtual display, in the same
 * machine as its commands, keyed like the computer. Wherever there is a computer (Docker, Fly,
 * Owni Cloud's control plane) there is a screen.
 */
export class ComputerDesktopProvider implements DesktopProvider {
	readonly kind = "remote" as const;
	readonly shared = false;

	constructor(private readonly computer: ComputerProvider) {}

	async call(key: string, tool: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<DesktopResult> {
		if (!(DESKTOP_TOOLS as readonly string[]).includes(tool)) throw new DesktopError(`lo schermo non ha lo strumento ${tool}`);
		const screen = await this.computer.screen(key, tool, args, signal).catch(refusal);
		return { text: screen.text, images: screen.image === undefined ? [] : [{ mimeType: "image/png", data: screen.image }], ...(screen.structured === undefined ? {} : { structured: screen.structured }) };
	}

	/** Chromium and the display closed; the next action opens them again. The profile, with its logins, and /work stay. */
	async reset(key: string): Promise<void> {
		await this.computer.screen(key, "restart", {}).catch(refusal);
	}

	check(): Promise<string | undefined> {
		return this.computer.check();
	}

	/** The computer's own close stops the machines, and the screens in them. */
	async close(): Promise<void> {}
}

/** What the screen refused is said to the model as the desktop's own refusal. */
function refusal(error: unknown): never {
	if (error instanceof ComputerError) throw new DesktopError(error.message);
	throw error;
}
