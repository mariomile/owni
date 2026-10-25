import { type TranscribePiece, TranscriptionFailed, type TranscriptSegment } from "../core/recordings.ts";

/**
 * Voice messages to text, through any service that speaks OpenAI's transcription API
 * (`POST <base>/audio/transcriptions`, multipart `file` and `model`): Mistral's Voxtral (servers
 * in the EU), OpenAI's Whisper, a model of one's own. The operator chooses the service; the owner
 * allows it instance by instance (connector "voice" in the egress policy). The audio leaves the
 * server for that service and nowhere else.
 */

/** The egress name of transcription: an instance sends audio out only with it in its connectors. */
export const VOICE_CONNECTOR = "voice";
export type TranscriberConfig = {
	/** The API base, e.g. https://api.mistral.ai/v1. */
	readonly url: string;
	readonly apiKey: string;
	readonly model: string;
	/** Longest voice message transcribed, in seconds; longer ones are not sent. */
	readonly maxSeconds: number;
	/**
	 * How the service gives the time of each passage of a recording (ADR 0033): Mistral's
	 * `timestamp_granularities`, OpenAI's `verbose_json` (whisper-1), or not at all.
	 */
	readonly timestamps: TimestampStyle;
	/** The service tells voices apart (Mistral's `diarize`). */
	readonly speakers: boolean;
	/** Longest recording transcribed with audio_transcribe, in minutes. */
	readonly maxMinutes: number;
	/** Minutes of recordings transcribed per day, per account. */
	readonly minutesPerDay: number;
};

export type TimestampStyle = "mistral" | "openai" | "none";
export const TIMESTAMP_STYLES: readonly TimestampStyle[] = ["mistral", "openai", "none"];

/** What a channel hands over: the audio as it came, and its length when the channel says it. */
export type VoiceClip = { readonly data: Uint8Array; readonly name: string; readonly mimeType: string; readonly seconds?: number };

/** Audio to text; `maxSeconds` lets a channel refuse a clip before downloading it. */
export type Transcribe = ((clip: VoiceClip) => Promise<string>) & { readonly maxSeconds?: number };

/** This clip will not be transcribed: too long. */
export class TranscriptionRefused extends Error {
	override readonly name = "TranscriptionRefused";
}

/** The owner has not allowed transcription for this instance. */
export class TranscriptionOff extends Error {
	override readonly name = "TranscriptionOff";
}

/** Too long to send, known before downloading when the channel tells the length. */
export function tooLong(seconds: number | undefined, maxSeconds: number): boolean {
	return seconds !== undefined && seconds > maxSeconds;
}

const EXTENSIONS: Record<string, string> = { "audio/ogg": "ogg", "audio/opus": "ogg", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/amr": "amr", "audio/wav": "wav", "audio/x-wav": "wav", "audio/webm": "webm", "audio/flac": "flac" };

/** A file name whose extension matches the audio's type: some services read the format from it. */
export function audioName(mimeType: string, given?: string, stem = "vocale"): string {
	if (given !== undefined && /\.[a-z0-9]{2,5}$/i.test(given)) return given;
	return `${stem}.${EXTENSIONS[mimeType.split(";")[0]?.trim().toLowerCase() ?? ""] ?? "ogg"}`;
}

/** Longest voice message read as a message when the transcriber does not say: five minutes, as OWNI_TRANSCRIBE_MAX_SECONDS. */
const DEFAULT_MESSAGE_SECONDS = 300;

/**
 * Longer than a voice message (ADR 0033): a meeting, a call, a lesson. It is kept in the workspace
 * as a recording, for audio_transcribe, instead of being read out as what the person said.
 */
export function isRecording(seconds: number | undefined, transcribe: Transcribe | undefined): boolean {
	// Without a transcription service there is nothing to do with a recording: the voice note is said as not understood.
	return transcribe !== undefined && tooLong(seconds, transcribe.maxSeconds ?? DEFAULT_MESSAGE_SECONDS);
}

/** Said when a recording or a video is over the 20 MB a chat lets Owni download. */
export const RECORDING_TOO_LARGE = "[Registrazione oltre i 20 MB che posso ricevere. Chiedi di mandarla in M4A o MP3 a qualità più bassa (circa un'ora di voce sta in 20 MB a 32-48 kbps) o divisa in parti.]";

export function transcriber(config: TranscriberConfig, fetchImpl: typeof fetch = fetch): Transcribe {
	const transcribe = async (clip: VoiceClip): Promise<string> => {
		if (tooLong(clip.seconds, config.maxSeconds)) throw new TranscriptionRefused(`voice message of ${clip.seconds} s, over the ${config.maxSeconds} s limit`);
		// Within what Telegram and Meta wait for a webhook to answer, more or less.
		const body = await request(config, fetchImpl, clip, [], AbortSignal.timeout(45_000));
		return body.text;
	};
	return Object.assign(transcribe, { maxSeconds: config.maxSeconds });
}

/**
 * A piece of a long recording to text with the time of each passage and, when asked and the
 * service can, who speaks (ADR 0033). The adapter of the core's TranscribePiece port.
 */
export function pieceTranscriber(config: TranscriberConfig, fetchImpl: typeof fetch = fetch): TranscribePiece {
	return async (piece, options) => {
		const fields: [string, string][] = [];
		if (config.timestamps === "mistral") fields.push(["timestamp_granularities", "segment"]);
		if (config.timestamps === "openai") fields.push(["response_format", "verbose_json"], ["timestamp_granularities[]", "segment"]);
		if (options.speakers && config.speakers) fields.push(["diarize", "true"]);
		// Ten minutes of audio take the service a while; the person's cancel stops the wait.
		const body = await request(config, fetchImpl, { data: piece.data, name: piece.name, mimeType: piece.mimeType }, fields, AbortSignal.any([options.signal, AbortSignal.timeout(180_000)]));
		return { text: body.text, segments: segmentsOf(body.segments) };
	};
}

/** The transcription request: multipart `model` and `file`, plus the fields asked; the answer's text and segments. */
async function request(config: TranscriberConfig, fetchImpl: typeof fetch, clip: VoiceClip, fields: readonly [string, string][], signal: AbortSignal): Promise<{ text: string; segments: unknown }> {
	const form = new FormData();
	form.set("model", config.model);
	form.set("file", new Blob([Uint8Array.from(clip.data)], { type: clip.mimeType }), clip.name);
	for (const [name, value] of fields) form.append(name, value);
	let response: Response;
	try {
		response = await fetchImpl(`${config.url.replace(/\/+$/, "")}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${config.apiKey}` }, body: form, signal });
	} catch (error) {
		// Cancelled by the person: not a failure of the service.
		if (signal.aborted && !(signal.reason instanceof DOMException && signal.reason.name === "TimeoutError")) throw error;
		throw new TranscriptionFailed("transcription: no answer from the service", true);
	}
	const body = (await response.json().catch(() => ({}))) as { text?: unknown; segments?: unknown; message?: unknown; error?: { message?: unknown } | string };
	// The service's words, never the request: the key stays out of logs. OpenAI nests them, Mistral does not.
	const detail = typeof body.error === "string" ? body.error : String(body.error?.message ?? body.message ?? "");
	if (!response.ok) throw new TranscriptionFailed(`transcription: ${response.status} ${detail.replaceAll(config.apiKey, "[chiave]").slice(0, 200)}`.trim(), response.status === 429 || response.status >= 500, response.status);
	if (typeof body.text !== "string") throw new TranscriptionFailed("transcription: no text in the answer", false, response.status);
	return { text: body.text.trim(), segments: body.segments };
}

/** The service's segments, those that make sense: times in seconds, some text, a speaker when given. */
function segmentsOf(value: unknown): TranscriptSegment[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((raw): TranscriptSegment[] => {
		const s = raw as { start?: unknown; end?: unknown; text?: unknown; speaker_id?: unknown; speaker?: unknown };
		if (typeof s?.start !== "number" || !Number.isFinite(s.start) || typeof s.text !== "string") return [];
		const end = typeof s.end === "number" && Number.isFinite(s.end) ? s.end : s.start;
		const speaker = s.speaker_id ?? s.speaker;
		return [{ start: s.start, end, text: s.text, ...(typeof speaker === "string" || typeof speaker === "number" ? { speaker: String(speaker).slice(0, 40) } : {}) }];
	});
}

/** How a transcribed voice message starts: only these ask for a spoken reply (ADR 0020). */
export const TRANSCRIBED = "[Messaggio vocale, trascritto]";

/** How a voice message reaches Owni: its words, marked as transcribed; or why there are none. */
export async function voiceText(clip: VoiceClip, transcribe: Transcribe | undefined, log?: (message: string) => void): Promise<string> {
	if (transcribe === undefined) return "[Messaggio vocale: su questo server la trascrizione non è attiva. Chiedi di scrivere il messaggio.]";
	try {
		const text = await transcribe(clip);
		return text === "" ? "[Messaggio vocale senza parole riconoscibili.]" : `${TRANSCRIBED} ${text}`;
	} catch (error) {
		if (error instanceof TranscriptionOff) return "[Messaggio vocale: la trascrizione non è attiva per questa istanza. Chiedi di scrivere il messaggio.]";
		log?.(`voice: not transcribed: ${error instanceof Error ? error.message : String(error)}`);
		return error instanceof TranscriptionRefused ? "[Messaggio vocale troppo lungo da trascrivere. Chiedi di dividerlo o di scriverlo.]" : "[Messaggio vocale: la trascrizione non è riuscita. Chiedi di riprovare o di scriverlo.]";
	}
}
