import { createHmac, timingSafeEqual } from "node:crypto";
import { ChannelRefused, type ChannelAdapter, type InboundMessage, type OutboundFile, type OutboundMessage } from "./types.ts";

/**
 * Phone calls on a Twilio number, one turn at a time (ADR 0012): Twilio turns speech into text
 * (<Gather input="speech">) and text into speech (<Say>), the cell only sees text in webhooks.
 * A conversation is the caller's number. Replies are kept aside (on disk, through `pending`)
 * and spoken as soon as they are ready, or at the start of the next call.
 */
export type PhoneCredentials = {
	readonly accountSid: string;
	readonly authToken: string;
	/** E.164, e.g. +390612345678. */
	readonly number: string;
	readonly numberSid: string;
	/** Digits typed on the keypad at the start of every call: caller ID alone can be faked. */
	readonly pin: string;
};

/** Replies waiting to be spoken, per caller number. `key` keeps a reply sent again from being said twice. */
export type PendingReplies = {
	take(number: string): string[];
	put(number: string, text: string, key: string): void;
};

export type PhoneOptions = {
	readonly credentials: PhoneCredentials;
	readonly tenantId: string;
	readonly instanceId: string;
	/** The cell's public https address: Twilio is sent here and signs these URLs. */
	readonly publicUrl: string;
	readonly pending: PendingReplies;
	/** May this number call? (the instance's allowlist for "phone"). */
	readonly mayCall: (number: string) => Promise<boolean>;
	/** Twilio's voice for the replies, e.g. Polly.Bianca. Everything Owni says on the phone is Italian. */
	readonly voice?: string;
	readonly log?: (message: string) => void;
	/** Tests: how long one webhook waits for a reply, and how many waits before giving up. */
	readonly waitMs?: number;
	readonly maxWaits?: number;
};

export const PHONE_NUMBER = /^\+[1-9]\d{6,14}$/;
export const PHONE_PIN = /^\d{4,8}$/;
export const PHONE_VOICE = /^[A-Za-z]+\.[\w-]+$/;
const LANGUAGE = "it-IT";
const PIN_TRIES = 3;
/** Wrong codes on this number, across calls, before it takes none for an hour: a caller ID can be faked, and a short code guessed one call at a time. */
const WRONG_PER_HOUR = 10;
/** Calls remembered (to refuse a replayed start): two hours, at most this many. */
const CALLS_KEPT = 1000;
/** Webhooks that may wait on one number's reply at once. */
const WAITERS_PER_NUMBER = 2;
const MAX_SPOKEN = 1500;
/** All that is said in one answer: Twilio reads at most 4096 characters per <Say>. */
const MAX_TURN = 3500;
const GOODBYE = /^(ciao|ciao ciao|grazie,? ciao|basta|fine|arrivederci|a dopo)[.!]?$/i;
/** Told to the model with every phrase heard: it writes for the ear, and knows what the phone cannot do. */
export const PHONE_NOTE =
	"\n\n[Al telefono: la risposta viene letta ad alta voce. Rispondi breve e parlato, senza elenchi, tabelle, link o codice. Qui non arrivano schede di approvazione né file: se servono, di' che arrivano su un altro canale o nella console. Al telefono non puoi programmare promemoria.]";

export class PhoneAdapter implements ChannelAdapter {
	readonly name = "phone";
	/** A message the core refuses is said to the caller, not left to a wait that never ends. */
	readonly surfacesRefusals = true;
	private handler: ((message: InboundMessage) => Promise<void>) | undefined;
	private readonly waiters = new Map<string, Set<() => void>>();
	/** Calls seen, by CallSid: whether the code was typed, and how many times it was wrong. */
	private readonly calls = new Map<string, { at: number; authed: boolean; tries: number }>();
	/** When the last wrong codes were typed, on any call. */
	private wrong: number[] = [];

	constructor(private readonly options: PhoneOptions) {}

	async start(): Promise<void> {}

	async stop(): Promise<void> {
		for (const set of this.waiters.values()) for (const wake of set) wake();
		this.waiters.clear();
	}

	onInbound(handler: (message: InboundMessage) => Promise<void>): void {
		this.handler = handler;
	}

	/** Kept aside for the caller; a call waiting on it speaks it at once. */
	async send(message: OutboundMessage): Promise<void> {
		this.keep(message.threadId, message.text, message.idempotencyKey, true);
	}

	/** A file cannot be heard: the caller is told where it is. It does not answer the question, so it wakes nobody. */
	async sendFile(file: OutboundFile): Promise<void> {
		this.keep(file.threadId, `Ti ho preparato un file, ${file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ")}: lo trovi nella console, fra i file.`, file.idempotencyKey, false);
	}

	private keep(number: string, text: string, key: string, wake: boolean): void {
		if (!PHONE_NUMBER.test(number)) throw new ChannelRefused("not a phone number");
		this.options.pending.put(number, text, key);
		if (wake) for (const done of this.waiters.get(number) ?? []) done();
	}

	/** The webhook's address as Twilio called it, for the signature. */
	hookUrl(query = ""): string {
		return `${this.options.publicUrl}/hooks/phone/${this.options.instanceId}${query}`;
	}

	/** Twilio's signature: HMAC-SHA1 with the auth token over the URL and the sorted parameters. */
	signed(url: string, params: URLSearchParams, signature: string | undefined): boolean {
		if (signature === undefined) return false;
		const body = [...new Set(params.keys())]
			.sort()
			.flatMap((k) => params.getAll(k).sort().map((v) => `${k}${v}`))
			.join("");
		const given = Buffer.from(signature, "base64");
		// Twilio signs the address as it called it: with or without the default port.
		return withAndWithoutPort(url).some((u) => {
			const expected = createHmac("sha1", this.options.credentials.authToken).update(u + body).digest();
			return given.length === expected.length && timingSafeEqual(given, expected);
		});
	}

	/**
	 * One webhook: the call starting, the code typed, a phrase heard, or a wait for the reply.
	 * Answers TwiML. `signal` aborts when Twilio stops listening (the caller hung up).
	 */
	async handle(query: URLSearchParams, params: URLSearchParams, signal?: AbortSignal): Promise<string> {
		const { credentials } = this.options;
		const from = params.get("From") ?? "";
		const call = params.get("CallSid") ?? "";
		// Only calls to this number of this account: a number replaced may still point here.
		const ours = params.get("To") === credentials.number && params.get("AccountSid") === credentials.accountSid;
		if (!ours || !PHONE_NUMBER.test(from) || !/^CA[0-9a-f]{32}$/i.test(call) || !(await this.options.mayCall(from))) return twiml("<Reject/>");
		const step = query.get("step");
		const turn = Math.max(0, Math.min(1000, Number(query.get("turn") ?? 0) || 0));
		const seen = this.calls.get(call);
		if (this.locked()) {
			this.options.log?.(`phone: ${WRONG_PER_HOUR} wrong codes in an hour on ${this.options.instanceId}, calls refused for now`);
			return twiml("<Reject/>");
		}
		if (step === null) {
			// A start Twilio sends again (or someone replays) never opens a call twice.
			if (seen !== undefined) return twiml("<Reject/>");
			this.remember(call);
			return this.askCode("Ciao, sono Owni. Digita il tuo codice e poi cancelletto.");
		}
		if (seen === undefined) return twiml(`${this.say(["La chiamata è scaduta. Richiamami."])}<Hangup/>`);
		if (step === "code") {
			if (seen.authed || seen.tries >= PIN_TRIES) return twiml("<Hangup/>");
			const digits = Buffer.from((params.get("Digits") ?? "").slice(0, 16));
			const pin = Buffer.from(credentials.pin);
			if (digits.length === pin.length && timingSafeEqual(digits, pin)) {
				seen.authed = true;
				const waiting = this.options.pending.take(from);
				return this.listen(1, waiting.length > 0 ? ["Ti avevo lasciato una risposta.", ...waiting, "Dimmi pure."] : ["Dimmi pure."]);
			}
			seen.tries += 1;
			this.wrong.push(Date.now());
			this.options.log?.(`phone: wrong code on a call to ${this.options.instanceId} (${seen.tries} of ${PIN_TRIES})`);
			if (seen.tries >= PIN_TRIES) return twiml(`${this.say(["Codice sbagliato. Ciao."])}<Hangup/>`);
			return this.askCode("Codice sbagliato. Riprova, poi cancelletto.");
		}
		if (!seen.authed) return twiml("<Hangup/>");
		if (step === "heard") {
			const said = (params.get("SpeechResult") ?? "").trim().slice(0, 2000);
			// Silence once: ask again. Twice in a row: say goodbye.
			if (said === "") return query.get("quiet") === "1" ? twiml(`${this.say(["Non ti sento più. Ciao!"])}<Hangup/>`) : this.listen(turn, ["Non ho sentito. Puoi ripetere?"], true);
			if (GOODBYE.test(said)) return twiml(`${this.say(["Ciao, a presto."])}<Hangup/>`);
			if (this.handler === undefined) throw new Error("phone: no inbound handler");
			// What came in since the last answer (a late reply, a notice) is said first, so this turn's answer is not mistaken for it.
			const earlier = this.options.pending.take(from);
			try {
				// The message ID is the call and the turn: a webhook Twilio sends again is dropped by the core.
				await this.handler({ tenantId: this.options.tenantId, instanceId: this.options.instanceId, channel: this.name, threadId: from, userId: from, text: `${said}${PHONE_NOTE}`, privateThread: true, messageId: `${call}:${turn}` });
			} catch {
				return twiml(`${this.say([...earlier, "Ora non posso risponderti. Riprova più tardi."])}<Hangup/>`);
			}
			return this.reply(from, turn, 0, signal, earlier.length > 0 ? ["Prima, su quello che mi avevi chiesto:", ...earlier, "Ora la tua domanda."] : []);
		}
		if (step === "wait") return this.reply(from, turn, Math.max(0, Number(query.get("n") ?? 0) || 0), signal, []);
		return twiml("<Hangup/>");
	}

	/** What Twilio says when the cell could not answer a webhook. */
	apology(): string {
		return twiml(`${this.say(["Scusa, qualcosa non va. Riprova tra poco."])}<Hangup/>`);
	}

	private locked(): boolean {
		const hour = Date.now() - 3600_000;
		this.wrong = this.wrong.filter((at) => at > hour);
		return this.wrong.length >= WRONG_PER_HOUR;
	}

	private remember(call: string): void {
		const now = Date.now();
		for (const [sid, c] of this.calls) if (now - c.at > 2 * 3600_000 || this.calls.size >= CALLS_KEPT) this.calls.delete(sid);
		this.calls.set(call, { at: now, authed: false, tries: 0 });
	}

	private askCode(text: string): string {
		const action = escapeXml(this.hookUrl("?step=code"));
		return twiml(`<Gather input="dtmf" finishOnKey="#" numDigits="8" timeout="10" action="${action}" method="POST">${this.say([text])}</Gather>${this.say(["Ciao."])}<Hangup/>`);
	}

	/** Speak the reply if it comes within one wait; otherwise "un momento" and Twilio comes back. */
	private async reply(from: string, turn: number, waited: number, signal: AbortSignal | undefined, before: string[]): Promise<string> {
		const ready = await this.waitFor(from, this.options.waitMs ?? 8_000, signal);
		if (ready.length > 0) return this.listen(turn + 1, [...before, ...ready]);
		// Not ready yet: what was said first goes back, to be said with the answer.
		if (before.length > 0) for (const [i, text] of before.slice(1, -1).entries()) this.options.pending.put(from, text, `earlier:${turn}:${i}`);
		if (waited + 1 >= (this.options.maxWaits ?? 6)) return twiml(`${this.say(["Ci vuole ancora un po'. Richiamami tra qualche minuto: la risposta ti aspetta."])}<Hangup/>`);
		const again = escapeXml(this.hookUrl(`?step=wait&turn=${turn}&n=${waited + 1}`));
		return twiml(`${this.say([waited === 0 ? "Un momento." : "Ancora un attimo."])}<Redirect method="POST">${again}</Redirect>`);
	}

	/** The replies for this number, as soon as there are some or after `ms`. A call that hung up takes nothing. */
	private async waitFor(from: string, ms: number, signal?: AbortSignal): Promise<string[]> {
		const take = () => {
			if (signal?.aborted) return [];
			const replies = this.options.pending.take(from);
			// Hung up while the replies were read: they stay for the next call.
			if (signal?.aborted) for (const [i, text] of replies.entries()) this.options.pending.put(from, text, `back:${Date.now()}:${i}`);
			return signal?.aborted ? [] : replies;
		};
		const now = take();
		if (now.length > 0 || signal?.aborted) return now;
		const set = this.waiters.get(from) ?? new Set<() => void>();
		if (set.size >= WAITERS_PER_NUMBER) return [];
		await new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", done);
				set.delete(done);
				if (set.size === 0) this.waiters.delete(from);
				resolve();
			};
			const timer = setTimeout(done, ms);
			signal?.addEventListener("abort", done);
			set.add(done);
			this.waiters.set(from, set);
		});
		return take();
	}

	/** Say something, then listen for the next phrase; silence comes back too, as an empty phrase. */
	private listen(turn: number, texts: string[], quiet = false): string {
		const action = escapeXml(this.hookUrl(`?step=heard&turn=${turn}${quiet ? "&quiet=1" : ""}`));
		return twiml(`<Gather input="speech" language="${LANGUAGE}" speechTimeout="auto" actionOnEmptyResult="true" action="${action}" method="POST">${this.say(texts)}</Gather>${this.say(["Non ti sento più. Ciao!"])}<Hangup/>`);
	}

	/** One <Say> per message, made fit for the ear, and no more than one turn's worth. */
	private say(texts: string[]): string {
		const voice = PHONE_VOICE.test(this.options.voice ?? "") ? ` voice="${this.options.voice}"` : "";
		let total = 0;
		const parts: string[] = [];
		for (const text of texts.map(spoken).filter(Boolean)) {
			if (total + text.length > MAX_TURN) {
				parts.push("C'è dell'altro: chiedimelo per iscritto.");
				break;
			}
			total += text.length;
			parts.push(text);
		}
		return parts.map((t) => `<Say language="${LANGUAGE}"${voice}>${escapeXml(t)}</Say>`).join("");
	}
}

/**
 * A written reply made fit to be read aloud: no markup, links named instead of spelled out,
 * and cut when it would take minutes.
 */
export function spoken(text: string): string {
	const plain = text
		.replace(/```[\s\S]*?```/g, " (c'è del codice: te lo mando per iscritto se me lo chiedi) ")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/https?:\/\/\S+/g, "un link")
		.replace(/^\s*>+\s?/gm, "")
		.replace(/[*_`#|~]+/g, "")
		.replace(/^\s*[-•]\s+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
	return plain.length > MAX_SPOKEN ? `${plain.slice(0, MAX_SPOKEN).replace(/\s\S*$/, "")}… La risposta è più lunga: chiedimela per iscritto.` : plain;
}

/** An https address as given, and with or without its default port. */
function withAndWithoutPort(url: string): string[] {
	const parsed = new URL(url);
	if (parsed.port !== "") return parsed.port === "443" ? [url, url.replace(/^(https:\/\/[^/:]+):443/, "$1")] : [url];
	return [url, url.replace(/^(https:\/\/[^/]+)/, "$1:443")];
}

function twiml(body: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * Check the credentials with Twilio and point the number's calls at this cell. Returns the
 * number's SID. `apiBase` is Twilio's REST API (the Ireland region for data in the EU).
 */
export async function connectTwilioNumber(input: { accountSid: string; authToken: string; number: string; voiceUrl: string; apiBase?: string; fetch?: typeof fetch }): Promise<{ numberSid: string }> {
	const base = `${input.apiBase ?? "https://api.twilio.com"}/2010-04-01/Accounts/${encodeURIComponent(input.accountSid)}`;
	const auth = `Basic ${Buffer.from(`${input.accountSid}:${input.authToken}`).toString("base64")}`;
	const call = input.fetch ?? fetch;
	const found = await call(`${base}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(input.number)}`, { headers: { authorization: auth }, signal: AbortSignal.timeout(15_000) });
	if (found.status === 401 || found.status === 403 || found.status === 404) throw new ChannelRefused("Twilio non accetta queste credenziali");
	if (!found.ok) throw new Error(`Twilio answered ${found.status}`);
	const sid = ((await found.json()) as { incoming_phone_numbers?: { sid?: string }[] }).incoming_phone_numbers?.[0]?.sid;
	if (sid === undefined || !/^PN[0-9a-f]{32}$/i.test(sid)) throw new ChannelRefused("questo numero non è nell'account Twilio");
	const set = await call(`${base}/IncomingPhoneNumbers/${sid}.json`, {
		method: "POST",
		headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ VoiceUrl: input.voiceUrl, VoiceMethod: "POST" }).toString(),
		signal: AbortSignal.timeout(15_000),
	});
	if (!set.ok) throw new ChannelRefused(`Twilio non ha accettato l'indirizzo delle chiamate (${set.status})`);
	return { numberSid: sid };
}

export class MissingPhoneField extends Error {
	override readonly name = "MissingPhoneField";
}

export function parsePhoneCredentials(saved: string): PhoneCredentials | undefined {
	try {
		const value = JSON.parse(saved) as Partial<PhoneCredentials>;
		if (typeof value.accountSid === "string" && typeof value.authToken === "string" && typeof value.number === "string" && typeof value.numberSid === "string" && typeof value.pin === "string" && PHONE_PIN.test(value.pin)) return value as PhoneCredentials;
	} catch {
		/* unreadable: undefined */
	}
	return undefined;
}
