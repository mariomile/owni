import { describe, expect, it } from "vitest";
import { buildMime, GmailMailAdapter, toInboundMail } from "../src/connectors/gmail.ts";
import { egressFetch } from "../src/connectors/http.ts";
import { HubSpotCrmAdapter } from "../src/connectors/hubspot.ts";
import { EgressDenied } from "../src/core/errors.ts";

type Call = { method: string; url: URL; headers: Record<string, string>; body: unknown };
type Route = (call: Call) => Response | Promise<Response>;

/** A fake HTTP API: routes by "METHOD host/path", records every call. Never touches the network. */
function fakeApi(routes: Record<string, Route>) {
	const calls: Call[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const raw = init?.body;
		const body = raw === undefined ? undefined : raw instanceof URLSearchParams ? Object.fromEntries(raw) : JSON.parse(String(raw));
		const call = { method, url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body };
		calls.push(call);
		const route = routes[`${method} ${url.host}${url.pathname}`];
		if (route === undefined) return Response.json({ error: { message: `no route ${method} ${url.pathname}` } }, { status: 404 });
		return route(call);
	}) as typeof fetch;
	return { calls, fetch: fetchImpl };
}

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const creds = async () => ({ clientId: "cid", clientSecret: "csecret", refreshToken: "rtoken" });
const token: Route = () => Response.json({ access_token: "at-1", expires_in: 3599 });

function gmailMessage(id: string, internalDate: number, body: string, extra: { name: string; value: string }[] = []) {
	return {
		id,
		threadId: `thr-${id}`,
		internalDate: String(internalDate),
		payload: {
			mimeType: "multipart/alternative",
			headers: [{ name: "From", value: '"Irene Basile" <irene@example.it>' }, { name: "Subject", value: "Preventivo forno" }, ...extra],
			parts: [
				{ mimeType: "text/html", body: { data: b64("<p>ignorato</p>") } },
				{ mimeType: "text/plain", body: { data: b64(body) } },
			],
		},
	};
}

describe("Gmail adapter (mocked fetch)", () => {
	it("first poll starts from now; later polls read new inbox mail, oldest first, and move the cursor", async () => {
		const t0 = Date.UTC(2026, 9, 15, 9, 0, 0);
		const api = fakeApi({
			"POST oauth2.googleapis.com/token": token,
			"GET gmail.googleapis.com/gmail/v1/users/me/messages": (c) =>
				c.url.searchParams.get("pageToken") === null
					? Response.json({ messages: [{ id: "m2" }], nextPageToken: "p2" })
					: Response.json({ messages: [{ id: "m1" }, { id: "old" }] }),
			"GET gmail.googleapis.com/gmail/v1/users/me/messages/m1": () => Response.json(gmailMessage("m1", t0 + 1000, "Buongiorno, vorrei un preventivo per un forno.")),
			"GET gmail.googleapis.com/gmail/v1/users/me/messages/m2": () => Response.json(gmailMessage("m2", t0 + 5000, "Seconda mail")),
			"GET gmail.googleapis.com/gmail/v1/users/me/messages/old": () => Response.json(gmailMessage("old", t0 - 11 * 60_000, "fuori dalla finestra")),
		});
		const gmail = new GmailMailAdapter({ credentials: creds, fetch: api.fetch, now: () => t0 });

		expect(await gmail.listNewRequests("acme", "")).toEqual({ messages: [], nextCursor: String(t0) });
		expect(api.calls).toEqual([]);

		const { messages, nextCursor } = await gmail.listNewRequests("acme", String(t0));
		expect(messages.map((m) => m.messageId)).toEqual(["m1", "m2"]);
		expect(messages[0]).toEqual({
			messageId: "m1",
			threadId: "thr-m1",
			from: '"Irene Basile" <irene@example.it>',
			fromName: "Irene Basile",
			subject: "Preventivo forno",
			bodyText: "Buongiorno, vorrei un preventivo per un forno.",
			receivedAt: new Date(t0 + 1000).toISOString(),
		});
		expect(nextCursor).toBe(String(t0 + 5000));
		// Each poll looks 10 minutes back: search can index a mail after a newer one.
		const list = api.calls.find((c) => c.url.pathname.endsWith("/messages"));
		expect(list?.url.searchParams.get("q")).toBe(`in:inbox -from:me after:${t0 / 1000 - 600}`);
		// One token refresh for the whole poll, sent as a Bearer header.
		expect(api.calls.filter((c) => c.url.host === "oauth2.googleapis.com")).toHaveLength(1);
		expect(api.calls[0]?.body).toEqual({ client_id: "cid", client_secret: "csecret", refresh_token: "rtoken", grant_type: "refresh_token" });
		expect(api.calls[1]?.headers.authorization).toBe("Bearer at-1");
	});

	it("works through a backlog oldest first and never skips mail beyond the per-poll limit", async () => {
		const t0 = Date.UTC(2026, 9, 15, 9, 0, 0);
		// Five new mails, newest first as Gmail lists them; two per poll.
		const all = [5, 4, 3, 2, 1].map((n) => ({ id: `n${n}`, at: t0 + n * 1000 }));
		const api = fakeApi({
			"POST oauth2.googleapis.com/token": token,
			"GET gmail.googleapis.com/gmail/v1/users/me/messages": (c) => {
				const after = Number(/after:(\d+)/.exec(c.url.searchParams.get("q") ?? "")?.[1]) * 1000;
				return Response.json({ messages: all.filter((m) => m.at >= after).map((m) => ({ id: m.id })) });
			},
			...Object.fromEntries(all.map((m) => [`GET gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`, () => Response.json(gmailMessage(m.id, m.at, m.id))])),
		});
		const gmail = new GmailMailAdapter({ credentials: creds, fetch: api.fetch, now: () => t0 + 60_000, maxPerPoll: 2 });
		const seen: string[] = [];
		let cursor = String(t0);
		for (let i = 0; i < 4; i++) {
			const page = await gmail.listNewRequests("acme", cursor, { isKnown: async (id) => seen.includes(id) });
			for (const m of page.messages) if (!seen.includes(m.messageId)) seen.push(m.messageId);
			cursor = page.nextCursor;
		}
		expect(seen).toEqual(["n1", "n2", "n3", "n4", "n5"]);
	});

	it("refuses line breaks in mail headers (no injected Bcc from model or mail text)", () => {
		expect(() => buildMime({ from: "a@x", to: "b@y", subject: "Re: x\r\nBcc: victim@evil.example", bodyText: "x", messageId: "<m@x>" })).toThrow("line break in the subject header");
		expect(() => buildMime({ from: "a@x", to: "b@y\nCc: c@z", subject: "s", bodyText: "x", messageId: "<m@x>" })).toThrow("to header");
	});

	it("falls back to the HTML body without tags", () => {
		const mail = toInboundMail({ id: "h", threadId: "t", internalDate: "0", payload: { mimeType: "text/html", headers: [], body: { data: b64("<div>Salve,<br>serve un <b>preventivo</b> &amp; consegna</div>") } } });
		expect(mail.bodyText).toBe("Salve,\nserve un preventivo & consegna");
	});

	it("replies in the original thread with In-Reply-To, References and a Message-ID from the idempotency key", async () => {
		const api = fakeApi({
			"POST oauth2.googleapis.com/token": token,
			"GET gmail.googleapis.com/gmail/v1/users/me/messages": () => Response.json({ resultSizeEstimate: 0 }),
			"GET gmail.googleapis.com/gmail/v1/users/me/messages/m1": () =>
				Response.json({ id: "m1", threadId: "thr-m1", payload: { headers: [{ name: "Message-ID", value: "<orig@example.it>" }, { name: "References", value: "<a@x>" }] } }),
			"GET gmail.googleapis.com/gmail/v1/users/me/profile": () => Response.json({ emailAddress: "vendite@acme.example" }),
			"POST gmail.googleapis.com/gmail/v1/users/me/messages/send": () => Response.json({ id: "sent-1", threadId: "thr-m1" }),
		});
		const gmail = new GmailMailAdapter({ credentials: creds, fetch: api.fetch });
		const result = await gmail.sendReply("acme", { to: "irene@example.it", subject: "Preventivo forno", bodyText: "Gentile Irene, ecco però i dettagli.", inReplyToMessageId: "m1", idempotencyKey: "k1" });
		expect(result).toEqual({ sentMessageId: "sent-1" });

		const lookup = api.calls.find((c) => c.url.pathname.endsWith("/messages"));
		expect(lookup?.url.searchParams.get("q")).toMatch(/^in:sent rfc822msgid:<owni\.[0-9a-f]{32}@owni\.local>$/);
		const send = api.calls.find((c) => c.url.pathname.endsWith("/send"));
		const body = send?.body as { raw: string; threadId: string };
		expect(body.threadId).toBe("thr-m1");
		const mime = Buffer.from(body.raw, "base64url").toString("utf8");
		expect(mime).toContain("From: vendite@acme.example\r\nTo: irene@example.it\r\nSubject: Re: Preventivo forno\r\n");
		expect(mime).toContain("In-Reply-To: <orig@example.it>\r\nReferences: <a@x> <orig@example.it>\r\n");
		expect(mime).toContain(`Message-ID: ${lookup?.url.searchParams.get("q")?.split("rfc822msgid:")[1]}`);
		const encodedBody = mime.split("\r\n\r\n")[1] ?? "";
		expect(Buffer.from(encodedBody.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("Gentile Irene, ecco però i dettagli.");
	});

	it("does not send again when the sent folder already has this Message-ID", async () => {
		const api = fakeApi({
			"POST oauth2.googleapis.com/token": token,
			"GET gmail.googleapis.com/gmail/v1/users/me/messages": () => Response.json({ messages: [{ id: "sent-earlier" }] }),
		});
		const gmail = new GmailMailAdapter({ credentials: creds, fetch: api.fetch });
		expect(await gmail.sendReply("acme", { to: "a@b.example", subject: "s", bodyText: "b", inReplyToMessageId: "m1", idempotencyKey: "k1" })).toEqual({ sentMessageId: "sent-earlier" });
		expect(api.calls.some((c) => c.url.pathname.endsWith("/send"))).toBe(false);
	});

	it("never retries a send, retries reads on rate limits, and names missing credentials", async () => {
		let lists = 0;
		const api = fakeApi({
			"POST oauth2.googleapis.com/token": token,
			"GET gmail.googleapis.com/gmail/v1/users/me/messages": () =>
				++lists === 1 ? Response.json({ error: { code: 429, message: "slow down" } }, { status: 429 }) : Response.json({}),
			"GET gmail.googleapis.com/gmail/v1/users/me/messages/m1": () => Response.json({ id: "m1", threadId: "t", payload: { headers: [] } }),
			"GET gmail.googleapis.com/gmail/v1/users/me/profile": () => Response.json({ emailAddress: "v@acme.example" }),
			"POST gmail.googleapis.com/gmail/v1/users/me/messages/send": () => Response.json({ error: { code: 500, message: "backend" } }, { status: 500 }),
		});
		const gmail = new GmailMailAdapter({ credentials: creds, fetch: api.fetch, retryBaseMs: 1 });
		await expect(gmail.sendReply("acme", { to: "a@b.example", subject: "s", bodyText: "b", inReplyToMessageId: "m1", idempotencyKey: "k" })).rejects.toThrow("gmail messages.send failed: HTTP 500");
		expect(lists).toBe(2);
		expect(api.calls.filter((c) => c.url.pathname.endsWith("/send"))).toHaveLength(1);

		const none = new GmailMailAdapter({ credentials: async () => undefined, fetch: api.fetch });
		await expect(none.listNewRequests("acme", "1")).rejects.toThrow("mail.gmail.refreshToken");
	});

	it("reports a revoked refresh token without leaking secrets", async () => {
		const api = fakeApi({ "POST oauth2.googleapis.com/token": () => Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 }) });
		const gmail = new GmailMailAdapter({ credentials: creds, fetch: api.fetch });
		const error = (await gmail.listNewRequests("acme", "1").catch((e: unknown) => e)) as Error;
		expect(error.message).toBe("gmail token refresh failed: HTTP 400 invalid_grant: Token has been expired or revoked.");
		expect(error.message).not.toMatch(/rtoken|csecret/);
	});

	it("encodes non-ASCII subjects (RFC 2047) and keeps an existing Re:", () => {
		const mime = Buffer.from(buildMime({ from: "a@x", to: "b@y", subject: "Re: Perché", bodyText: "x", messageId: "<m@x>", inReplyTo: "<o@y>" }), "base64url").toString("utf8");
		expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from("Re: Perché").toString("base64")}?=`);
	});
});

describe("HubSpot adapter (mocked fetch)", () => {
	const lead = {
		fullName: "Irene Maria Basile",
		title: "Dott.ssa",
		company: "Basile Srl",
		email: "irene@example.it",
		phone: "+39 333 0000000",
		productOrService: "forno a convezione",
		vatNumber: "IT01234567890",
		missingFields: ["quantity"],
		rawSubject: "Preventivo forno",
		mailMessageId: "m1",
	} as const;

	it("upserts the contact by email with only what the sender wrote, then adds a note", async () => {
		const api = fakeApi({
			"POST api.hubapi.com/crm/v3/objects/contacts/batch/upsert": () => Response.json({ status: "COMPLETE", results: [{ id: "501", new: true }] }),
			"POST api.hubapi.com/crm/v3/objects/notes": () => Response.json({ id: "n1" }),
		});
		const crm = new HubSpotCrmAdapter({ accessToken: async () => "pat-1", fetch: api.fetch, now: () => 0 });
		expect(await crm.upsertLead("acme", lead, "idem-1")).toEqual({ crmLeadId: "501", created: true });

		expect(api.calls[0]?.headers.authorization).toBe("Bearer pat-1");
		expect(api.calls[0]?.body).toEqual({
			inputs: [{ id: "irene@example.it", idProperty: "email", objectWriteTraceId: "idem-1", properties: { email: "irene@example.it", firstname: "Irene", lastname: "Maria Basile", phone: "+39 333 0000000", company: "Basile Srl" } }],
		});
		// No title, no VAT number in the CRM (A7).
		expect(JSON.stringify(api.calls[0]?.body)).not.toMatch(/Dott|IT0123/);
		const note = api.calls[1]?.body as { properties: { hs_note_body: string; hs_timestamp: string }; associations: unknown };
		expect(note.properties.hs_note_body).toContain("Dati mancanti: quantity.");
		expect(note.properties.hs_timestamp).toBe("1970-01-01T00:00:00.000Z");
		expect(note.associations).toEqual([{ to: { id: "501" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }]);
	});

	it("names a wrong VAT number in the note in words, never the number", async () => {
		const api = fakeApi({
			"POST api.hubapi.com/crm/v3/objects/contacts/batch/upsert": () => Response.json({ status: "COMPLETE", results: [{ id: "501", new: true }] }),
			"POST api.hubapi.com/crm/v3/objects/notes": () => Response.json({ id: "n1" }),
		});
		const crm = new HubSpotCrmAdapter({ accessToken: async () => "pat-1", fetch: api.fetch, now: () => 0 });
		await crm.upsertLead("acme", { ...lead, vatNumber: null, missingFields: ["quantity", "vatNumberInvalid"] }, "idem-1");
		const note = api.calls[1]?.body as { properties: { hs_note_body: string } };
		expect(note.properties.hs_note_body).toContain("Dati mancanti: quantity, P.IVA da ricontrollare.");
	});

	it("creates the contact when there is no email", async () => {
		const api = fakeApi({
			"POST api.hubapi.com/crm/v3/objects/contacts": () => Response.json({ id: "777" }),
			"POST api.hubapi.com/crm/v3/objects/notes": () => Response.json({ id: "n1" }),
		});
		const crm = new HubSpotCrmAdapter({ accessToken: async () => "pat", fetch: api.fetch });
		expect(await crm.upsertLead("acme", { ...lead, email: null }, "k")).toEqual({ crmLeadId: "777", created: true });
	});

	it("sets the lead status and adds a note; a portal that rejects the value still gets the note", async () => {
		let reject = false;
		const api = fakeApi({
			"PATCH api.hubapi.com/crm/v3/objects/contacts/501": () =>
				reject ? Response.json({ status: "error", category: "VALIDATION_ERROR", message: "INVALID_OPTION" }, { status: 400 }) : Response.json({ id: "501" }),
			"POST api.hubapi.com/crm/v3/objects/notes": () => Response.json({ id: "n" }),
		});
		const logs: string[] = [];
		const crm = new HubSpotCrmAdapter({ accessToken: async () => "pat", fetch: api.fetch, log: (l) => logs.push(l) });
		await crm.updateLeadStatus("acme", "501", "replied");
		expect(api.calls[0]?.body).toEqual({ properties: { hs_lead_status: "ATTEMPTED_TO_CONTACT" } });
		expect((api.calls[1]?.body as { properties: { hs_note_body: string } }).properties.hs_note_body).toContain("risposta inviata");

		reject = true;
		await crm.updateLeadStatus("acme", "501", "discarded", "scartata da commerciale");
		expect(logs[0]).toContain('hs_lead_status "UNQUALIFIED" rejected');
		expect((api.calls.at(-1)?.body as { properties: { hs_note_body: string } }).properties.hs_note_body).toBe("Owni: pratica scartata dal commerciale. scartata da commerciale");
	});
});

describe("connector egress", () => {
	const ok = (async () => Response.json({})) as typeof fetch;

	it("allows only listed connectors, only their hosts, only over https", async () => {
		const policy = { modelProviders: [], channels: [], connectors: ["gmail"] };
		const gmailFetch = egressFetch("gmail", ["gmail.googleapis.com"], () => policy, ok);
		await expect(gmailFetch("https://gmail.googleapis.com/gmail/v1/users/me/profile")).resolves.toBeInstanceOf(Response);
		await expect(gmailFetch("https://evil.example.com/x")).rejects.toThrow(EgressDenied);
		await expect(gmailFetch("http://gmail.googleapis.com/x")).rejects.toThrow(EgressDenied);

		const hubspotFetch = egressFetch("hubspot", ["api.hubapi.com"], () => policy, ok);
		await expect(hubspotFetch("https://api.hubapi.com/crm/v3/objects/contacts")).rejects.toThrow('connector "hubspot"');
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
