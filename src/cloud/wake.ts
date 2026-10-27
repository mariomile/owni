import { createHmac } from "node:crypto";
import { RollingLimit } from "../core/rolling-limit.ts";
import { cookieAttributes, SESSION_COOKIE, SESSION_TTL_S } from "../web/auth.ts";
import { sameSecret } from "../web/compare.ts";
import { HOOK_ROUTES } from "../web/hooks.ts";

/**
 * When a stopped cell may be woken (ADR 0128): for its people, by a wake credential this control
 * plane signed after the cell accepted their session, and for the webhook addresses the cell
 * serves. An anonymous request does not wake it, or anyone could keep any cell running.
 */

export const WAKE_COOKIE = "owni_wake";
/** How long a wake credential lives: as long as the session cookie it follows. */
export const WAKE_TTL_MS = SESSION_TTL_S * 1000;
/** Wakes by webhook paths per tenant in a window: anyone can send one, and starting a cell costs money. */
export const WAKE_WINDOW_MS = 10 * 60 * 1000;
export const wakeBudget = () => new RollingLimit(6, WAKE_WINDOW_MS);

/** A wake credential: `<expiry>.<mac>`, signed with the cell's secret. */
export function wakeCredential(cellSecret: string, tenant: string, expiresAt: number): string {
	return `${expiresAt}.${createHmac("sha256", cellSecret).update(`owni-wake:${tenant}:${expiresAt}`).digest("hex")}`;
}

/** Whether a wake credential was signed by the control plane for this tenant and has not expired. */
export function wakeCredentialValid(cellSecret: string, tenant: string, value: string, now: number): boolean {
	const expiresAt = Number(/^(\d{1,15})\./.exec(value)?.[1]);
	return Number.isSafeInteger(expiresAt) && expiresAt > now && sameSecret(value, wakeCredential(cellSecret, tenant, expiresAt));
}

const CREDENTIALS = new RegExp(`(?:^|;\\s*)${WAKE_COOKIE}=([\\w.]+)`, "g");

/** What may wake a stopped cell for this request: a person's credential, a webhook the cell serves (path and method), or nothing. */
export function wakeKind(cookieHeader: string, method: string, pathname: string, tenant: string, secret: string, now: number): "credential" | "webhook" | undefined {
	// Any valid one among the cookies sent counts: a planted cookie of the same name cannot shadow the real one.
	const credentials = [...cookieHeader.matchAll(CREDENTIALS)].map((m) => m[1] as string);
	if (credentials.some((value) => wakeCredentialValid(secret, tenant, value, now))) return "credential";
	return HOOK_ROUTES.some((r) => (r.methods as readonly string[]).includes(method) && r.pattern.test(pathname)) ? "webhook" : undefined;
}

/**
 * The cookies a cell's answer sets, with the wake credential added once the cell itself has
 * accepted the person: right after a login (it sets a session), or when it answers `/api/me` to
 * one. A logout (it clears the session) clears the credential too.
 */
export function wakeCookies(
	setCookies: readonly string[],
	o: { readonly accepted: boolean; readonly pathname: string; readonly tenant: string; readonly secret: string; readonly secure: boolean; readonly now: number },
): readonly string[] {
	if (!o.accepted) return setCookies;
	const session = setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
	const attributes = cookieAttributes(o.secure);
	if (session?.startsWith(`${SESSION_COOKIE}=;`)) return [...setCookies, `${WAKE_COOKIE}=; ${attributes}; Max-Age=0`];
	if (session === undefined && o.pathname !== "/api/me") return setCookies;
	const value = wakeCredential(o.secret, o.tenant, o.now + WAKE_TTL_MS);
	return [...setCookies, `${WAKE_COOKIE}=${value}; ${attributes}; Max-Age=${SESSION_TTL_S}`];
}
