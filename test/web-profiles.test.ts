import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CookieJar } from "../src/core/web-fetch.ts";
import { BrowserProfiles } from "../src/core/web-profiles.ts";

const DAY = 86_400_000;
const NOW = new Date("2026-10-23T10:00:00Z");
const url = (raw: string) => new URL(raw);

describe("CookieJar", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});
	afterEach(() => vi.useRealTimers());

	it("Domain: its own host covers subdomains, a parent stays host-only, another domain is refused", () => {
		const jar = new CookieJar();
		jar.take(url("https://www.x.it/"), ["own=1; Domain=www.x.it", "parent=2; Domain=.x.it", "suffix=3; Domain=it", "other=4; Domain=other.it", "plain=5"]);
		expect(jar.header(url("https://www.x.it/"))).toBe("own=1; parent=2; suffix=3; plain=5");
		expect(jar.header(url("https://a.www.x.it/"))).toBe("own=1");
		expect(jar.header(url("https://forms.x.it/"))).toBeUndefined();
		expect(jar.header(url("https://x.it/"))).toBeUndefined();
		expect(jar.header(url("https://other.it/"))).toBeUndefined();
		const ip = new CookieJar();
		ip.take(url("http://1.2.3.4/"), ["a=1; Domain=1.2.3.4"]);
		expect(ip.snapshot()[0]?.hostOnly).toBe(true);
	});

	it("Path: default path from the request, prefix matching on segments, longer paths first", () => {
		const jar = new CookieJar();
		jar.take(url("https://e.com/a/b/c"), ["d=1", "root=2; Path=/", "x=3; Path=/x", "bad=4; Path=nope"]);
		expect(jar.snapshot().map((c) => [c.name, c.path])).toEqual([["d", "/a/b"], ["root", "/"], ["x", "/x"], ["bad", "/a/b"]]);
		expect(jar.header(url("https://e.com/a/b/z"))).toBe("d=1; bad=4; root=2");
		expect(jar.header(url("https://e.com/a/b"))).toBe("d=1; bad=4; root=2");
		expect(jar.header(url("https://e.com/a/bc"))).toBe("root=2");
		expect(jar.header(url("https://e.com/x/y"))).toBe("x=3; root=2");
		expect(jar.header(url("https://e.com/xy"))).toBe("root=2");
		const top = new CookieJar();
		top.take(url("https://e.com/page"), ["t=1"]);
		expect(top.snapshot()[0]?.path).toBe("/");
	});

	it("Secure: only set over https, only sent over https, not replaced from http; __Secure- and __Host- prefixes", () => {
		const jar = new CookieJar();
		jar.take(url("http://e.com/"), ["s=1; Secure"]);
		expect(jar.snapshot()).toEqual([]);
		jar.take(url("https://e.com/"), ["s=1; Secure"]);
		expect(jar.header(url("http://e.com/"))).toBeUndefined();
		jar.take(url("http://e.com/"), ["s=evil"]);
		expect(jar.header(url("https://e.com/"))).toBe("s=1");
		jar.take(url("https://e.com/"), ["__Secure-a=1", "__Secure-b=2; Secure", "__Host-c=3; Secure", "__Host-d=4; Secure; Path=/; Domain=e.com", "__Host-e=5; Secure; Path=/"]);
		expect(jar.header(url("https://e.com/"))).toBe("s=1; __Secure-b=2; __Host-e=5");
	});

	it.each([
		{ from: "a longer path", secureAt: "https://e.com/", secure: "sid=real; Secure; Path=/", plainAt: "http://e.com/", plain: "sid=injected; Path=/login", sent: "https://e.com/login" },
		{ from: "a shorter path", secureAt: "https://e.com/", secure: "sid=real; Secure; Path=/account", plainAt: "http://e.com/", plain: "sid=injected; Path=/", sent: "https://e.com/account/x" },
		{ from: "a subdomain", secureAt: "https://x.it/", secure: "sid=real; Secure; Domain=x.it", plainAt: "http://www.x.it/", plain: "sid=injected", sent: "https://www.x.it/" },
		{ from: "a parent domain", secureAt: "https://www.x.it/", secure: "sid=real; Secure", plainAt: "http://x.it/", plain: "sid=injected; Domain=x.it", sent: "https://www.x.it/" },
	])("Secure: plain http cannot shadow a live Secure cookie from $from", ({ secureAt, secure, plainAt, plain, sent }) => {
		const jar = new CookieJar();
		jar.take(url(secureAt), [secure]);
		jar.take(url(plainAt), [plain]);
		expect(jar.header(url(sent))).toBe("sid=real");
		expect(jar.snapshot()).toHaveLength(1);
	});

	it.each([
		{ on: "another path", secureAt: "https://x.it/app", secure: "sid=s; Secure; Path=/app", plainAt: "http://x.it/", plain: "sid=p; Path=/api", sent: "http://x.it/api" },
		{ on: "a path that only starts alike", secureAt: "https://x.it/app", secure: "sid=s; Secure; Path=/app", plainAt: "http://x.it/", plain: "sid=p; Path=/apple", sent: "http://x.it/apple" },
		{ on: "a subdomain of a host-only cookie", secureAt: "https://x.it/", secure: "sid=s; Secure", plainAt: "http://www.x.it/", plain: "sid=p", sent: "http://www.x.it/" },
		{ on: "the parent of a host-only cookie", secureAt: "https://www.x.it/", secure: "sid=s; Secure", plainAt: "http://x.it/", plain: "sid=p", sent: "http://x.it/" },
		{ on: "a sibling subdomain", secureAt: "https://a.x.it/", secure: "sid=s; Secure; Domain=a.x.it", plainAt: "http://b.x.it/", plain: "sid=p; Domain=b.x.it", sent: "http://c.b.x.it/" },
	])("Secure: plain http still sets the same name on $on, where no request carries both", ({ secureAt, secure, plainAt, plain, sent }) => {
		const jar = new CookieJar();
		jar.take(url(secureAt), [secure]);
		jar.take(url(plainAt), [plain]);
		expect(jar.header(url(sent))).toBe("sid=p");
		expect(jar.snapshot()).toHaveLength(2);
	});

	it("Secure: plain http cannot expire a live Secure cookie, and sets the name freely once that has expired", () => {
		const jar = new CookieJar();
		jar.take(url("https://e.com/"), ["sid=real; Secure; Max-Age=60"]);
		jar.take(url("http://e.com/"), ["sid=; Max-Age=0", "sid=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT"]);
		expect(jar.header(url("https://e.com/login"))).toBe("sid=real");
		vi.setSystemTime(NOW.getTime() + 61_000);
		jar.take(url("http://e.com/"), ["sid=plain", "sid=login; Path=/login"]);
		expect(jar.header(url("https://e.com/login"))).toBe("sid=login; sid=plain");
		expect(jar.snapshot().map((c) => [c.value, c.secure])).toEqual([["plain", false], ["login", false]]);
	});

	it("expiry: Max-Age over Expires, deletion, 30 days without expiry, never past 400 days", () => {
		const jar = new CookieJar();
		jar.take(url("https://e.com/"), ["session=1", "long=2; Max-Age=999999999", "dated=3; Expires=Wed, 21 Oct 2099 07:28:00 GMT", "both=4; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Max-Age=60", "past=5; Expires=Thu, 01 Jan 1970 00:00:00 GMT"]);
		const at = Object.fromEntries(jar.snapshot().map((c) => [c.name, c.expires - NOW.getTime()]));
		expect(at).toEqual({ session: 30 * DAY, long: 400 * DAY, dated: 400 * DAY, both: 60_000 });
		jar.take(url("https://e.com/"), ["long=; Max-Age=0", "dated=x; Max-Age=-1"]);
		expect(jar.header(url("https://e.com/"))).toBe("session=1; both=4");
		vi.setSystemTime(NOW.getTime() + 61_000);
		expect(jar.header(url("https://e.com/"))).toBe("session=1");
		vi.setSystemTime(NOW.getTime() + 30 * DAY + 1);
		expect(jar.header(url("https://e.com/"))).toBeUndefined();
		expect(jar.snapshot()).toEqual([]);
	});

	it("bounds: 4 KB per cookie, 50 cookies (the oldest goes), malformed and injected lines refused", () => {
		const jar = new CookieJar();
		jar.take(url("https://e.com/"), [`big=${"x".repeat(4093)}`, `huge=${"x".repeat(4093)}`, "=nameless", "no-equals", "sp ace=1", "crlf=a\r\nX-Injected: 1", "nul=a\u0000b", "tab=a\tb"]);
		expect(jar.snapshot().map((c) => c.name)).toEqual(["big"]);
		for (let i = 0; i < 55; i++) jar.take(url("https://e.com/"), [`c${i}=v`]);
		const names = jar.snapshot().map((c) => c.name);
		expect(names).toHaveLength(50);
		expect(names[0]).toBe("c5");
		expect(names.at(-1)).toBe("c54");
		expect(jar.header(url("https://e.com/"))).not.toMatch(/[\r\n]/);
	});

	it("snapshot: plain JSON that gives the same jar back, live cookies only; hosts() lists the sites", () => {
		const jar = new CookieJar();
		jar.take(url("https://www.b.it/"), ["a=1; Secure; Path=/"]);
		jar.take(url("https://a.it/x/"), ["b=2; Domain=a.it", "gone=3; Max-Age=0"]);
		jar.take(url("https://a.it/"), ["c=3"]);
		const again = new CookieJar(JSON.parse(JSON.stringify(jar.snapshot())));
		expect(again.snapshot()).toEqual(jar.snapshot());
		expect(again.header(url("https://sub.a.it/x/y"))).toBe("b=2");
		expect(again.hosts()).toEqual(["a.it", "www.b.it"]);
		vi.setSystemTime(NOW.getTime() + 31 * DAY);
		expect(new CookieJar(jar.snapshot()).hosts()).toEqual([]);
	});

	it("a malformed snapshot is refused whole; an expired entry is dropped; a stretched one is cut to 400 days", () => {
		const good = { name: "a", value: "1", domain: "e.com", hostOnly: true, path: "/", secure: false, expires: NOW.getTime() + DAY };
		expect(() => new CookieJar({ cookies: [] })).toThrow();
		expect(() => new CookieJar(Array.from({ length: 51 }, (_, i) => ({ ...good, name: `a${i}` })))).toThrow();
		for (const bad of [{ ...good, value: "a\r\nb" }, { ...good, name: "a b" }, { ...good, domain: "E.com" }, { ...good, domain: "e.com/x" }, { ...good, path: "x" }, { ...good, secure: "no" }, { ...good, expires: "soon" }, { ...good, value: "x".repeat(4096) }, null, "a=1"]) {
			expect(() => new CookieJar([good, bad])).toThrow();
		}
		expect(new CookieJar([{ ...good, expires: NOW.getTime() - 1 }]).snapshot()).toEqual([]);
		expect(new CookieJar([{ ...good, expires: NOW.getTime() + 999 * DAY }]).snapshot()[0]?.expires).toBe(NOW.getTime() + 400 * DAY);
		expect(new CookieJar([]).snapshot()).toEqual([]);
	});
});

describe("BrowserProfiles", () => {
	let dataDir: string;
	const instance = () => join(dataDir, "tenants", "t1", "instances", "i1");
	const fileOf = (person: string) => join(instance(), "browser", `${createHash("sha256").update(person).digest("hex")}.json`);
	const signedIn = () => {
		const jar = new CookieJar();
		jar.take(url("https://mail.example.com/"), ["sid=abc; Secure; Max-Age=3600"]);
		return jar;
	};

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), "owni-profiles-"));
		mkdirSync(instance(), { recursive: true });
	});
	afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

	it("nothing saved: an empty jar; saved: the same cookies back, in a 0600 file named by hash in a 0700 folder", async () => {
		const profiles = new BrowserProfiles(dataDir);
		expect((await profiles.load("t1/i1", "person-1")).snapshot()).toEqual([]);
		await profiles.save("t1/i1", "person-1", signedIn());
		const back = await profiles.load("t1/i1", "person-1");
		expect(back.header(url("https://mail.example.com/"))).toBe("sid=abc");
		expect(back.hosts()).toEqual(["mail.example.com"]);
		expect(statSync(fileOf("person-1")).mode & 0o777).toBe(0o600);
		expect(statSync(join(instance(), "browser")).mode & 0o777).toBe(0o700);
		expect(readdirSync(join(instance(), "browser"))).toEqual([`${createHash("sha256").update("person-1").digest("hex")}.json`]);
		expect(readFileSync(fileOf("person-1"), "utf8")).not.toContain("person-1");
		expect((await profiles.load("t1/i1", "person-2")).snapshot()).toEqual([]);
	});

	it("a damaged file gives an empty jar, and the next save replaces it", async () => {
		const profiles = new BrowserProfiles(dataDir);
		mkdirSync(join(instance(), "browser"));
		for (const text of ["{not json", '{"cookies":[]}', '[{"name":"a","value":"1\\r\\nX: y","domain":"e.com","hostOnly":true,"path":"/","secure":false,"expires":9e15}]']) {
			writeFileSync(fileOf("p"), text);
			expect((await profiles.load("t1/i1", "p")).snapshot()).toEqual([]);
		}
		await profiles.save("t1/i1", "p", signedIn());
		expect((await profiles.load("t1/i1", "p")).hosts()).toEqual(["mail.example.com"]);
	});

	it("a save after the instance was deleted (folder moved aside) does not make its folder again", async () => {
		const profiles = new BrowserProfiles(dataDir);
		await profiles.save("t1/i1", "p", signedIn());
		const aside = join(dataDir, "tenants", "t1", "removed", "i1-x");
		mkdirSync(join(aside, ".."), { recursive: true });
		renameSync(instance(), aside);
		await profiles.save("t1/i1", "p", signedIn());
		expect(existsSync(instance())).toBe(false);
		await profiles.save("t1/never", "p", signedIn());
		expect(existsSync(join(dataDir, "tenants", "t1", "instances", "never"))).toBe(false);
		expect((await profiles.load("t1/i1", "p")).snapshot()).toEqual([]);
		await profiles.clear("t1/i1", "p");
	});

	it("clear forgets the saved cookies and a half-written save, only this person's", async () => {
		const profiles = new BrowserProfiles(dataDir);
		await profiles.clear("t1/i1", "p");
		await profiles.save("t1/i1", "p", signedIn());
		await profiles.save("t1/i1", "other", signedIn());
		const name = `${createHash("sha256").update("p").digest("hex")}.json`;
		writeFileSync(join(instance(), "browser", `.${name}.123.0.tmp`), "[]");
		await profiles.clear("t1/i1", "p");
		expect(existsSync(fileOf("p"))).toBe(false);
		expect(readdirSync(join(instance(), "browser"))).toEqual([`${createHash("sha256").update("other").digest("hex")}.json`]);
		expect((await profiles.load("t1/i1", "p")).snapshot()).toEqual([]);
		expect((await profiles.load("t1/i1", "other")).hosts()).toEqual(["mail.example.com"]);
	});

	it("refuses a scope that is not tenant/instance IDs, and an empty person", async () => {
		const profiles = new BrowserProfiles(dataDir);
		for (const scope of ["t1", "t1/i1/x", "../t1/i1", "t1/..", "T1/i1", "t1/"]) {
			await expect(profiles.load(scope, "p")).rejects.toThrow();
			await expect(profiles.save(scope, "p", new CookieJar())).rejects.toThrow();
			await expect(profiles.clear(scope, "p")).rejects.toThrow();
		}
		await expect(profiles.load("t1/i1", "")).rejects.toThrow();
	});
});
