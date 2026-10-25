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

/** What a cell sends to reach its computers through the control plane (ADR 0015): derived from the cell's secret, never the secret itself. */
export function computerToken(cellSecret: string): string {
	return createHmac("sha256", cellSecret).update("owni-computer").digest("hex");
}
