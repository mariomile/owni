import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningOwni, startOwni } from "../src/app.ts";
import { isOggOpus, MAX_AUDIO_BYTES, REST_WRITTEN, SpeechRefused, speakable, speaker, spokenPart, VoicePreferences } from "../src/channels/speech.ts";
import { TelegramAdapter } from "../src/channels/telegram.ts";
import { WhatsAppAdapter } from "../src/channels/whatsapp.ts";
import { ConfigError, loadOwniConfig } from "../src/main/config.ts";
import { runChecks } from "../src/main/check.ts";
import { tempDataDir } from "./helpers.ts";

const KEY = "speech-key-0123456789";
/** The first page of an OGG Opus file, and a little more: what a speech service answers. */
const OGG = (() => {
	const page = new Uint8Array(48);
	page.set([..."OggS"].map((c) => c.charCodeAt(0)), 0);
	page.set([..."OpusHead"].map((c) => c.charCodeAt(0)), 28);
	return page;
})();
const VORBIS = (() => {
	const page = OGG.slice();
	page.set([..."\x01vorbis\0"].map((c) => c.charCodeAt(0)), 28);
	return page;
})();

/** A speech service: what it was asked, recorded; what it answers set per test. */
function fakeSpeech(answer: () => Response = () => new Response(OGG, { headers: { "content-type": "audio/ogg" } })) {
	const asked: { url: string; auth: string; body: { model: string; input: string; voice: string; response_format: string } }[] = [];
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		asked.push({ url: String(url), auth: String((init?.headers as Record<string, string>).authorization), body: JSON.parse(String(init?.body)) });
		return answer();
	}) as typeof fetch;
	return { asked, fetch: fetchImpl };
}

const config = { url: "https://api.openai.com/v1", apiKey: KEY, model: "gpt-4o-mini-tts", voice: "nova", maxChars: 200, maxPerDay: 10 };

describe("replies as voice notes", () => {
	it("asks the service for Opus with the spoken text, and returns the audio", async () => {
		const service = fakeSpeech();
		const audio = await speaker(config, service.fetch)("**Ciao!** Ecco il [sito](https://comune.roma.it) e https://x.it/a?b=1");
		expect(audio).toEqual(OGG);
		expect(service.asked).toEqual([{ url: "https://api.openai.com/v1/audio/speech", auth: `Bearer ${KEY}`, body: { model: "gpt-4o-mini-tts", input: "Ciao! Ecco il sito e link", voice: "nova", response_format: "opus" } }]);
	});

	it("refuses what would not play, however it is sent, and never puts the key or the text in an error", async () => {
		await expect(speaker(config, fakeSpeech().fetch)("```\ncodice\n```")).rejects.toBeInstanceOf(SpeechRefused);
		await expect(speaker(config, fakeSpeech(() => new Response("<html>")).fetch)("Ciao")).rejects.toThrow(/not OGG Opus/);
		await expect(speaker(config, fakeSpeech(() => new Response(VORBIS)).fetch)("Ciao")).rejects.toThrow(/not OGG Opus/);
		await expect(speaker(config, fakeSpeech(() => new Response(new Uint8Array())).fetch)("Ciao")).rejects.toThrow(/not OGG Opus/);
		// Too big: by its header, or as it streams in without one.
		await expect(speaker(config, fakeSpeech(() => new Response(OGG, { headers: { "content-length": String(MAX_AUDIO_BYTES + 1) } })).fetch)("Ciao")).rejects.toThrow(/too large/);
		const endless = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(1024 * 1024));
			},
		});
		await expect(speaker(config, fakeSpeech(() => new Response(endless)).fetch)("Ciao")).rejects.toThrow(/too large/);
		const error = await speaker(config, fakeSpeech(() => Response.json({ error: { message: `Incorrect API key ${KEY}, input: Ciao segreto` } }, { status: 401 })).fetch)("Ciao segreto").catch((e: Error) => e);
		expect(String(error)).toMatch(/401/);
		expect(String(error)).not.toContain(KEY);
		expect(String(error)).not.toContain("segreto");
		expect(isOggOpus(OGG)).toBe(true);
	});

	it("a long reply: the first sentences aloud, saying the rest is written", async () => {
		const service = fakeSpeech();
		const long = `${"Questa è una frase. ".repeat(20)}Fine.`;
		await speaker(config, service.fetch)(long);
		const said = service.asked[0]?.body.input ?? "";
		expect(said.length).toBeLessThanOrEqual(200);
		expect(said.endsWith(`frase. ${REST_WRITTEN}`)).toBe(true);
		expect(spokenPart("breve", 200)).toBe("breve");
	});

	it("the speaking style goes to the service when set", async () => {
		const service = fakeSpeech();
		await speaker({ ...config, style: "Tono cordiale" }, service.fetch)("Ciao");
		expect(service.asked[0]?.body).toMatchObject({ instructions: "Tono cordiale" });
	});

	it("reads lists, headings, quotes and tables as plain sentences", () => {
		expect(speakable("# Orari\n\n- Lunedì: 9-13\n- Martedì: _chiuso_\n> nota\n1. primo\n`codice`")).toBe("Orari\nLunedì: 9-13\nMartedì: chiuso\nnota\nprimo\ncodice");
		expect(speakable("| Giorno | Ore |\n|---|---|\n| Lun | 9 |")).toBe("Giorno Ore\nLun 9");
		expect(speakable("Prezzo: 5 * 3 = 15")).toBe("Prezzo: 5 * 3 = 15");
	});

	it("each person's choice is kept, and «auto» is the default", async () => {
		const file = join(tempDataDir(), "voice-replies.json");
		const prefs = new VoicePreferences(file);
		expect(await prefs.get("telegram:7")).toBe("auto");
		await prefs.set("telegram:7", "always");
		await prefs.set("telegram:8", "never");
		expect(await new VoicePreferences(file).get("telegram:7")).toBe("always");
		await prefs.set("telegram:7", "auto");
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "telegram:8": "never" });
	});

	it("Telegram: the voice note with the text as caption; a long text follows as a message", async () => {
		const calls: { method: string; caption?: string; text?: string; type?: string }[] = [];
		const telegramFetch = (async (url: string | URL | Request, init?: RequestInit) => {
			const method = String(url).slice(String(url).lastIndexOf("/") + 1);
			if (init?.body instanceof FormData) {
				const voice = init.body.get("voice") as File;
				calls.push({ method, caption: (init.body.get("caption") as string | null) ?? undefined, type: voice.type });
			} else calls.push({ method, text: JSON.parse(String(init?.body)).text });
			return Response.json({ ok: true, result: { message_id: 1 } });
		}) as typeof fetch;
		const adapter = new TelegramAdapter({ token: "1:T", tenantId: "default", instanceId: "owni", fetch: telegramFetch });
		const base = { tenantId: "default", instanceId: "owni", channel: "telegram", threadId: "7", idempotencyKey: "k", audio: OGG };
		await adapter.sendVoice({ ...base, text: "Ciao" });
		await adapter.sendVoice({ ...base, text: "a".repeat(1100) });
		expect(calls).toEqual([
			{ method: "sendVoice", caption: "Ciao", type: "audio/ogg" },
			{ method: "sendVoice", type: "audio/ogg" },
			{ method: "sendMessage", text: "a".repeat(1100) },
		]);
		// Someone who does not take voice messages still gets the text.
		const refusing = new TelegramAdapter({
			token: "1:T",
			tenantId: "default",
			instanceId: "owni",
			fetch: (async (url: string | URL | Request, init?: RequestInit) => {
				if (String(url).endsWith("/sendVoice")) return Response.json({ ok: false, error_code: 400, description: "Bad Request: VOICE_MESSAGES_FORBIDDEN" }, { status: 400 });
				calls.push({ method: "after refusal", text: JSON.parse(String(init?.body)).text });
				return Response.json({ ok: true, result: { message_id: 1 } });
			}) as typeof fetch,
		});
		await refusing.sendVoice({ ...base, text: "Ciao" });
		expect(calls.at(-1)).toEqual({ method: "after refusal", text: "Ciao" });
	});

	it("WhatsApp: the audio, then the text; outside the 24-hour window only the text, kept for later", async () => {
		const calls: string[] = [];
		const whatsappFetch = (async (url: string | URL | Request, init?: RequestInit) => {
			const path = new URL(String(url)).pathname;
			if (init?.body instanceof FormData) {
				if (refuseUpload) return Response.json({ error: { message: "Unsupported audio", code: 131053 } }, { status: 400 });
				calls.push(`upload ${(init.body.get("file") as File).type}`);
				return Response.json({ id: "media-1" });
			}
			const body = JSON.parse(String(init?.body));
			calls.push(`${path} ${body.type} ${body.type === "audio" ? body.audio.id : body.text.body}`);
			return Response.json({ messages: [{ id: "x" }] });
		}) as typeof fetch;
		let last = Date.now();
		let refuseUpload = false;
		const parked: string[] = [];
		const adapter = new WhatsAppAdapter({
			accessToken: "EAAGtoken",
			phoneNumberId: "1110001",
			appSecret: "a".repeat(32),
			verifyToken: "v",
			tenantId: "default",
			instanceId: "owni",
			fetch: whatsappFetch,
			apiBase: "https://graph.example",
			window: { lastInbound: async () => last, seen: async () => {}, park: async (_n, m) => (parked.push(m.text), { notify: false, dropped: 0 }), waiting: async () => [], delivered: async () => {}, failed: async () => {} },
		});
		const base = { tenantId: "default", instanceId: "owni", channel: "whatsapp", threadId: "393331234567", idempotencyKey: "k", audio: OGG };
		await adapter.sendVoice({ ...base, text: "Ciao" });
		expect(calls).toEqual(["upload audio/ogg", "/1110001/messages audio media-1", "/1110001/messages text Ciao"]);
		calls.length = 0;
		last = Date.now() - 25 * 3600_000;
		await adapter.sendVoice({ ...base, text: "Più tardi" });
		expect(calls).toEqual([]);
		expect(parked).toEqual(["Più tardi"]);
		// Meta refusing the audio still delivers the text.
		last = Date.now();
		refuseUpload = true;
		await adapter.sendVoice({ ...base, text: "Solo testo" });
		expect(calls).toEqual(["/1110001/messages text Solo testo"]);
	});

	it("configuration: both or neither; OpenAI's model and voice by default; pnpm owni check asks the service", async () => {
		const base = { OWNI_DATA_DIR: "/tmp/x", OWNI_MODEL_PROVIDER: "faux" };
		expect(loadOwniConfig(base).speech).toBeUndefined();
		expect(() => loadOwniConfig({ ...base, OWNI_SPEECH_URL: "https://api.openai.com/v1" })).toThrow(ConfigError);
		expect(() => loadOwniConfig({ ...base, OWNI_SPEECH_URL: "http://example.com/v1", OWNI_SPEECH_API_KEY: KEY })).toThrow(/https/);
		expect(() => loadOwniConfig({ ...base, OWNI_SPEECH_URL: "https://tts.example.com/v1", OWNI_SPEECH_API_KEY: KEY })).toThrow(/OWNI_SPEECH_MODEL/);
		expect(() => loadOwniConfig({ ...base, OWNI_SPEECH_URL: "https://tts.example.com/v1", OWNI_SPEECH_API_KEY: KEY, OWNI_SPEECH_MODEL: "kokoro" })).toThrow(/OWNI_SPEECH_VOICE/);
		expect(() => loadOwniConfig({ ...base, OWNI_SPEECH_URL: "https://api.openai.com/v1", OWNI_SPEECH_API_KEY: KEY, OWNI_SPEECH_MAX_CHARS: "5" })).toThrow(/MAX_CHARS/);
		const loaded = loadOwniConfig({ ...base, OWNI_SPEECH_URL: "https://api.openai.com/v1/", OWNI_SPEECH_API_KEY: KEY });
		expect(loaded.speech).toEqual({ url: "https://api.openai.com/v1", apiKey: KEY, model: "gpt-4o-mini-tts", voice: "nova", maxChars: 1500, maxPerDay: 300 });
		expect(() => loadOwniConfig({ ...base, OWNI_SPEECH_URL: "https://api.openai.com/v1", OWNI_SPEECH_API_KEY: KEY, OWNI_SPEECH_MAX_PER_DAY: "0" })).toThrow(/MAX_PER_DAY/);
		const asked: string[] = [];
		const results = await runChecks(loaded, (async (url: string | URL | Request) => {
			asked.push(String(url));
			return Response.json({ data: [] });
		}) as typeof fetch);
		expect(results.find((r) => r.name === "Risposte a voce")).toEqual({ name: "Risposte a voce", ok: true, detail: "chiave valida (modello gpt-4o-mini-tts e voce nova non verificati: prova un vocale)" });
		expect(asked).toContain("https://api.openai.com/v1/models");
	});
});

describe("in an instance", () => {
	const running: RunningOwni[] = [];
	afterEach(async () => {
		for (const a of running.splice(0)) await a.stop();
	});

	it("off until the owner allows it; then a voice note gets a voice note back, a written message gets text; a failure leaves the text", async () => {
		const updates: unknown[][] = [];
		const sent: { method: string; text?: string; caption?: string }[] = [];
		const telegramFetch = (async (url: string | URL | Request, init?: RequestInit) => {
			const href = String(url);
			if (href.includes("/file/bot")) return new Response(new Uint8Array([9, 9]));
			const method = href.slice(href.lastIndexOf("/") + 1);
			if (method === "getMe") return Response.json({ ok: true, result: { username: "owni_bot" } });
			if (method === "getUpdates") {
				const batch = updates.shift();
				if (batch === undefined) await new Promise((r) => setTimeout(r, 20));
				return Response.json({ ok: true, result: batch ?? [] });
			}
			if (method === "getFile") return Response.json({ ok: true, result: { file_path: "voice/v.oga" } });
			if (method === "sendVoice" && busyOnce) {
				busyOnce = false;
				return Response.json({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } }, { status: 429 });
			}
			if (init?.body instanceof FormData) sent.push({ method, caption: (init.body.get("caption") as string | null) ?? undefined });
			else if (method === "sendMessage") sent.push({ method, text: JSON.parse(String(init?.body)).text });
			return Response.json({ ok: true, result: { message_id: 1 } });
		}) as typeof fetch;
		let failing = false;
		let busyOnce = false;
		const speech = fakeSpeech(() => (failing ? Response.json({ error: "busy" }, { status: 503 }) : new Response(OGG)));
		const transcribeFetch = (async () => Response.json({ text: "che ore sono" })) as typeof fetch;
		const dataDir = tempDataDir();
		const loaded = loadOwniConfig({
			OWNI_DATA_DIR: dataDir,
			OWNI_MODEL_PROVIDER: "faux",
			OWNI_WEB_PORT: "1",
			TELEGRAM_BOT_TOKEN: "1:T",
			OWNI_TELEGRAM_ALLOWED_USERS: "7",
			OWNI_TRANSCRIBE_URL: "https://api.mistral.ai/v1",
			OWNI_TRANSCRIBE_API_KEY: "transcribe-key-0123456789",
			OWNI_SPEECH_URL: "https://api.openai.com/v1",
			OWNI_SPEECH_API_KEY: KEY,
		});
		const owni = await startOwni({ ...loaded, web: { ...loaded.web, port: 0 } }, { telegramFetch, transcribeFetch, speechFetch: speech.fetch, schedulerIntervalMs: 60_000, log: () => {} });
		running.push(owni);
		const base = `http://127.0.0.1:${(owni.server.address() as AddressInfo).port}`;
		const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token: (owni.ownerLink as string).split("#")[1] }) });
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
		// biome-ignore lint: test
		const api = async (path: string, body?: unknown): Promise<any> => (await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "PUT", headers: { cookie, "x-owni": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json();
		expect(await api("/api/speech")).toEqual({ available: true, host: "api.openai.com", voice: "nova" });
		expect(await api("/api/instances/owni/voice", { allowed: true })).toEqual({ allowed: true });
		let id = 0;
		const voiceNote = () => updates.push([{ update_id: ++id, message: { message_id: id, chat: { id: 7, type: "private" }, from: { id: 7 }, voice: { file_id: `v${id}`, duration: 3, mime_type: "audio/ogg" } } }]);
		const written = (text: string) => updates.push([{ update_id: ++id, message: { message_id: id, chat: { id: 7, type: "private" }, from: { id: 7 }, text } }]);
		const replies = async (n: number) => {
			for (const start = Date.now(); sent.length < n && Date.now() - start < 10_000; ) await new Promise((r) => setTimeout(r, 30));
			return sent.splice(0);
		};
		// Off: a voice note gets text, and nothing goes to the speech service.
		voiceNote();
		expect((await replies(1)).map((s) => s.method)).toEqual(["sendMessage"]);
		expect(speech.asked).toHaveLength(0);
		expect(await api("/api/instances/owni/speech", { allowed: true })).toEqual({ allowed: true });
		voiceNote();
		const spoken = await replies(1);
		expect(spoken).toEqual([{ method: "sendVoice", caption: expect.stringContaining("che ore sono") }]);
		expect(speech.asked).toHaveLength(1);
		expect(speech.asked[0]?.body.input).toContain("che ore sono");
		// The model was told its reply would be read aloud (the development model repeats what it got).
		expect(spoken[0]?.caption).toContain("arriverà come messaggio vocale");
		written("Grazie");
		expect((await replies(1)).map((s) => s.method)).toEqual(["sendMessage"]);
		// What Owni sends by herself in that chat is not read aloud.
		voiceNote();
		await replies(1);
		await owni.runtime.sendMessage("default", "owni", { channel: "telegram", threadId: "7", text: "Promemoria: chiama Rossi", key: "r1" });
		expect(await replies(1)).toEqual([{ method: "sendMessage", text: "Promemoria: chiama Rossi" }]);
		// The person asks for voice always, then never.
		written('/tool voice_replies {"mode":"always"}');
		expect((await replies(1))[0]?.text).toContain("rispondo sempre anche con un vocale");
		written("Ciao");
		expect((await replies(1)).map((s) => s.method)).toEqual(["sendVoice"]);
		written('/tool voice_replies {"mode":"never"}');
		await replies(1);
		voiceNote();
		expect((await replies(1)).map((s) => s.method)).toEqual(["sendMessage"]);
		written('/tool voice_replies {"mode":"auto"}');
		await replies(1);
		// The service failing leaves the text.
		failing = true;
		voiceNote();
		expect(await replies(1)).toEqual([{ method: "sendMessage", text: expect.stringContaining("che ore sono") }]);
		failing = false;
		// Telegram busy on the voice note: the retry sends the text alone, without making the audio again.
		busyOnce = true;
		const before = speech.asked.length;
		voiceNote();
		expect(await replies(1)).toEqual([{ method: "sendMessage", text: expect.stringContaining("che ore sono") }]);
		expect(speech.asked.length).toBe(before + 1);
		// In a group, a voice note is answered in writing.
		await owni.runtime.registry.setAllowedUsers("default", "owni", "telegram", ["7"]);
		updates.push([{ update_id: ++id, message: { message_id: id, chat: { id: -100, type: "group" }, from: { id: 7 }, voice: { file_id: "g", duration: 3, mime_type: "audio/ogg" } } }]);
		expect((await replies(1)).map((s) => s.method)).toEqual(["sendMessage"]);
		expect(readFileSync(join(dataDir, "tenants", "default", "audit.jsonl"), "utf8")).toContain('"type":"speech.allowed"');
	}, 30_000);
});
