import { randomBytes } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { Mail, Mailer } from "./mailer.ts";

/**
 * The SMTP server the sign-in links leave from: any mail service speaks it (Postmark, SES,
 * Brevo, Mailgun, an EU provider). `smtps://` is TLS from the first byte (port 465); `smtp://`
 * must upgrade with STARTTLS (port 587) and is refused if the server cannot. `plain` is only for
 * a server on this machine, and only from code (tests): no URL selects it.
 */
export type SmtpOptions = {
	readonly host: string;
	readonly port: number;
	readonly security: "tls" | "starttls" | "plain";
	readonly user?: string;
	readonly password?: string;
	/** "Owni <accesso@example.it>" */
	readonly from: string;
	readonly timeoutMs?: number;
	/** Trusted CA in place of the system's: only for a test server. */
	readonly ca?: string;
};

/** `smtps://user:pass@host:465` or `smtp://user:pass@host:587`; the password never goes to logs. */
export function parseSmtpUrl(url: string, from: string): SmtpOptions {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("OWNI_CLOUD_SMTP_URL: not a URL (smtps://user:password@host:465 or smtp://user:password@host:587)");
	}
	const security = parsed.protocol === "smtps:" ? "tls" : parsed.protocol === "smtp:" ? "starttls" : undefined;
	if (security === undefined) throw new Error("OWNI_CLOUD_SMTP_URL: use smtps:// (port 465) or smtp:// with STARTTLS (port 587)");
	assertSender(from);
	return {
		host: parsed.hostname,
		port: Number(parsed.port || (security === "tls" ? 465 : 587)),
		security,
		...(parsed.username === "" ? {} : { user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) }),
		from,
	};
}

const LOCAL = new Set(["127.0.0.1", "localhost", "::1"]);
/** A whole send, however slowly the server answers. */
const SEND_DEADLINE_MS = 60_000;
/** A reply line longer than this is not SMTP. */
const MAX_LINE = 8192;

function assertSender(from: string): void {
	if (!/^[^\r\n<>]*<[^\s<>@]+@[^\s<>@]+>$|^[^\s<>@]+@[^\s<>@]+$/.test(from)) throw new Error('OWNI_CLOUD_MAIL_FROM: an address, or "Name <address>"');
}

/** Sends each mail over a fresh SMTP connection: few mails, no pool to keep alive. */
export class SmtpMailer implements Mailer {
	constructor(private readonly options: SmtpOptions) {
		if (options.security === "plain" && !LOCAL.has(options.host)) throw new Error("SMTP without TLS only to a server on this machine");
		assertSender(options.from);
	}

	async send(mail: Mail): Promise<void> {
		// A line break in an address would let someone write their own headers.
		if (/[\r\n]/.test(mail.to + mail.subject)) throw new Error("SMTP: line break in an address or subject");
		const session = await SmtpSession.open(this.options);
		// A server that trickles a byte at a time never trips the idle timeout: this does.
		const deadline = setTimeout(() => session.abort(new Error(`SMTP: ${this.options.host} took more than ${SEND_DEADLINE_MS / 1000} seconds`)), SEND_DEADLINE_MS);
		try {
			await session.expect(220);
			let features = await session.ehlo();
			if (this.options.security === "starttls") {
				if (!/^STARTTLS$/im.test(features)) throw new Error(`SMTP: ${this.options.host} does not offer STARTTLS`);
				await session.command("STARTTLS", 220);
				await session.upgrade();
				features = await session.ehlo();
			}
			if (this.options.user !== undefined) {
				const auth = /^AUTH\s+(.*)$/im.exec(features)?.[1]?.toUpperCase().split(/\s+/) ?? [];
				if (auth.includes("PLAIN")) {
					await session.command(`AUTH PLAIN ${Buffer.from(`\0${this.options.user}\0${this.options.password ?? ""}`).toString("base64")}`, 235, true);
				} else if (auth.includes("LOGIN")) {
					await session.command("AUTH LOGIN", 334);
					await session.command(Buffer.from(this.options.user).toString("base64"), 334, true);
					await session.command(Buffer.from(this.options.password ?? "").toString("base64"), 235, true);
				} else {
					throw new Error(`SMTP: ${this.options.host} offers no login we know (PLAIN, LOGIN)`);
				}
			}
			await session.command(`MAIL FROM:<${address(this.options.from)}>`, 250);
			// A refusal can quote the address: not in our logs.
			await session.command(`RCPT TO:<${address(mail.to)}>`, [250, 251], true);
			await session.command("DATA", 354);
			await session.command(`${smtpMessage(this.options.from, mail)}\r\n.`, 250);
			await session.command("QUIT", 221).catch(() => {});
		} finally {
			clearTimeout(deadline);
			session.close();
		}
	}
}

function address(from: string): string {
	return /<([^>]+)>/.exec(from)?.[1] ?? from;
}

/** RFC 5322 message, UTF-8 text in base64, lines dot-stuffed for DATA. */
export function smtpMessage(from: string, mail: Mail, now = new Date()): string {
	const encodeWord = (text: string) => (/^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text).toString("base64")}?=`);
	const fromHeader = /^(.*?)\s*<([^>]+)>$/.exec(from);
	const body = (Buffer.from(mail.text.replace(/\r?\n/g, "\r\n")).toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
	const domain = address(from).split("@")[1] ?? "localhost";
	const lines = [
		`From: ${fromHeader === null ? from : `${encodeWord(fromHeader[1] ?? "")} <${fromHeader[2]}>`}`,
		`To: <${mail.to}>`,
		`Subject: ${encodeWord(mail.subject)}`,
		`Date: ${now.toUTCString().replace("GMT", "+0000")}`,
		`Message-ID: <${randomBytes(12).toString("hex")}@${domain}>`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"Content-Transfer-Encoding: base64",
		"",
		body,
	];
	return lines.map((line) => (line.startsWith(".") ? `.${line}` : line)).join("\r\n");
}

/** One SMTP conversation: replies read line by line, multi-line replies joined. */
class SmtpSession {
	private buffer = "";
	private waiting: ((line: string | Error) => void) | undefined;
	private readonly lines: string[] = [];
	private failure: Error | undefined;

	private constructor(
		private socket: Socket | TLSSocket,
		private readonly options: SmtpOptions,
	) {
		this.listen();
	}

	static open(options: SmtpOptions): Promise<SmtpSession> {
		return new Promise((resolve, reject) => {
			const timeout = options.timeoutMs ?? 15_000;
			const socket =
				options.security === "tls"
					? tlsConnect({ host: options.host, port: options.port, servername: options.host, ...(options.ca === undefined ? {} : { ca: options.ca }) })
					: netConnect({ host: options.host, port: options.port });
			socket.setTimeout(timeout, () => socket.destroy(new Error(`SMTP: ${options.host} did not answer within ${timeout / 1000} seconds`)));
			socket.once(options.security === "tls" ? "secureConnect" : "connect", () => resolve(new SmtpSession(socket, options)));
			socket.once("error", reject);
		});
	}

	private listen(): void {
		this.socket.setEncoding("utf8");
		this.socket.on("data", (chunk: string) => {
			this.buffer += chunk;
			let index = this.buffer.indexOf("\r\n");
			while (index >= 0) {
				this.push(this.buffer.slice(0, index));
				this.buffer = this.buffer.slice(index + 2);
				index = this.buffer.indexOf("\r\n");
			}
			if (this.buffer.length > MAX_LINE) this.abort(new Error(`SMTP: ${this.options.host} sent a line longer than ${MAX_LINE} characters`));
		});
		this.socket.on("error", (error) => this.fail(error));
		this.socket.on("close", () => this.fail(new Error(`SMTP: ${this.options.host} closed the connection`)));
	}

	private push(line: string): void {
		const waiting = this.waiting;
		if (waiting !== undefined) {
			this.waiting = undefined;
			waiting(line);
		} else {
			this.lines.push(line);
		}
	}

	private fail(error: Error): void {
		this.failure ??= error;
		const waiting = this.waiting;
		this.waiting = undefined;
		waiting?.(error);
	}

	private line(): Promise<string> {
		const queued = this.lines.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		if (this.failure !== undefined) return Promise.reject(this.failure);
		return new Promise((resolve, reject) => {
			this.waiting = (line) => (line instanceof Error ? reject(line) : resolve(line));
		});
	}

	/** Reads one reply; throws unless its code is one of `codes`. Returns the text of all its lines. */
	async expect(codes: number | readonly number[], secret = false): Promise<string> {
		const accepted = typeof codes === "number" ? [codes] : codes;
		const text: string[] = [];
		for (;;) {
			const line = await this.line();
			text.push(line.slice(4));
			if (line[3] !== "-") {
				const code = Number(line.slice(0, 3));
				// A refused login is reported without echoing what was sent.
				if (!accepted.includes(code)) throw new Error(`SMTP: ${this.options.host} answered ${secret ? code : line}`);
				return text.join("\n");
			}
		}
	}

	async command(line: string, codes: number | readonly number[], secret = false): Promise<string> {
		this.socket.write(`${line}\r\n`);
		return this.expect(codes, secret);
	}

	async ehlo(): Promise<string> {
		return this.command("EHLO owni", 250);
	}

	/** STARTTLS accepted: the same connection continues encrypted, certificate checked. */
	upgrade(): Promise<void> {
		// Anything sent after the 220 and before the handshake came in clear text and could be
		// someone's injected reply (CVE-2011-0411): refuse rather than read it after TLS.
		if (this.lines.length > 0 || this.buffer !== "") return Promise.reject(new Error(`SMTP: ${this.options.host} sent data before the TLS handshake`));
		return new Promise((resolve, reject) => {
			this.socket.removeAllListeners("data");
			this.socket.removeAllListeners("close");
			this.socket.removeAllListeners("error");
			const secure = tlsConnect({ socket: this.socket, servername: this.options.host, ...(this.options.ca === undefined ? {} : { ca: this.options.ca }) }, () => {
				this.socket = secure;
				this.buffer = "";
				this.listen();
				resolve();
			});
			secure.once("error", reject);
		});
	}

	abort(error: Error): void {
		this.fail(error);
		this.socket.destroy();
	}

	close(): void {
		this.socket.destroy();
	}
}
