import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { sameSecret } from "./compare.ts";
import { readJsonFile, updateJsonFile } from "../core/locked-json.ts";
import { generateTotpSecret, verifyTotp } from "./totp.ts";

/**
 * A person who uses the web interface. The owner manages Owni; a member uses the
 * instances whose web allowlist names them. Only token hashes are stored.
 */
export type Person = {
	readonly id: string;
	readonly name: string;
	readonly role: "owner" | "member";
	readonly tokenHash: string;
	readonly createdAt: string;
	/** Two-factor login (TOTP): on once `secret` is set; `lastStep` stops a code being reused. */
	readonly totp?: { readonly secret: string; readonly lastStep: number };
	/** A secret shown to the person and not yet confirmed with a code. */
	readonly totpPending?: string;
};

export type PublicPerson = Omit<Person, "tokenHash" | "totp" | "totpPending"> & { readonly twoFactor: boolean };

export function publicPerson(p: Person): PublicPerson {
	const { tokenHash: _hash, totp, totpPending: _pending, ...rest } = p;
	return { ...rest, twoFactor: totp !== undefined };
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");


/** The people of a tenant, in one file. */
export class PeopleStore {
	private readonly file: string;
	constructor(tenantDir: string) {
		this.file = join(tenantDir, "people.json");
	}

	async list(): Promise<Person[]> {
		return readJsonFile<Person[]>(this.file, []);
	}

	async get(id: string): Promise<Person | undefined> {
		return (await this.list()).find((p) => p.id === id);
	}

	/** Create a person; returns their login token, shown once. */
	async add(name: string, role: Person["role"]): Promise<{ person: Person; token: string }> {
		if (name.trim() === "" || name.length > 80) throw new Error("Name: 1 to 80 characters");
		const token = randomBytes(32).toString("base64url");
		const person: Person = { id: `p_${randomBytes(6).toString("hex")}`, name: name.trim(), role, tokenHash: hash(token), createdAt: new Date().toISOString() };
		updateJsonFile<Person[]>(this.file, [], (all) => [...all, person]);
		return { person, token };
	}

	/** A new login token; the old one stops working. Existing sessions are ended by the caller. */
	async rotate(id: string): Promise<string> {
		const token = randomBytes(32).toString("base64url");
		this.update(id, (p) => [{ ...p, tokenHash: hash(token) }, undefined]);
		return token;
	}

	async remove(id: string): Promise<boolean> {
		const before = (await this.list()).length;
		return updateJsonFile<Person[]>(this.file, [], (all) => all.filter((p) => p.id !== id)).length !== before;
	}

	/** Start turning on 2FA: a new secret, active only once confirmed with `enableTotp`. */
	async startTotp(id: string): Promise<string> {
		const secret = generateTotpSecret();
		this.update(id, (p) => [{ ...p, totpPending: secret }, undefined]);
		return secret;
	}

	/** Turn on 2FA if `code` matches the pending secret. */
	async enableTotp(id: string, code: string, now = Date.now()): Promise<boolean> {
		return this.update(id, (p) => {
			const step = p.totpPending === undefined ? undefined : verifyTotp(p.totpPending, code, now);
			if (p.totpPending === undefined || step === undefined) return [p, false];
			const { totpPending: _pending, ...rest } = p;
			return [{ ...rest, totp: { secret: p.totpPending, lastStep: step } }, true];
		});
	}

	/** Check a code for a person with 2FA on, and use it up. */
	async useTotp(id: string, code: string, now = Date.now()): Promise<boolean> {
		return this.update(id, (p) => {
			const step = p.totp === undefined ? undefined : verifyTotp(p.totp.secret, code, now, p.totp.lastStep);
			if (p.totp === undefined || step === undefined) return [p, false];
			return [{ ...p, totp: { ...p.totp, lastStep: step } }, true];
		});
	}

	/** Turn 2FA off (after a code from the person, or a reset by the owner). */
	async clearTotp(id: string): Promise<void> {
		this.update(id, (p) => {
			const { totp: _totp, totpPending: _pending, ...rest } = p;
			return [rest, undefined];
		});
	}

	async byToken(token: string): Promise<Person | undefined> {
		if (typeof token !== "string" || token.length < 20 || token.length > 200) return undefined;
		const h = hash(token);
		return (await this.list()).find((p) => sameSecret(p.tokenHash, h));
	}

	/** Change one person under the shared lock; returns what `change` reports. */
	private update<R>(id: string, change: (p: Person) => [Person, R]): R {
		let result: R | undefined;
		updateJsonFile<Person[]>(this.file, [], (all) => {
			const index = all.findIndex((p) => p.id === id);
			if (index < 0) throw new Error(`No person ${id}`);
			const [next, r] = change(all[index] as Person);
			result = r;
			return all.with(index, next);
		});
		return result as R;
	}
}

/** The console's session cookie, and how long a session lasts. */
export const SESSION_COOKIE = "owni_session";
export const SESSION_TTL_S = 30 * 24 * 3600;

/** The attributes of Owni's cookies: never read by scripts, never sent cross-site; `secure` over https. */
export function cookieAttributes(secure: boolean): string {
	return `HttpOnly; SameSite=Strict; Path=/${secure ? "; Secure" : ""}`;
}

type Session = { readonly idHash: string; readonly personId: string; readonly expiresAt: number };

/** Web sessions, persisted so a restart does not log everyone out. */
export class SessionStore {
	private readonly file: string;

	constructor(
		tenantDir: string,
		private readonly ttlMs = SESSION_TTL_S * 1000,
	) {
		this.file = join(tenantDir, "sessions.json");
	}

	async create(personId: string, now = Date.now()): Promise<string> {
		const id = randomBytes(32).toString("base64url");
		updateJsonFile<Session[]>(this.file, [], (all) => [...all.filter((s) => s.expiresAt > now), { idHash: hash(id), personId, expiresAt: now + this.ttlMs }]);
		return id;
	}

	async personOf(sessionId: string | undefined, now = Date.now()): Promise<string | undefined> {
		if (sessionId === undefined || sessionId.length < 20 || sessionId.length > 200) return undefined;
		const h = hash(sessionId);
		return (await this.load()).find((s) => s.expiresAt > now && sameSecret(s.idHash, h))?.personId;
	}

	async end(sessionId: string): Promise<void> {
		const h = hash(sessionId);
		updateJsonFile<Session[]>(this.file, [], (all) => all.filter((s) => !sameSecret(s.idHash, h)));
	}

	/** End every session of a person, but `keep` (the session asking, when it should stay). */
	async endAllOf(personId: string, keep?: string): Promise<void> {
		const kept = keep === undefined ? undefined : hash(keep);
		updateJsonFile<Session[]>(this.file, [], (all) => all.filter((s) => s.personId !== personId || (kept !== undefined && sameSecret(s.idHash, kept))));
	}

	/** Read every time: the CLI revokes sessions from another process. */
	private async load(): Promise<Session[]> {
		return readJsonFile<Session[]>(this.file, []);
	}
}
