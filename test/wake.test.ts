import { describe, expect, it } from "vitest";
import { WAKE_TTL_MS, wakeCookies, wakeCredential, wakeKind } from "../src/cloud/wake.ts";

const SECRET = "s".repeat(43);
const NOW = 1_800_000_000_000;
const real = `owni_wake=${wakeCredential(SECRET, "anna", NOW + WAKE_TTL_MS)}`;
const kind = (cookie: string, pathname = "/api/me", tenant = "anna") => wakeKind(cookie, pathname, tenant, SECRET, NOW);

describe("waking a stopped cell", () => {
	it("wakes for the credential the control plane signed for this tenant, until it expires", () => {
		expect(kind(`owni_session=x; ${real}`)).toBe("credential");
		expect(wakeKind(real, "/api/me", "anna", SECRET, NOW + WAKE_TTL_MS)).toBeUndefined();
	});

	it("does not wake for a forged credential, one of another tenant or another cell's secret, or none", () => {
		expect(kind(`owni_wake=${"1".repeat(13)}.${"a".repeat(64)}`)).toBeUndefined();
		expect(kind(real, "/api/me", "luca")).toBeUndefined();
		expect(wakeKind(real, "/api/me", "anna", "t".repeat(43), NOW)).toBeUndefined();
		expect(kind(`owni_session=${"a".repeat(32)}`)).toBeUndefined();
		expect(kind(`xowni_wake=${wakeCredential(SECRET, "anna", NOW + 1000)}`)).toBeUndefined();
	});

	it("a planted cookie of the same name does not shadow the real one", () => {
		expect(kind(`owni_wake=1.zz; owni_session=x; ${real}`)).toBe("credential");
	});

	it("wakes for the webhook paths a cell serves, and no other", () => {
		for (const path of ["/hooks/telegram/owni", "/hooks/phone/owni", "/hooks/whatsapp/owni", "/hooks/automazione/owni/0123456789ab"]) expect(kind("", path)).toBe("webhook");
		for (const path of ["/hooks/not-a-real-hook", "/hooks/telegram/a/b", "/hooks/automazione/owni/xyz", "/api/me"]) expect(kind("", path)).toBeUndefined();
	});
});

describe("the wake credential follows the session", () => {
	const options = { accepted: true, pathname: "/api/login", tenant: "anna", secret: SECRET, secure: true, now: NOW };

	it("is set with a new session, and on /api/me answered to one", () => {
		const login = wakeCookies(["owni_session=abc; HttpOnly"], options);
		expect(login[0]).toBe("owni_session=abc; HttpOnly");
		expect(login[1]).toBe(`${real}; HttpOnly; SameSite=Strict; Path=/; Secure; Max-Age=${WAKE_TTL_MS / 1000}`);
		expect(wakeCookies([], { ...options, pathname: "/api/me" })).toHaveLength(1);
		expect(wakeCookies([], { ...options, pathname: "/api/me", secure: false })[0]).not.toContain("Secure");
	});

	it("is cleared with the session, and not given for an answer that refused or set no session", () => {
		expect(wakeCookies(["owni_session=; Max-Age=0"], options)[1]).toBe("owni_wake=; HttpOnly; SameSite=Strict; Path=/; Secure; Max-Age=0");
		const none = ["other=1"];
		expect(wakeCookies(none, { ...options, pathname: "/api/chat" })).toBe(none);
		expect(wakeCookies(["owni_session=abc"], { ...options, accepted: false })).toEqual(["owni_session=abc"]);
		expect(wakeCookies([], { ...options, pathname: "/api/me", accepted: false })).toEqual([]);
	});
});
