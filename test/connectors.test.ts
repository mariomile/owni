import { describe, expect, it } from "vitest";
import { egressFetch } from "../src/connectors/http.ts";
import { EgressDenied } from "../src/core/errors.ts";

describe("connector egress", () => {
	const ok = (async () => Response.json({})) as typeof fetch;

	it("allows only listed connectors, only their hosts, only over https", async () => {
		const policy = { modelProviders: [], channels: [], connectors: ["gmail"] };
		const gmailFetch = egressFetch("gmail", ["gmail.googleapis.com"], () => policy, ok);
		await expect(gmailFetch("https://gmail.googleapis.com/gmail/v1/users/me/profile")).resolves.toBeInstanceOf(Response);
		await expect(gmailFetch("https://evil.example.com/x")).rejects.toThrow(EgressDenied);
		await expect(gmailFetch("http://gmail.googleapis.com/x")).rejects.toThrow(EgressDenied);

		const calendarFetch = egressFetch("calendar", ["www.googleapis.com"], () => policy, ok);
		await expect(calendarFetch("https://www.googleapis.com/calendar/v3/calendars")).rejects.toThrow('connector "calendar"');
		// Policies from before week 4 have no connectors: nothing is allowed.
		const legacy = egressFetch("gmail", ["gmail.googleapis.com"], () => ({ modelProviders: [], channels: [] }), ok);
		await expect(legacy("https://gmail.googleapis.com/x")).rejects.toThrow(EgressDenied);
	});

	it("re-reads the policy on every request and never follows redirects", async () => {
		let policy = { modelProviders: [], channels: [], connectors: ["gmail"] };
		const inits: (RequestInit | undefined)[] = [];
		const base = (async (_: string | URL | Request, init?: RequestInit) => {
			inits.push(init);
			return Response.json({});
		}) as typeof fetch;
		const guarded = egressFetch("gmail", ["gmail.googleapis.com"], async () => policy, base);
		await guarded("https://gmail.googleapis.com/a");
		expect(inits[0]?.redirect).toBe("error");
		policy = { modelProviders: [], channels: [], connectors: [] };
		await expect(guarded("https://gmail.googleapis.com/a")).rejects.toThrow(EgressDenied);
	});
});
