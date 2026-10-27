import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Compare two secrets (or hashes of secrets) in constant time, whatever their length. */
export function sameSecret(given: string, expected: string): boolean {
	const a = createHash("sha256").update(given).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b);
}

/** What the control plane sends with every request it forwards to a cell: derived from the cell's secret, never the secret itself. */
export function proxyToken(cellSecret: string): string {
	return createHmac("sha256", cellSecret).update("owni-proxy").digest("hex");
}

/** How long a wake credential lives: as long as the session cookie it follows. */
export const WAKE_TTL_MS = 30 * 24 * 3600 * 1000;

/** The wake credential the control plane gives a person once their cell has accepted their session: `<expiry>.<mac>`, signed with the cell's secret. */
export function wakeCredential(cellSecret: string, tenant: string, expiresAt: number): string {
	return `${expiresAt}.${createHmac("sha256", cellSecret).update(`owni-wake:${tenant}:${expiresAt}`).digest("hex")}`;
}

/** Whether a wake credential was signed by the control plane for this tenant and has not expired. */
export function wakeCredentialValid(cellSecret: string, tenant: string, value: string, now: number): boolean {
	const expiresAt = Number(/^(\d{1,15})\./.exec(value)?.[1]);
	return Number.isSafeInteger(expiresAt) && expiresAt > now && sameSecret(value, wakeCredential(cellSecret, tenant, expiresAt));
}

/** What a cell sends to reach its computers through the control plane (ADR 0015): derived from the cell's secret, never the secret itself. */
export function computerToken(cellSecret: string): string {
	return createHmac("sha256", cellSecret).update("owni-computer").digest("hex");
}
