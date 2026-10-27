/** A thread's key across the engine and the runtime: its channel, then its id. */
export function threadKey(channel: string, threadId: string): string {
	return `${channel}:${threadId}`;
}

export function parseThreadKey(key: string): { channel: string; threadId: string } {
	const at = key.indexOf(":");
	return { channel: key.slice(0, at), threadId: key.slice(at + 1) };
}
