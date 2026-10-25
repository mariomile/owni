import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cardView, type GoogleAction, googleActionTitle } from "../src/core/google-actions.ts";
import { AttachmentSlots } from "../src/core/attachment-slots.ts";
import { ATTACHMENT_LIMITS, AttachmentError, attachFiles, attachmentName, attachmentsLine, changedFile, readAttachments, sizeText, withoutAttachmentWords } from "../src/core/mail-attachments.ts";
import { base64Lines, mimeMessage } from "../src/core/mail-mime.ts";

const mime = (...args: Parameters<typeof mimeMessage>) => mimeMessage(...args).toString("latin1");
import { ATTACHMENT_TYPES } from "../src/core/attachment-types.ts";
import { needsUpload } from "../src/connectors/google.ts";
import { Workspace } from "../src/core/workspace.ts";

/** A zip with these (empty, stored) entries: local headers, the central directory and its end. */
function zip(names: readonly string[]): Buffer {
	const locals: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const name of names) {
		const n = Buffer.from(name, "utf8");
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(n.length, 26);
		locals.push(local, n);
		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(n.length, 28);
		entry.writeUInt32LE(offset, 42);
		central.push(entry, n);
		offset += 30 + n.length;
	}
	const dir = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(names.length, 8);
	end.writeUInt16LE(names.length, 10);
	end.writeUInt32LE(dir.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, dir, end]);
}

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "owni-attach-"));
	dirs.push(dir);
	return dir;
}

/** A signed file's start: a SEQUENCE of `length` (its real one by default, or indefinite), the signedData OID, then `rest`. */
function p7m(rest: Buffer = Buffer.from([0xa0, 0x00]), length?: number | "indefinite"): Buffer {
	const oid = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02]);
	const body = Buffer.concat([oid, rest]);
	if (length === "indefinite") return Buffer.concat([Buffer.from([0x30, 0x80]), body]);
	const size = length ?? body.length;
	return Buffer.concat([Buffer.from(size < 0x80 ? [0x30, size] : [0x30, 0x82, size >> 8, size & 0xff]), body]);
}

/** An OLE compound file whose directory (right after the header) holds storages with these names. */
function ole(names: readonly string[] = ["Root Entry", "WordDocument"]): Buffer {
	const head = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]);
	const entries = names.map((name, i) => {
		const entry = Buffer.alloc(128);
		const utf16 = Buffer.from(`${name}\0`, "utf16le");
		utf16.copy(entry, 0);
		entry.writeUInt16LE(utf16.length, 64);
		entry[66] = i === 0 ? 5 : 1;
		return entry;
	});
	return Buffer.concat([head, ...entries]);
}

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 37) % 256))]);
const XML = Buffer.from('<?xml version="1.0"?><p:FatturaElettronica>àè</p:FatturaElettronica>', "utf8");

/** A workspace with these files (path → bytes). */
function workspaceWith(files: Record<string, Buffer | string>) {
	const dir = temp();
	const root = join(dir, "workspace");
	for (const [path, data] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), data);
	}
	return { dir, root, workspace: new Workspace(root) };
}

type Part = { headers: Record<string, string>; body: string };

/** Header lines unfolded, by lower-case name. */
function headersOf(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.replace(/\r\n[ \t]/g, " ").split("\r\n")) {
		const colon = line.indexOf(":");
		out[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
	}
	return out;
}

/** A raw message read back: its headers and, for multipart, its parts. */
function parse(raw: string): { headers: Record<string, string>; parts: Part[]; boundary: string } {
	const cut = raw.indexOf("\r\n\r\n");
	const headers = headersOf(raw.slice(0, cut));
	const boundary = /boundary="([^"]+)"/.exec(headers["content-type"] ?? "")?.[1] ?? "";
	const body = raw.slice(cut + 4);
	expect(body.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
	const chunks = body.split(`--${boundary}`);
	// Nothing before the first boundary, the closing "--" after the last.
	expect(chunks[0]).toBe("");
	expect(chunks.at(-1)).toBe("--\r\n");
	const parts = chunks.slice(1, -1).map((c) => {
		const inner = c.replace(/^\r\n/, "").replace(/\r\n$/, "");
		const at = inner.indexOf("\r\n\r\n");
		return { headers: headersOf(inner.slice(0, at)), body: inner.slice(at + 4) };
	});
	return { headers, parts, boundary };
}

/** The file name a mail program reads: RFC 2231 filename* (with continuations) first, else filename. */
function fileName(disposition: string): string {
	const pieces = [...disposition.matchAll(/filename\*(\d+)?\*?=([^;]+)/g)].sort((a, b) => Number(a[1] ?? 0) - Number(b[1] ?? 0)).map((m) => (m[2] as string).trim());
	if (pieces.length > 0) return decodeURIComponent(pieces.join("").replace(/^UTF-8''/, ""));
	return /filename="([^"]*)"/.exec(disposition)?.[1] ?? "";
}

const MAIL = { to: ["rossi@cliente.example"], cc: [], subject: "Preventivo n. 2026-012: Beta Ristorazione Srl", body: "Gentile Rossi,\nin allegato il preventivo.\nCordiali saluti" };

describe("mail attachments: MIME", () => {
	it("multipart/mixed: the text first, then each file in base64 lines of 76 that decode to the same bytes; non-ASCII names in RFC 2231", async () => {
		const name = "Preventivo città è più lungo del solito per vedere le continuazioni ünïcode.pdf";
		const { workspace } = workspaceWith({ [`preventivi/${name}`]: PDF, "fatture/B-70.xml": XML });
		const list = await attachFiles(workspace, [`preventivi/${name}`, "fatture/B-70.xml"]);
		expect(list.map((a) => [a.name, a.size, a.contentType])).toEqual([
			[name, PDF.length, "application/pdf"],
			["B-70.xml", XML.length, "application/xml"],
		]);
		const raw = mime(MAIL, await readAttachments(workspace, list));
		expect(raw).toMatch(/^[\x00-\x7f]*$/);
		const { headers, parts, boundary } = parse(raw);
		expect(headers.to).toBe("rossi@cliente.example");
		expect(headers.subject).toBe(MAIL.subject);
		expect(headers["mime-version"]).toBe("1.0");
		expect(headers["content-type"]).toBe(`multipart/mixed; boundary="${boundary}"`);
		expect(boundary).toMatch(/^=_owni_[0-9a-f]{36}$/);
		expect(parts).toHaveLength(3);
		const [text, pdf, xml] = parts as [Part, Part, Part];
		expect(text.headers["content-type"]).toBe("text/plain; charset=UTF-8");
		expect(Buffer.from(text.body, "base64").toString("utf8")).toBe(MAIL.body);
		for (const [part, bytes] of [
			[pdf, PDF],
			[xml, XML],
		] as const) {
			expect(part.headers["content-transfer-encoding"]).toBe("base64");
			expect(part.body.split("\r\n").every((l) => l.length <= 76)).toBe(true);
			expect(part.body.split("\r\n").slice(0, -1).every((l) => l.length === 76)).toBe(true);
			expect(Buffer.from(part.body, "base64").equals(bytes)).toBe(true);
		}
		expect(pdf.headers["content-type"]).toMatch(/^application\/pdf; name="=\?UTF-8\?B\?/);
		expect(pdf.headers["content-disposition"]).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*0\*=UTF-8''/);
		expect(fileName(pdf.headers["content-disposition"] as string)).toBe(name);
		expect(fileName(xml.headers["content-disposition"] as string)).toBe("B-70.xml");
		expect(xml.headers["content-disposition"]).toBe('attachment; filename="B-70.xml"');
		// Every header line stays short; the boundary is in no part.
		const head = raw.slice(0, raw.indexOf("\r\n\r\n"));
		expect(head.split("\r\n").every((l) => l.length <= 78)).toBe(true);
		for (const p of parts) expect(`${Object.values(p.headers).join("")}${p.body}`).not.toContain(boundary);
		const partHeads = raw.split(`--${boundary}`).map((c) => c.slice(0, c.indexOf("\r\n\r\n")));
		expect(partHeads.every((h) => h.split("\r\n").every((l) => l.length <= 78))).toBe(true);
	});

	it("without attachments the mail stays plain text, as before", () => {
		const raw = mime(MAIL);
		expect(raw).toContain("Content-Type: text/plain; charset=UTF-8\r\n");
		expect(raw).not.toContain("multipart");
		expect(Buffer.from(raw.split("\r\n\r\n")[1] as string, "base64").toString("utf8")).toBe(MAIL.body);
	});

	it("a file name cannot add headers: line breaks, quotes and backslashes are taken out, and MIME refuses them anyway", async () => {
		expect(attachmentName('dir/evil"\r\nBcc: spia@evil.example\r\n.pdf')).toBe("evilBcc: spia@evil.example.pdf");
		expect(attachmentName("a/.pdf")).toBe("allegato.pdf");
		expect(attachmentName(`${"x".repeat(300)}.pdf`)).toHaveLength(ATTACHMENT_LIMITS.maxName);
		const { workspace } = workspaceWith({ 'evil"\nBcc: spia@evil.example.pdf': PDF });
		const [file] = await attachFiles(workspace, ['evil"\nBcc: spia@evil.example.pdf']);
		expect(file?.name).toBe("evilBcc: spia@evil.example.pdf");
		const raw = mime(MAIL, await readAttachments(workspace, file === undefined ? [] : [file]));
		const { headers, parts } = parse(raw);
		expect(headers.bcc).toBeUndefined();
		expect(raw).not.toMatch(/\r\nBcc:/i);
		expect(fileName(parts[1]?.headers["content-disposition"] as string)).toBe("evilBcc: spia@evil.example.pdf");
		expect(() => mime(MAIL, [{ name: 'a"\r\nBcc: x@y.example', contentType: "application/pdf", data: PDF }])).toThrow(/allegato/);
		expect(() => mime(MAIL, [{ name: "a.pdf", contentType: "text/html\r\nBcc: x@y.example", data: PDF }])).toThrow(/allegato/);
	});
});

describe("mail attachments: what may be attached", () => {
	it("documents only: executables, scripts, web pages, archives and files without extension are refused; a file must be what its extension says", async () => {
		const { workspace } = workspaceWith({ "a.exe": "MZ", "b.js": "alert(1)", "c.sh": "rm", "d.bat": "x", "e.html": "<b>", "f.zip": "PK\x03\x04", g: "x", "h.docm": "PK", "i.heic": "x", "fake.pdf": "<html>", "ok.csv": "a;b", "ok.txt": "ciao", "ok.p7m": p7m() });
		for (const path of ["a.exe", "b.js", "c.sh", "d.bat", "e.html", "f.zip", "g", "h.docm"]) await expect(attachFiles(workspace, [path])).rejects.toThrow(/non allego/);
		await expect(attachFiles(workspace, ["i.heic"])).rejects.toThrow(/converti la foto in JPG/);
		await expect(attachFiles(workspace, ["fake.pdf"])).rejects.toThrow(/non è davvero un file \.pdf/);
		expect((await attachFiles(workspace, ["ok.csv", "ok.txt", "ok.p7m"])).map((a) => a.contentType)).toEqual(["text/csv", "text/plain", "application/pkcs7-mime"]);
	});

	it("content checks: text without markup or NUL, XML that is XML, p7m in DER, Office packages without macros, OLE and RTF", async () => {
		const files: Record<string, Buffer | string> = {
			"html.txt": "\ufeff  <!DOCTYPE html><p>x",
			"script.csv": "\n <SCRIPT>alert(1)</script>",
			"nul.txt": Buffer.from("ab\0cd"),
			"html.xml": '<?xml version="1.0"?><root><html>x</html></root>',
			"script.xml": "<root><script>x</script></root>",
			"text.xml": "solo testo",
			"ok.xml": "\ufeff<FatturaElettronica/>",
			"pem.p7m": "-----BEGIN PKCS7-----",
			"plain.docx": zip(["word/document.xml"]),
			"macro.docx": zip(["[Content_Types].xml", "word/vbaProject.bin"]),
			"ok.docx": zip(["[Content_Types].xml", "word/document.xml"]),
			"ok.xlsx": zip(["[Content_Types].xml", "xl/workbook.xml"]),
			"odf.docx": zip(["mimetype", "content.xml"]),
			"ok.odt": zip(["mimetype", "content.xml"]),
			"ooxml.ods": zip(["[Content_Types].xml"]),
			"broken.docx": Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.alloc(40)]),
			"ok.doc": ole(),
			"ok.xls": ole(["Root Entry", "Workbook"]),
			"ok.ppt": ole(),
			"fake.doc": zip(["[Content_Types].xml"]),
			"ok.rtf": "{\\rtf1\\ansi ciao}",
			"fake.rtf": "<html>",
		};
		const { workspace } = workspaceWith(files);
		for (const path of ["html.txt", "script.csv", "nul.txt", "html.xml", "script.xml", "text.xml", "pem.p7m", "plain.docx", "macro.docx", "odf.docx", "ooxml.ods", "broken.docx", "fake.doc", "fake.rtf"]) {
			await expect(attachFiles(workspace, [path]), path).rejects.toThrow(/non è davvero un file/);
		}
		const ok = await attachFiles(workspace, ["ok.xml", "ok.docx", "ok.xlsx", "ok.odt", "ok.rtf"]);
		expect(ok.map((a) => a.contentType)).toEqual(["application/xml", ATTACHMENT_TYPES.docx, ATTACHMENT_TYPES.xlsx, ATTACHMENT_TYPES.odt, "application/rtf"]);
		expect((await attachFiles(workspace, ["ok.doc", "ok.xls", "ok.ppt"])).map((a) => a.contentType)).toEqual(["application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"]);
	});

	it("limits: at most 5 files and 17 MB in all, said before anything is asked", async () => {
		const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}.txt`, "x"]));
		const { workspace } = workspaceWith({ ...files, "big1.pdf": Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(10 * 1024 * 1024)]), "big2.pdf": Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(9 * 1024 * 1024)]) });
		await expect(attachFiles(workspace, Object.keys(files))).rejects.toThrow("al massimo 5 allegati per mail");
		expect(await attachFiles(workspace, Object.keys(files).slice(0, 5))).toHaveLength(5);
		// The same file twice counts once.
		expect(await attachFiles(workspace, ["f0.txt", "./f0.txt", "f0.txt"])).toHaveLength(1);
		await expect(attachFiles(workspace, ["big1.pdf", "big2.pdf"])).rejects.toThrow(/superano 17 MB in tutto/);
		expect(await attachFiles(workspace, ["big1.pdf"])).toHaveLength(1);
	});

	it("only files of the workspace: no going up, no hidden names, no symlinks to files or folders outside", async () => {
		const { dir, root, workspace } = workspaceWith({ "ok.pdf": PDF });
		writeFileSync(join(dir, "secret.pdf"), PDF);
		mkdirSync(join(dir, "outside"));
		writeFileSync(join(dir, "outside", "x.pdf"), PDF);
		symlinkSync(join(dir, "secret.pdf"), join(root, "link.pdf"));
		symlinkSync(join(dir, "outside"), join(root, "linked"));
		mkdirSync(join(root, ".config"));
		writeFileSync(join(root, ".config", "x.pdf"), PDF);
		for (const path of ["../secret.pdf", "a/../../secret.pdf", "/etc/passwd.txt", "link.pdf", "linked/x.pdf", ".config/x.pdf", ".env.txt"]) {
			const refused = await attachFiles(workspace, [path]).then(
				() => undefined,
				(e: unknown) => e,
			);
			expect(refused, path).toBeInstanceOf(AttachmentError);
		}
		await expect(attachFiles(workspace, ["manca.pdf"])).rejects.toThrow(/non trovo «manca.pdf»/);
		expect(await attachFiles(workspace, ["ok.pdf"])).toHaveLength(1);
	});

	it("at approval the file is read again: changed, swapped for a symlink or gone, nothing is sent", async () => {
		const { root, dir, workspace } = workspaceWith({ "p.pdf": PDF, "q.pdf": PDF });
		const list = await attachFiles(workspace, ["p.pdf"]);
		expect((await readAttachments(workspace, list))[0]?.data.equals(PDF)).toBe(true);
		// Same size, other bytes.
		const other = Buffer.from(PDF);
		other[100] = (other[100] ?? 0) ^ 0xff;
		writeFileSync(join(root, "p.pdf"), other);
		await expect(readAttachments(workspace, list)).rejects.toThrow(changedFile("p.pdf"));
		writeFileSync(join(root, "p.pdf"), Buffer.concat([PDF, Buffer.from("x")]));
		await expect(readAttachments(workspace, list)).rejects.toThrow(changedFile("p.pdf"));
		unlinkSync(join(root, "p.pdf"));
		await expect(readAttachments(workspace, list)).rejects.toThrow(changedFile("p.pdf"));
		writeFileSync(join(dir, "same.pdf"), PDF);
		symlinkSync(join(dir, "same.pdf"), join(root, "p.pdf"));
		await expect(readAttachments(workspace, list)).rejects.toThrow(changedFile("p.pdf"));
		// A request edited to point elsewhere is read through the workspace's rules too.
		const q = await attachFiles(workspace, ["q.pdf"]);
		await expect(readAttachments(workspace, q.map((a) => ({ ...a, path: "../same.pdf" })))).rejects.toThrow(changedFile("q.pdf"));
		await expect(readAttachments(workspace, q.map((a) => ({ ...a, name: "q.exe" })))).rejects.toThrow(/non consentito/);
	});

	it("the card: the files with whole paths and sizes, and Owni's reason apart, capped, without invisible characters, unable to fake them", async () => {
		const { workspace } = workspaceWith({ "privato/buste-paga/Preventivo-2026-012.pdf": PDF, "f/B-70.xml": XML });
		const attachments = await attachFiles(workspace, ["privato/buste-paga/Preventivo-2026-012.pdf", "f/B-70.xml"]);
		expect(attachmentsLine(attachments)).toBe("Allegati: privato/buste-paga/Preventivo-2026-012.pdf (3 KB), f/B-70.xml (1 KB)");
		const action = { id: "x", kind: "mail.send", personId: "p", account: "a@b.example", reason: "Invio del preventivo", mail: { ...MAIL, attachments }, status: "pending", proposedAt: "2026-10-18T08:00:00Z" } as GoogleAction;
		expect(cardView(action).reason).toBe("Invio del preventivo");
		expect(cardView(action).mail?.attachments).toEqual(attachments);
		expect(cardView({ ...action, mail: MAIL }).reason).toBe("Invio del preventivo");
		const tricky = cardView({ ...action, mail: MAIL, reason: `Nessun file\u202e · Allegati: niente.pdf (1 KB)\u200b${"x".repeat(400)}` }).reason;
		expect(tricky).not.toMatch(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/);
		expect(tricky).not.toContain("Allegati");
		expect(tricky.startsWith("Nessun file · alleg.ati: niente.pdf")).toBe(true);
		expect(tricky.length).toBeLessThanOrEqual(300);
		expect(googleActionTitle(action)).toBe("Inviare una mail a rossi@cliente.example, con 2 allegati");
		// The request keeps no content: only path, name, size, hash and type.
		expect(Object.keys(attachments[0] ?? {}).sort()).toEqual(["contentType", "name", "path", "sha256", "size"]);
		expect(JSON.stringify(action)).not.toContain(PDF.subarray(0, 40).toString("base64"));
		// Names lose invisible characters too.
		expect(attachmentName("a/fattura\u202egpj.pdf")).toBe("fatturagpj.pdf");
	});

	it("sizes: 1 KB at least, one decimal under 10 MB, none from 10", () => {
		expect([0, 589, 1024, 86_000, 1024 * 1024 * 1.25, 18 * 1024 * 1024].map(sizeText)).toEqual(["1 KB", "1 KB", "1 KB", "84 KB", "1,3 MB", "18 MB"]);
	});

	it("reading: through a handle that never follows a symlink", async () => {
		const { dir, root, workspace } = workspaceWith({ "a.pdf": PDF });
		writeFileSync(join(dir, "out.pdf"), PDF);
		expect((await workspace.readExact("a.pdf")).data.equals(PDF)).toBe(true);
		unlinkSync(join(root, "a.pdf"));
		symlinkSync(join(dir, "out.pdf"), join(root, "a.pdf"));
		await expect(workspace.readExact("a.pdf")).rejects.toThrow(/Symbolic links/);
		await expect(workspace.readExact("../out.pdf")).rejects.toThrow(/go up/);
	});

	it("base64 in lines of 76, written piece by piece, decodes to the same bytes at every length", () => {
		for (const n of [0, 1, 56, 57, 58, 57 * 1024 - 1, 57 * 1024, 57 * 1024 + 1, 200_003]) {
			const data = Buffer.from(Array.from({ length: n }, (_, i) => (i * 131) % 256));
			const text = base64Lines(data).toString("latin1");
			expect(Buffer.from(text, "base64").equals(data), String(n)).toBe(true);
			expect(text.split("\r\n").every((l) => l.length <= 76)).toBe(true);
			expect(text.split("\r\n").slice(0, -1).every((l) => l.length === 76)).toBe(true);
		}
	});

	it("Gmail's JSON call up to 4 MiB of base64; larger, the upload endpoint", () => {
		const limit = 3 * 1024 * 1024; // 4 MiB of base64
		expect(needsUpload(limit)).toBe(false);
		expect(needsUpload(limit + 1)).toBe(true);
		expect(needsUpload(4 * 1024 * 1024 - 1)).toBe(true);
	});
});

describe("mail attachments: what each type may hold", () => {
	it("old Office files with a VBA project and RTF with embedded objects are refused", async () => {
		const { workspace } = workspaceWith({
			"macros.doc": ole(["Root Entry", "WordDocument", "Macros", "VBA"]),
			"vba.xls": ole(["Root Entry", "Workbook", "_VBA_PROJECT_CUR"]),
			"project.ppt": ole(["Root Entry", "PowerPoint Document", "_VBA_PROJECT"]),
			"clean.doc": ole(["Root Entry", "WordDocument", "Macro notes"]),
			"object.rtf": "{\\rtf1 testo {\\object\\objemb {\\*\\objdata 0105}}}",
			"objdata.rtf": "{\\rtf1 {\\*\\objdata 01050000}}",
			"update.rtf": "{\\rtf1 {\\objupdate x}}",
			"autolink.rtf": "{\\rtf1 {\\objautlink x}}",
			"clean.rtf": "{\\rtf1\\ansi un oggetto qualsiasi, objdata scritto come testo}",
		});
		for (const path of ["macros.doc", "vba.xls", "project.ppt", "object.rtf", "objdata.rtf", "update.rtf", "autolink.rtf"]) await expect(attachFiles(workspace, [path]), path).rejects.toThrow(/non è davvero un file/);
		expect(await attachFiles(workspace, ["clean.doc", "clean.rtf"])).toHaveLength(2);
	});

	it("p7m: a SEQUENCE whose length fits, then the signedData OID; XML without script anywhere; text without markup, UTF-16 allowed; packages without VBA or Basic", async () => {
		const longXml = Buffer.concat([Buffer.from("<?xml version=\"1.0\"?><root>"), Buffer.alloc(1024 * 1024 - 30, 0x61), Buffer.from("<scr"), Buffer.from("ipt>x</script></root>")]);
		const { workspace } = workspaceWith({
			"der.p7m": p7m(Buffer.concat([Buffer.from([0xa0, 0x82, 0x01, 0x00]), Buffer.alloc(256)])),
			"ber.p7m": p7m(Buffer.alloc(300), "indefinite"),
			"short.p7m": p7m(undefined, 200),
			"other.p7m": Buffer.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01, 0xa0, 0x00]),
			"zero.p7m": Buffer.from([0x30, 0x00]),
			"svg.xml": '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><rect onload="alert(1)"/></svg>',
			"svg-ok.xml": '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><rect width="1"/></svg>',
			"late.xml": longXml,
			"ns.xml": "<root><x:script xmlns:x=\"http://www.w3.org/1999/xhtml\">y</x:script></root>",
			"body.txt": "Ciao\n<body onload=x>",
			"svg.csv": "a;b\n<svg/onload=alert(1)>",
			"frame.txt": "testo <iframe src=x>",
			"utf16.txt": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Ciao, è un testo\r\n", "utf16le")]),
			"utf16be.csv": Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("a;b\r\n", "utf16le").swap16()]),
			"utf16-html.txt": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<html><script>x</script>", "utf16le")]),
			"vba.xlsx": zip(["[Content_Types].xml", "xl/workbook.xml", "xl/vbaData.bin"]),
			"VBA.docx": zip(["[Content_Types].xml", "word/document.xml", "word/VBAproject2.BIN"]),
			"basic.odt": zip(["mimetype", "content.xml", "Basic/Standard/Module1.xml"]),
			"bin.docx": zip(["[Content_Types].xml", "word/document.xml", "word/media/image1.bin"]),
		});
		for (const path of ["short.p7m", "other.p7m", "zero.p7m", "svg.xml", "late.xml", "ns.xml", "body.txt", "svg.csv", "frame.txt", "utf16-html.txt", "vba.xlsx", "VBA.docx", "basic.odt"]) await expect(attachFiles(workspace, [path]), path).rejects.toThrow(/non è davvero un file/);
		expect(await attachFiles(workspace, ["der.p7m", "ber.p7m", "svg-ok.xml", "utf16.txt", "utf16be.csv"])).toHaveLength(5);
		expect(await attachFiles(workspace, ["bin.docx"])).toHaveLength(1);
	});

	it("a file with more than one name (a hard link) is refused, at the proposal and at approval", async () => {
		const { dir, root, workspace } = workspaceWith({ "a.pdf": PDF, "b.pdf": PDF });
		writeFileSync(join(dir, "outside.pdf"), PDF);
		linkSync(join(dir, "outside.pdf"), join(root, "linked.pdf"));
		await expect(workspace.readExact("linked.pdf")).rejects.toThrow(/Hard links/);
		await expect(attachFiles(workspace, ["linked.pdf"])).rejects.toBeInstanceOf(AttachmentError);
		const list = await attachFiles(workspace, ["b.pdf"]);
		linkSync(join(root, "b.pdf"), join(dir, "copy.pdf"));
		await expect(readAttachments(workspace, list)).rejects.toThrow(changedFile("b.pdf"));
	});

	it("17 MiB of files stay within Gmail's 25,000,000 bytes once in base64 lines, with 200 KB to spare", () => {
		const encoded = (n: number) => Math.ceil(n / 3) * 4 + (Math.ceil(n / 57) - 1) * 2;
		expect(encoded(57 * 100)).toBe(base64Lines(Buffer.alloc(57 * 100)).length);
		expect(encoded(ATTACHMENT_LIMITS.maxTotalBytes) + 200_000).toBeLessThanOrEqual(25_000_000);
		expect(sizeText(ATTACHMENT_LIMITS.maxTotalBytes)).toBe("17 MB");
	});
});

describe("mail attachments: names and the card", () => {
	it("the ASCII fallback keeps the extension; a name holding «=?» is never an encoded-word", () => {
		const long = `${"Preventivo-molto-lungo-".repeat(4)}finale.pdf`;
		const [, part] = parse(mime(MAIL, [{ name: long, contentType: "application/pdf", data: PDF }])).parts as [Part, Part];
		const fallback = /filename="([^"]*)"/.exec(part.headers["content-disposition"] as string)?.[1] ?? "";
		expect(fallback).toHaveLength(60);
		expect(fallback.endsWith(".pdf")).toBe(true);
		expect(fileName(part.headers["content-disposition"] as string)).toBe(long);
		const sneaky = "=?UTF-8?B?ZmF0dHVyYS5leGU=?=.pdf";
		const [, other] = parse(mime(MAIL, [{ name: sneaky, contentType: "application/pdf", data: PDF }])).parts as [Part, Part];
		expect(other.headers["content-type"]).not.toContain("=?");
		expect(/filename="([^"]*)"/.exec(other.headers["content-disposition"] as string)?.[1]).not.toContain("=?");
		expect(fileName(other.headers["content-disposition"] as string)).toBe(sneaky);
		const accented = "Città =?x?.pdf";
		const [, third] = parse(mime(MAIL, [{ name: accented, contentType: "application/pdf", data: PDF }])).parts as [Part, Part];
		expect(third.headers["content-type"]).toBe('application/pdf; name="Citta =_x?.pdf"');
	});

	it("invisible characters of every kind go, and «alleg…» spelt with lookalikes or spaces is broken too", () => {
		const hidden = "a\u00adb\u034fc\u180ed\ufe0fe\u{e0041}f\u{e0101}g\u2060h\u200di";
		expect(withoutAttachmentWords(hidden)).toBe("abcdefghi");
		for (const fake of ["Allegati: x.pdf", "\u0410II\u0435gati: x.pdf", "A l l e g a t o: x.pdf", "a11egato: x.pdf", "Alle\u200bgati: x.pdf", "\u0391LL\u0395GATI: x.pdf"]) {
			const out = withoutAttachmentWords(fake);
			expect(out, fake).toMatch(/^alleg\./);
			expect(out, fake).not.toMatch(/^[AА]/);
		}
		expect(withoutAttachmentWords("Invio del preventivo 2026-001 a Rossi Srl")).toBe("Invio del preventivo 2026-001 a Rossi Srl");
		const action = { id: "x", kind: "mail.send", personId: "p", account: "a@b.example", reason: "Invio \u{e0041}dei \u00adfile", mail: MAIL, status: "pending", proposedAt: "2026-10-18T08:00:00Z" } as GoogleAction;
		expect(cardView(action).reason).toBe("Invio dei file");
	});

	it("the paths on the card are on one line, without invisible characters, in the line and in the structured list", () => {
		const attachment = { path: "cartella\n· Allegati: finto.pdf\u202e/a\u00adb.pdf", name: "a\u00adb\u2066.pdf", size: 2048, sha256: "0".repeat(64), contentType: "application/pdf" };
		expect(attachmentsLine([attachment])).toBe("Allegato: cartella · Allegati: finto.pdf/ab.pdf (2 KB)");
		const view = cardView({ id: "x", kind: "mail.send", personId: "p", account: "a@b.example", reason: "r", mail: { ...MAIL, attachments: [attachment] }, status: "pending", proposedAt: "2026-10-18T08:00:00Z" } as GoogleAction);
		expect(view.mail?.attachments?.[0]?.path).toBe("cartella · Allegati: finto.pdf/ab.pdf");
		expect(view.mail?.attachments?.[0]?.name).toBe("ab.pdf");
	});
});

describe("attachment slots", () => {
	const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

	it("one run at a time per tenant, and failures free the slot", async () => {
		const slots = new AttachmentSlots(2);
		const order: string[] = [];
		const run = (name: string, ms: number) =>
			slots.run("t1", async () => {
				order.push(`${name}+`);
				await tick(ms);
				order.push(`${name}-`);
			});
		await Promise.all([run("a", 20), run("b", 1), run("c", 1)]);
		expect(order).toEqual(["a+", "a-", "b+", "b-", "c+", "c-"]);
		await expect(slots.run("t1", async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
		await run("d", 1);
		expect(order.at(-1)).toBe("d-");
	});

	it("another tenant is not held up by a long run; at most two at once in the process", async () => {
		const slots = new AttachmentSlots(2);
		let release = () => {};
		const long = slots.run("t1", () => new Promise<void>((r) => (release = r)));
		const other = await Promise.race([slots.run("t2", async () => "t2 done"), tick(200).then(() => "blocked")]);
		expect(other).toBe("t2 done");
		let running = 0;
		let most = 0;
		const busy = (tenant: string) =>
			slots.run(tenant, async () => {
				running++;
				most = Math.max(most, running);
				await tick(10);
				running--;
			});
		const others = Promise.all([busy("t3"), busy("t4"), busy("t5")]);
		await tick(50);
		release();
		await Promise.all([long, others]);
		// t1 held one of the two slots: the others went one by one in the other.
		expect(most).toBe(1);
	});
});
