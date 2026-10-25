import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningOwni, startOwni } from "../src/app.ts";
import { connectTwilioNumber, type PendingReplies, PHONE_NOTE, PhoneAdapter, spoken } from "../src/channels/phone.ts";
import { ChannelRefused, type InboundMessage } from "../src/channels/types.ts";
import { type Schedule, type ScheduleStore, schedulePerson } from "../src/core/schedules.ts";
import { createScheduleTools } from "../src/core/tools/schedule-tools.ts";
import { loadOwniConfig } from "../src/main/config.ts";
import { tempDataDir } from "./helpers.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

const ACCOUNT = `AC${"1".repeat(32)}`;
const AUTH = "0123456789abcdef0123456789abcdef";
const NUMBER = "+390612345678";
const NUMBER_SID = `PN${"a".repeat(32)}`;
const CALLER = "+393331234567";
const PIN = "4821";
const SID = `CA${"0".repeat(32)}`;
const SID2 = `CA${"9".repeat(32)}`;

/** Twilio's signature, as its servers compute it. */
function twilioSign(url: string, params: Record<string, string>, token = AUTH): string {
	const data = url + Object.keys(params).sort().map((k) => `${k}${params[k]}`).join("");
	return createHmac("sha1", token).update(data).digest("base64");
}

function memoryPending(): PendingReplies & { all: Map<string, { text: string; key: string }[]> } {
	const all = new Map<string, { text: string; key: string }[]>();
	return {
		all,
		take: (n) => {
			const list = all.get(n) ?? [];
			all.delete(n);
			return list.map((r) => r.text);
		},
		put: (n, text, key) => {
			const list = all.get(n) ?? [];
			if (!list.some((r) => r.key === key)) all.set(n, [...list, { text, key }]);
		},
	};
}

function adapter(options: { pending?: PendingReplies; allowed?: string[]; waitMs?: number; maxWaits?: number } = {}) {
	return new PhoneAdapter({
		credentials: { accountSid: ACCOUNT, authToken: AUTH, number: NUMBER, numberSid: NUMBER_SID, pin: PIN },
		tenantId: "default",
		instanceId: "owni",
		publicUrl: "https://owni.example.it",
		pending: options.pending ?? memoryPending(),
		mayCall: async (n) => (options.allowed ?? [CALLER]).includes(n),
		voice: "Polly.Bianca",
		waitMs: options.waitMs ?? 50,
		maxWaits: options.maxWaits ?? 3,
	});
}

const call = (extra: Record<string, string> = {}) => new URLSearchParams({ CallSid: SID, AccountSid: ACCOUNT, From: CALLER, To: NUMBER, ...extra });
const q = (s: string) => new URLSearchParams(s);
const out = (text: string, key = "k") => ({ tenantId: "default", instanceId: "owni", channel: "phone", threadId: CALLER, text, idempotencyKey: key });

/** A call through the code, ready to talk. */
async function answered(phone: PhoneAdapter, sid = SID): Promise<string> {
	await phone.handle(q(""), call({ CallSid: sid }));
	return phone.handle(q("step=code"), call({ CallSid: sid, Digits: PIN }));
}

describe("Phone adapter", () => {
	it("takes only webhooks Twilio signed over our address and the parameters, with or without the default port", () => {
		const phone = adapter();
		const url = phone.hookUrl("?step=heard&turn=1");
		const params = { CallSid: SID, From: CALLER, SpeechResult: "ciao" };
		const body = new URLSearchParams(params);
		expect(phone.signed(url, body, twilioSign(url, params))).toBe(true);
		expect(phone.signed(url, body, twilioSign("https://owni.example.it:443/hooks/phone/owni?step=heard&turn=1", params))).toBe(true);
		expect(phone.signed(url, body, twilioSign(url, params, "f".repeat(32)))).toBe(false);
		expect(phone.signed(`${url}x`, body, twilioSign(url, params))).toBe(false);
		expect(phone.signed(url, new URLSearchParams({ ...params, SpeechResult: "altro" }), twilioSign(url, params))).toBe(false);
		expect(phone.signed(url, body, undefined)).toBe(false);
	});

	it("refuses numbers not in the list, calls to another number or account, and a start sent twice", async () => {
		const phone = adapter();
		expect(await phone.handle(q(""), call({ From: "+390000000000" }))).toContain("<Reject/>");
		expect(await phone.handle(q(""), call({ From: "anonymous" }))).toContain("<Reject/>");
		expect(await phone.handle(q(""), call({ To: "+390699999999" }))).toContain("<Reject/>");
		expect(await phone.handle(q(""), call({ AccountSid: `AC${"2".repeat(32)}` }))).toContain("<Reject/>");
		expect(await phone.handle(q(""), call())).toContain('<Gather input="dtmf"');
		expect(await phone.handle(q(""), call())).toContain("<Reject/>");
	});

	it("nothing is said or heard before the code; three wrong codes hang up", async () => {
		const pending = memoryPending();
		pending.put(CALLER, "Una risposta privata.", "p");
		const phone = adapter({ pending });
		const inbound: InboundMessage[] = [];
		phone.onInbound(async (m) => void inbound.push(m));
		const hello = await phone.handle(q(""), call());
		expect(hello).not.toContain("privata");
		expect(await phone.handle(q("step=heard&turn=1"), call({ SpeechResult: "dimmi tutto" }))).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
		expect(await phone.handle(q("step=heard&turn=1"), call({ CallSid: SID2, SpeechResult: "dimmi tutto" }))).toContain("<Hangup/>");
		expect(inbound).toHaveLength(0);
		expect(await phone.handle(q("step=code"), call({ Digits: "0000" }))).toContain("Codice sbagliato. Riprova");
		expect(await phone.handle(q("step=code"), call({ Digits: "48211" }))).toContain("Codice sbagliato. Riprova");
		const third = await phone.handle(q("step=code"), call({ Digits: "1234" }));
		expect(third).toContain("<Hangup/>");
		expect(third).not.toContain("<Gather");
		// The right code after the third wrong one opens nothing.
		expect(await phone.handle(q("step=code"), call({ Digits: PIN }))).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
		expect(pending.all.get(CALLER)).toHaveLength(1);
	});

	it("with the code: the reply kept for the caller, then a phrase goes to Owni and her reply is spoken", async () => {
		const pending = memoryPending();
		pending.put(CALLER, "Ecco il riassunto.", "p");
		const phone = adapter({ pending, waitMs: 2_000 });
		const greeting = await answered(phone);
		expect(greeting).toContain("Ti avevo lasciato una risposta.</Say><Say language=\"it-IT\" voice=\"Polly.Bianca\">Ecco il riassunto.");
		expect(greeting).toContain('<Gather input="speech" language="it-IT"');
		expect(greeting).toContain("step=heard&amp;turn=1");
		const inbound: InboundMessage[] = [];
		phone.onInbound(async (m) => {
			inbound.push(m);
			setTimeout(() => void phone.send(out("**Domani** piove, vedi [qui](https://meteo.it).")), 20);
		});
		const xml = await phone.handle(q("step=heard&turn=1"), call({ SpeechResult: "Che tempo fa domani?" }));
		expect(inbound).toEqual([expect.objectContaining({ channel: "phone", threadId: CALLER, userId: CALLER, privateThread: true, messageId: `${SID}:1` })]);
		expect(inbound[0]?.text).toBe(`Che tempo fa domani?${PHONE_NOTE}`);
		expect(xml).toContain("Domani piove, vedi qui.");
		expect(xml).toContain("turn=2");
	});

	it("a slow reply: «un momento», Twilio comes back, and after the last wait the call ends with the reply kept", async () => {
		const pending = memoryPending();
		const phone = adapter({ pending, maxWaits: 2 });
		phone.onInbound(async () => {});
		await answered(phone);
		const first = await phone.handle(q("step=heard&turn=1"), call({ SpeechResult: "Fammi un riassunto" }));
		expect(first).toContain("Un momento.");
		expect(first).toContain('<Redirect method="POST">https://owni.example.it/hooks/phone/owni?step=wait&amp;turn=1&amp;n=1</Redirect>');
		const last = await phone.handle(q("step=wait&turn=1&n=1"), call());
		expect(last).toContain("Richiamami");
		expect(last).toContain("<Hangup/>");
		// The reply that comes after is kept, once even if sent again, and said when the person calls again.
		await phone.send(out("Ecco il riassunto.", "d1"));
		await phone.send(out("Ecco il riassunto.", "d1"));
		const again = await answered(phone, SID2);
		expect(again.match(/Ecco il riassunto/g)).toHaveLength(1);
		expect(pending.all.size).toBe(0);
	});

	it("a late reply is said first, as such, before the answer to the new question", async () => {
		const phone = adapter({ waitMs: 2_000 });
		await answered(phone);
		await phone.send(out("La risposta di prima.", "d1"));
		phone.onInbound(async () => void setTimeout(() => void phone.send(out("La risposta nuova.", "d2")), 20));
		const xml = await phone.handle(q("step=heard&turn=2"), call({ SpeechResult: "E adesso?" }));
		expect(xml.indexOf("Prima, su quello che mi avevi chiesto")).toBeLessThan(xml.indexOf("La risposta di prima."));
		expect(xml.indexOf("La risposta di prima.")).toBeLessThan(xml.indexOf("La risposta nuova."));
	});

	it("a caller who hangs up during the wait leaves the reply for the next call", async () => {
		const pending = memoryPending();
		const phone = adapter({ pending, waitMs: 2_000 });
		phone.onInbound(async () => {});
		await answered(phone);
		const gone = new AbortController();
		const waiting = phone.handle(q("step=heard&turn=1"), call({ SpeechResult: "Una domanda lunga" }), gone.signal);
		await new Promise((r) => setTimeout(r, 20));
		gone.abort();
		await waiting;
		await phone.send(out("La risposta.", "d1"));
		expect(pending.all.get(CALLER)?.map((r) => r.text)).toEqual(["La risposta."]);
	});

	it("a file is named, not read, and does not count as the answer", async () => {
		const pending = memoryPending();
		const phone = adapter({ pending });
		await phone.sendFile({ tenantId: "default", instanceId: "owni", channel: "phone", threadId: CALLER, name: "q3_summary.pdf", data: new Uint8Array([1]), path: "out/q3_summary.pdf", idempotencyKey: "f" });
		expect(pending.all.get(CALLER)?.[0]?.text).toBe("Ti ho preparato un file, q3 summary: lo trovi nella console, fra i file.");
	});

	it("a message the core refuses ends the call with a word, instead of a wait that never ends", async () => {
		const phone = adapter();
		expect(phone.surfacesRefusals).toBe(true);
		phone.onInbound(async () => {
			throw new Error("channel not allowed");
		});
		await answered(phone);
		const xml = await phone.handle(q("step=heard&turn=1"), call({ SpeechResult: "ciao Owni, una cosa" }));
		expect(xml).toContain("Ora non posso risponderti");
		expect(xml).toContain("<Hangup/>");
	});

	it("silence asks again then says goodbye, a goodbye hangs up, a send to something that is not a number is refused", async () => {
		const phone = adapter();
		phone.onInbound(async () => {
			throw new Error("should not be called");
		});
		await answered(phone);
		const again = await phone.handle(q("step=heard&turn=2"), call({ SpeechResult: "  " }));
		expect(again).toContain("Puoi ripetere?");
		expect(again).toContain("quiet=1");
		expect(again).toContain('actionOnEmptyResult="true"');
		expect(await phone.handle(q("step=heard&turn=2&quiet=1"), call())).toContain("Non ti sento più. Ciao!</Say><Hangup/></Response>");
		const bye = await phone.handle(q("step=heard&turn=2"), call({ SpeechResult: "Grazie, ciao." }));
		expect(bye).toContain("<Hangup/>");
		expect(bye).not.toContain("<Gather");
		await expect(phone.send({ ...out("x"), threadId: "web:1" })).rejects.toBeInstanceOf(ChannelRefused);
	});

	it("speech has no markup, no addresses, no XML from the reply, and one turn stays under Twilio's limit", async () => {
		expect(spoken("# Titolo\n- uno\n- due `x` https://a.it/b?c=1\n> citato")).toBe("Titolo uno due x un link citato");
		expect(spoken("Ecco:\n```js\nrm -rf /\n```")).not.toContain("rm");
		expect(spoken("a ".repeat(2000)).length).toBeLessThan(1600);
		const pending = memoryPending();
		for (let i = 0; i < 5; i++) pending.put(CALLER, `${i} ${"parola ".repeat(300)}`, `p${i}`);
		const phone = adapter({ pending, waitMs: 1_000 });
		const greeting = await answered(phone);
		for (const said of greeting.match(/<Say[^>]*>[^<]*<\/Say>/g) ?? []) expect(said.length).toBeLessThan(4096);
		expect(greeting.replace(/<[^>]+>/g, "").length).toBeLessThan(3800);
		expect(greeting).toContain("chiedimelo per iscritto");
		phone.onInbound(async () => void phone.send(out('</Say><Dial>+391</Dial> & "x"', "x")));
		const xml = await phone.handle(q("step=heard&turn=1"), call({ SpeechResult: "prova" }));
		expect(xml).not.toContain("<Dial>");
		expect(xml).toContain("&lt;/Say&gt;");
	});
});

/** Twilio's REST API for numbers, as a fetch. */
function fakeTwilio() {
	const calls: { method: string; url: string; auth: string; body: string }[] = [];
	const fn = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push({ method: init?.method ?? "GET", url, auth: String((init?.headers as Record<string, string>)?.authorization ?? ""), body: String(init?.body ?? "") });
		const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		if ((init?.headers as Record<string, string>)?.authorization !== `Basic ${Buffer.from(`${ACCOUNT}:${AUTH}`).toString("base64")}`) return json(401, { message: "Authenticate" });
		if (url.includes("/IncomingPhoneNumbers.json?PhoneNumber=")) {
			const asked = decodeURIComponent(url.split("PhoneNumber=")[1] ?? "");
			return json(200, { incoming_phone_numbers: asked === NUMBER ? [{ sid: NUMBER_SID }] : [] });
		}
		if (url.endsWith(`/IncomingPhoneNumbers/${NUMBER_SID}.json`) && init?.method === "POST") return json(200, { sid: NUMBER_SID });
		return json(404, { message: "Not found" });
	}) as typeof fetch;
	return { fn, calls };
}

describe("connectTwilioNumber", () => {
	it("finds the number in the account and points its calls at the cell", async () => {
		const twilio = fakeTwilio();
		expect(await connectTwilioNumber({ accountSid: ACCOUNT, authToken: AUTH, number: NUMBER, voiceUrl: "https://owni.example.it/hooks/phone/owni", fetch: twilio.fn })).toEqual({ numberSid: NUMBER_SID });
		const set = twilio.calls.at(-1);
		expect(set?.method).toBe("POST");
		expect(new URLSearchParams(set?.body)).toEqual(new URLSearchParams({ VoiceUrl: "https://owni.example.it/hooks/phone/owni", VoiceMethod: "POST" }));
		await expect(connectTwilioNumber({ accountSid: ACCOUNT, authToken: "f".repeat(32), number: NUMBER, voiceUrl: "x", fetch: twilio.fn })).rejects.toBeInstanceOf(ChannelRefused);
		await expect(connectTwilioNumber({ accountSid: ACCOUNT, authToken: AUTH, number: "+390699999999", voiceUrl: "x", fetch: twilio.fn })).rejects.toThrow("non è nell'account");
	});
});

describe("Phone in an instance", () => {
	async function boot(publicUrl = "https://owni.example.it", dataDir = tempDataDir(), session?: string) {
		const twilio = fakeTwilio();
		const config = loadOwniConfig({ OWNI_DATA_DIR: dataDir, OWNI_MODEL_PROVIDER: "faux", OWNI_WEB_PORT: "1", OWNI_PUBLIC_URL: publicUrl });
		const owni: RunningOwni = await startOwni({ ...config, web: { ...config.web, port: 0 } }, { phoneFetch: twilio.fn, phoneWait: { ms: 1_500, max: 3 }, schedulerIntervalMs: 60_000, log: () => {} });
		let stopped = false;
		const stop = async () => {
			if (!stopped) await owni.stop();
			stopped = true;
		};
		closers.push(stop);
		const base = `http://127.0.0.1:${(owni.server.address() as AddressInfo).port}`;
		// After a restart there is no new owner link: the session from before still holds.
		const cookie =
			session ??
			((
				await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token: (owni.ownerLink as string).split("#")[1] }) })
			).headers.get("set-cookie") ?? "").split(";")[0] as string;
		const api = async (path: string, body?: unknown, method?: string, as = cookie) => {
			const res = await fetch(`${base}${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie: as, "x-owni": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
			return { status: res.status, ...((await res.json()) as any) };
		};
		const hook = async (query: string, params: Record<string, string>, signature?: string) => {
			const res = await fetch(`${base}/hooks/phone/owni${query}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature ?? twilioSign(`${publicUrl}/hooks/phone/owni${query}`, params) }, body: new URLSearchParams(params).toString() });
			return { status: res.status, text: await res.text() };
		};
		return { api, hook, twilio, dataDir, stop, cookie };
	}
	const start = (sid = SID) => ({ CallSid: sid, AccountSid: ACCOUNT, From: CALLER, To: NUMBER });

	it("the owner connects a number; allowed callers talk to Owni after the code, strangers are rejected, forged webhooks refused", async () => {
		const { api, hook, twilio, dataDir, stop, cookie } = await boot();
		expect((await api("/api/instances/owni/phone")).phone).toMatchObject({ connected: false, https: true, allowedUsers: [] });
		expect((await api("/api/instances/owni/phone", { accountSid: ACCOUNT, authToken: AUTH, number: NUMBER }, "PUT")).status).toBe(400);
		expect((await api("/api/instances/owni/phone", { accountSid: ACCOUNT, authToken: AUTH, number: "0612345678", pin: PIN }, "PUT")).status).toBe(400);
		expect((await api("/api/instances/owni/phone", { accountSid: ACCOUNT, authToken: AUTH, number: NUMBER, pin: "12" }, "PUT")).status).toBe(400);
		expect((await api("/api/instances/owni/phone", { accountSid: ACCOUNT, authToken: "f".repeat(32), number: NUMBER, pin: PIN }, "PUT")).status).toBe(400);
		expect((await api("/api/instances/owni/phone", { allowedUsers: ["393331234567"] }, "PUT")).status).toBe(400);
		const connected = await api("/api/instances/owni/phone", { accountSid: ACCOUNT, authToken: AUTH, number: NUMBER, pin: PIN, allowedUsers: [CALLER] }, "PUT");
		expect(connected.phone).toMatchObject({ connected: true, number: NUMBER, accountSid: ACCOUNT, allowedUsers: [CALLER] });
		expect(JSON.stringify(connected)).not.toContain(AUTH);
		expect(JSON.stringify(connected)).not.toContain(PIN);
		expect(new URLSearchParams(twilio.calls.at(-1)?.body).get("VoiceUrl")).toBe("https://owni.example.it/hooks/phone/owni");
		// Saving only the list, or only the code, does not call Twilio.
		const before = twilio.calls.length;
		expect((await api("/api/instances/owni/phone", { allowedUsers: [CALLER, "+393479876543"] }, "PUT")).phone.allowedUsers).toHaveLength(2);
		expect((await api("/api/instances/owni/phone", { pin: PIN }, "PUT")).status).toBe(200);
		expect(twilio.calls).toHaveLength(before);

		expect((await hook("", start(), "forged")).status).toBe(403);
		expect((await hook("", { ...start(), From: "+390000000000" })).text).toContain("<Reject/>");
		expect((await hook("", start())).text).toContain("Digita il tuo codice");
		expect((await hook("?step=code", { ...start(), Digits: PIN })).text).toContain("Dimmi pure.");
		const heard = await hook("?step=heard&turn=1", { ...start(), SpeechResult: "ciao dal telefono" });
		expect(heard.status).toBe(200);
		expect(heard.text).toContain("ciao dal telefono");
		expect(heard.text).toContain("<Gather");
		// The same phrase sent again by Twilio reaches Owni once: no second answer comes.
		const twice = await hook("?step=heard&turn=1", { ...start(), SpeechResult: "ciao dal telefono" });
		expect(twice.text).toContain("Un momento.");

		// Only the owner.
		expect((await api("/api/instances/owni/phone", undefined, "GET", "")).status).toBe(401);
		expect((await api("/api/instances/nessuna/phone", undefined, "DELETE")).status).toBe(404);

		// After a restart the number answers again, and is pointed at this cell again.
		await stop();
		const again = await boot("https://owni.example.it", dataDir, cookie);
		for (const t = Date.now(); !again.twilio.calls.some((c) => c.method === "POST") && Date.now() - t < 5_000; ) await new Promise((r) => setTimeout(r, 20));
		expect(again.twilio.calls.some((c) => c.method === "POST")).toBe(true);
		expect((await again.hook("", start(SID2))).text).toContain("Digita il tuo codice");

		// Disconnected: the number still points here, and its calls are refused before they are answered.
		expect((await again.api("/api/instances/owni/phone", undefined, "DELETE")).status).toBe(200);
		expect((await again.api("/api/instances/owni/phone")).phone.connected).toBe(false);
		expect((await again.hook("", start(`CA${"5".repeat(32)}`))).text).toContain("<Reject/>");
	}, 30_000);

	it("a reminder cannot be set on a call: Owni never calls first", async () => {
		const store = { create: async () => expect.unreachable("no schedule on the phone") } as unknown as ScheduleStore;
		const create = createScheduleTools({ store, defaultTimeZone: "Europe/Rome" }).find((t) => t.name === "schedule_create");
		const ctx = { thread: { channel: "phone", threadId: CALLER }, step: (_: string, run: () => Promise<unknown>) => run() } as unknown as Parameters<NonNullable<typeof create>["execute"]>[1];
		expect(await create?.execute({ instruction: "Ricordami la riunione", at: "2030-01-01T09:00:00+01:00" }, ctx)).toContain("al telefono non posso programmare");
		expect(schedulePerson({ channel: "phone", threadId: CALLER, createdBy: { kind: "instance" } } as unknown as Schedule)).toEqual({ channel: "phone", userId: CALLER });
	});

	it("without a public https address the number cannot be connected", async () => {
		const { api } = await boot("http://owni.example.it");
		expect((await api("/api/instances/owni/phone")).phone.https).toBe(false);
		const res = await api("/api/instances/owni/phone", { accountSid: ACCOUNT, authToken: AUTH, number: NUMBER, pin: PIN }, "PUT");
		expect([res.status, res.error]).toEqual([400, expect.stringContaining("https")]);
	});
});
