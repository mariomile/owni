export class BrowseError extends Error {
	override readonly name = "BrowseError";
	/** Why, for the callers that word it themselves; the message stays for the agente. */
	constructor(message: string, readonly kind?: "no-files" | "no-page" | "busy" | "unavailable" | "failed" | "held" | "denied" | "no-field") {
		super(message);
	}
}

export const ACTION_TIMEOUT_MS = 10_000;
/** Reading the page (text, elements, title, screenshot): a page that hangs it is closed. */
export const READ_TIMEOUT_MS = 5_000;

/** A page that stopped answering a read: its session is closed. */
export class Hung extends Error {}

export function within<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Hung()), ms);
	});
	return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
