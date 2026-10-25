import { readFileSync } from "node:fs";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { createServer as createTlsServer, TLSSocket } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { smtpMessage as message, parseSmtpUrl, SmtpMailer } from "../src/cloud/smtp.ts";

const cert = readFileSync(join(import.meta.dirname, "fixtures", "localhost-cert.pem"), "utf8");
const key = readFileSync(join(import.meta.dirname, "fixtures", "localhost-key.pem"), "utf8");

const servers: { close(): void }[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.close();
});

/** A fake SMTP server: what a client says, recorded; STARTTLS and AUTH as asked. */
async function fakeSmtp(options: { starttls?: boolean; auth?: string; refuseLogin?: boolean; implicitTls?: boolean; injectAfterStarttls?: boolean } = {}) {
	const log: string[] = [];
	const mails: string[] = [];
	const handler = (raw: Socket) => {
		let socket: Socket | TLSSocket = raw;
		let buffer = "";
		let inData = false;
		let data = "";
		let secure = false;
		let loginStep = 0;
		const write = (line: string) => socket.write(`${line}\r\n`);
		const onLine = (line: string) => {
			if (inData) {
				if (line === ".") {
					inData = false;
					mails.push(data);
					data = "";
					return write("250 OK queued");
				}
				data += `${line}\r\n`;
				return;
			}
			log.push(line);
			if (loginStep > 0) {
				loginStep = loginStep === 1 ? 2 : 0;
				return write(loginStep === 2 ? "334 UGFzc3dvcmQ6" : options.refuseLogin ? "535 bad credentials" : "235 OK");
			}
			const verb = line.split(" ")[0]?.toUpperCase();
			if (verb === "EHLO") return write(["250-fake", ...(options.starttls && !secure ? ["250-STARTTLS"] : []), ...(options.auth ? [`250-AUTH ${options.auth}`] : []), "250 OK"].join("\r\n"));
			if (verb === "STARTTLS") {
				// A man in the middle adds clear-text replies right after the 220.
				write(options.injectAfterStarttls ? "220 go ahead\r\n250 OK\r\n354 go\r\n250 OK queued" : "220 go ahead");
				socket.removeAllListeners("data");
				const tls = new TLSSocket(socket, { isServer: true, cert, key });
				socket = tls;
				secure = true;
				tls.setEncoding("utf8");
				tls.on("data", onData);
				return;
			}
			if (verb === "AUTH" && line.toUpperCase() === "AUTH LOGIN") {
				loginStep = 1;
				return write("334 VXNlcm5hbWU6");
			}
			if (verb === "AUTH") return write(options.refuseLogin ? "535 bad credentials" : "235 OK");
			if (verb === "MAIL" || verb === "RCPT") return write("250 OK");
			if (verb === "DATA") {
				inData = true;
				return write("354 go");
			}
			if (verb === "QUIT") {
				write("221 bye");
				return socket.end();
			}
			write("502 unknown");
		};
		const onData = (chunk: string) => {
			buffer += chunk;
			let i = buffer.indexOf("\r\n");
			while (i >= 0) {
				onLine(buffer.slice(0, i));
				buffer = buffer.slice(i + 2);
				i = buffer.indexOf("\r\n");
			}
		};
		raw.setEncoding("utf8");
		raw.on("data", onData);
		write("220 fake ESMTP");
	};
	const server = options.implicitTls ? createTlsServer({ cert, key }, handler) : createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	return { port: (server.address() as AddressInfo).port, log, mails };
}

const mail = { to: "anna@example.com", subject: "Il tuo link per entrare in Owni", text: "Apri questo link:\n\nhttps://owni.example.it/verify#abc\n" };

describe("SMTP mailer", () => {
	it("sends over STARTTLS with AUTH PLAIN, the text in UTF-8, the password never in an error", async () => {
		const smtp = await fakeSmtp({ starttls: true, auth: "PLAIN LOGIN" });
		await new SmtpMailer({ host: "localhost", port: smtp.port, security: "starttls", user: "u", password: "segreto", from: "Owni <accesso@owni.example.it>", ca: cert }).send(mail);
		expect(smtp.log.map((l) => l.split(" ")[0])).toEqual(["EHLO", "STARTTLS", "EHLO", "AUTH", "MAIL", "RCPT", "DATA", "QUIT"]);
		expect(smtp.log).toContain("RCPT TO:<anna@example.com>");
		expect(smtp.log).toContain("MAIL FROM:<accesso@owni.example.it>");
		const [sent] = smtp.mails;
		expect(sent).toContain("Subject: Il tuo link per entrare in Owni");
		const body = (sent ?? "").split("\r\n\r\n")[1]?.replace(/\r\n/g, "") ?? "";
		expect(Buffer.from(body, "base64").toString("utf8")).toContain("https://owni.example.it/verify#abc");
		// Wrong password: the error says so without what was sent.
		const refusing = await fakeSmtp({ starttls: true, auth: "PLAIN", refuseLogin: true });
		const failed = new SmtpMailer({ host: "localhost", port: refusing.port, security: "starttls", user: "u", password: "segreto", from: "accesso@owni.example.it", ca: cert }).send(mail);
		await expect(failed).rejects.toThrow(/answered 535$/);
	});

	it("sends over TLS from the first byte (smtps, port 465)", async () => {
		const smtp = await fakeSmtp({ implicitTls: true, auth: "LOGIN" });
		await new SmtpMailer({ host: "localhost", port: smtp.port, security: "tls", user: "u", password: "p", from: "a@b.example", ca: cert }).send(mail);
		expect(smtp.log.map((l) => l.split(" ")[0])).toEqual(["EHLO", "AUTH", "dQ==", "cA==", "MAIL", "RCPT", "DATA", "QUIT"]);
		expect(smtp.mails).toHaveLength(1);
	});

	it("refuses replies injected in clear text before the TLS handshake (CVE-2011-0411)", async () => {
		const smtp = await fakeSmtp({ starttls: true, auth: "PLAIN", injectAfterStarttls: true });
		const sending = new SmtpMailer({ host: "localhost", port: smtp.port, security: "starttls", user: "u", password: "p", from: "a@b.example", ca: cert }).send(mail);
		await expect(sending).rejects.toThrow(/before the TLS handshake/);
		expect(smtp.mails).toEqual([]);
	});

	it("refuses a server that does not offer STARTTLS, and plain SMTP to another machine", async () => {
		const smtp = await fakeSmtp({ starttls: false, auth: "PLAIN" });
		await expect(new SmtpMailer({ host: "localhost", port: smtp.port, security: "starttls", user: "u", password: "p", from: "a@b.example" }).send(mail)).rejects.toThrow(/does not offer STARTTLS/);
		expect(smtp.log.some((l) => l.startsWith("AUTH"))).toBe(false);
		expect(() => new SmtpMailer({ host: "smtp.example.com", port: 25, security: "plain", from: "a@b.example" })).toThrow(/this machine/);
	});

	it("never lets an address or subject carry its own headers", async () => {
		const smtp = await fakeSmtp();
		const mailer = new SmtpMailer({ host: "127.0.0.1", port: smtp.port, security: "plain", from: "a@b.example" });
		await expect(mailer.send({ ...mail, to: "x@y.example\r\nBcc: tutti@z.example" })).rejects.toThrow(/line break/);
		expect(smtp.log).toEqual([]);
	});

	it("encodes a non-ASCII subject and sender name; parses the service URL", () => {
		const text = message("Owni Città <a@b.example>", { to: "c@d.example", subject: "Il tuo accesso è pronto", text: ".riga che inizia con un punto" }, new Date("2026-10-16T10:00:00Z"));
		expect(text).toContain(`Subject: =?UTF-8?B?${Buffer.from("Il tuo accesso è pronto").toString("base64")}?=`);
		expect(text).toContain("From: =?UTF-8?B?");
		expect(text).toContain("Date: Fri, 16 Oct 2026 10:00:00 +0000");
		expect(parseSmtpUrl("smtps://user%40x:p%3Ass@smtp.example.eu", "a@b.example")).toEqual({ host: "smtp.example.eu", port: 465, security: "tls", user: "user@x", password: "p:ss", from: "a@b.example" });
		expect(parseSmtpUrl("smtp://smtp.example.eu", "Owni <a@b.example>")).toMatchObject({ port: 587, security: "starttls" });
		expect(() => parseSmtpUrl("http://x", "a@b.example")).toThrow(/smtps/);
		expect(() => parseSmtpUrl("smtps://x", "a@b.example\r\nBcc: z")).toThrow(/MAIL_FROM/);
	});
});
