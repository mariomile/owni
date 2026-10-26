import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningOwni, startOwni } from "../src/app.ts";
import { GOOGLE_SCOPE, GOOGLE_WRITE_SCOPE } from "../src/connectors/google.ts";
import { instanceId, tenantId } from "../src/core/ids.ts";
import { auditFile, workspaceDir } from "../src/core/paths.ts";
import { loadOwniConfig } from "../src/main/config.ts";

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "owni-mail-flows-"));
	dirs.push(dir);
	return dir;
}

/** A fake Google: sign-in, and the mails sent (the message as written). */
function fakeGoogle() {
	const sends: string[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const body = init?.body === undefined ? "" : String(init.body);
		if (url.pathname === "/token") {
			const form = new URLSearchParams(body);
			if (form.get("grant_type") === "authorization_code") return Response.json({ access_token: "at", refresh_token: "rt", scope: `openid email ${GOOGLE_SCOPE.gmail} ${GOOGLE_SCOPE.calendar} ${GOOGLE_WRITE_SCOPE.gmail} ${GOOGLE_WRITE_SCOPE.calendar}`, expires_in: 3600 });
			return Response.json({ access_token: "at2", expires_in: 3600 });
		}
		if (url.hostname === "openidconnect.googleapis.com") return Response.json({ email: "anna@example.com" });
		if (url.pathname === "/gmail/v1/users/me/messages/send") {
			sends.push(Buffer.from(JSON.parse(body).raw as string, "base64url").toString("utf8"));
			return Response.json({ id: "sent1", threadId: "t1" });
		}
		return Response.json({ error: "not found" }, { status: 404 });
	}) as typeof fetch;
	return { fetch: fetchImpl, sends };
}

/** The attachments of a raw message: name (RFC 2231 or quoted) and bytes. */
function attachmentsOf(raw: string): { name: string; data: Buffer }[] {
	const boundary = /boundary="([^"]+)"/.exec(raw)?.[1] as string;
	return raw
		.split(`--${boundary}`)
		.slice(2, -1)
		.map((part) => {
			const [head, body] = part.replace(/^\r\n/, "").split("\r\n\r\n") as [string, string];
			const unfolded = head.replace(/\r\n /g, " ");
			const star = /filename\*=UTF-8''([^;\s]+)/.exec(unfolded)?.[1];
			return { name: star === undefined ? (/filename="([^"]*)"/.exec(unfolded)?.[1] ?? "") : decodeURIComponent(star), data: Buffer.from(body, "base64") };
		});
}


describe("attachments in the app, through the approval card", () => {
	it("a mail with a workspace file reaches Gmail only once approved, byte for byte; the audit has counts only", async () => {
		const dataDir = temp();
		const google = fakeGoogle();
		const config = loadOwniConfig({ OWNI_DATA_DIR: dataDir, OWNI_MODEL_PROVIDER: "faux", OWNI_WEB_PORT: "1", OWNI_GOOGLE_CLIENT_ID: "c", OWNI_GOOGLE_CLIENT_SECRET: "s", OWNI_GOOGLE_WRITE: "1" });
		const owni: RunningOwni = await startOwni({ ...config, web: { ...config.web, port: 0 } }, { googleFetch: google.fetch, schedulerIntervalMs: 60_000, log: () => {} });
		closers.push(() => owni.stop());
		const base = `http://127.0.0.1:${(owni.server.address() as AddressInfo).port}`;
		const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token: (owni.ownerLink as string).split("#")[1] }) });
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
		const api = async (path: string, body?: unknown, method?: string) => {
			const res = await fetch(`${base}${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, "x-owni": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
			// biome-ignore lint: test
			return (await res.json()) as any;
		};
		const { url } = await api("/api/google/start", {});
		await api("/api/google/finish", { state: new URL(url).searchParams.get("state"), code: "good" });
		await api(`/api/instances/${config.instanceId}/capabilities/google`, { enabled: true }, "PUT");
		const workspace = workspaceDir(dataDir, tenantId(config.tenantId), instanceId(config.instanceId));
		mkdirSync(join(workspace, "offerte"), { recursive: true });
		const file = Buffer.from("%PDF-1.7\nofferta riservata Rossi\n");
		writeFileSync(join(workspace, "offerte", "Offerta-Rossi.pdf"), file);
		const thread = (await api(`/api/instances/${config.instanceId}/dm`, {})).thread as { id: string };
		const entries = async () => (await api(`/api/instances/${config.instanceId}/threads/${thread.id}`)).entries as { from: string; text?: string }[];
		const reply = async (text: string): Promise<string> => {
			const before = (await entries()).filter((e) => e.from === "owni").length;
			await api(`/api/instances/${config.instanceId}/threads/${thread.id}/messages`, { text });
			for (const start = Date.now(); Date.now() - start < 30_000; ) {
				const now = (await entries()).filter((e) => e.from === "owni");
				if (now.length > before) return now.at(-1)?.text ?? "";
				await new Promise((r) => setTimeout(r, 30));
			}
			throw new Error("no reply");
		};
		const outcome = async (id: string) => {
			for (const start = Date.now(); Date.now() - start < 10_000; ) {
				if ((await entries()).some((e) => e.text?.includes(`Esito della richiesta ${id}`))) return;
				await new Promise((r) => setTimeout(r, 30));
			}
			throw new Error("no outcome");
		};
		const decide = async (id: string, decision: string) => (await api(`/api/instances/${config.instanceId}/google-actions/${id}/decision`, { decision })).action;
		const cards = async () => (await api(`/api/instances/${config.instanceId}/google-actions`)).actions as { id: string; status: string; reason: string; mail?: { attachments?: { path: string; name: string; size: number }[] } }[];
		const send = { to: ["mario@rossi.example"], subject: "Offerta", body: "In allegato l'offerta.", attachments: ["offerte/Offerta-Rossi.pdf"], reason: "Invio dell'offerta a Rossi" };

		// Rejected: nothing sent.
		expect(await reply(`/tool google_mail_send ${JSON.stringify(send)}`)).toMatch(/Richiesta [0-9a-f]{12} pronta/);
		const [first] = await cards();
		expect(first?.reason).toBe(send.reason);
		expect(first?.mail?.attachments?.map((a) => [a.path, a.name])).toEqual([["offerte/Offerta-Rossi.pdf", "Offerta-Rossi.pdf"]]);
		expect((await decide(first?.id as string, "rejected")).status).toBe("rejected");
		await outcome(first?.id as string);
		expect(google.sends).toEqual([]);

		// Approved: sent byte for byte.
		await reply(`/tool google_mail_send ${JSON.stringify(send)}`);
		const card = (await cards()).find((c) => c.status === "pending") as { id: string };
		expect(google.sends).toEqual([]);
		expect((await decide(card.id, "approved")).status).toBe("done");
		await outcome(card.id);
		const sent = google.sends[0] as string;
		expect(sent).toContain("To: mario@rossi.example\r\n");
		const [pdf] = attachmentsOf(sent);
		expect(pdf?.name).toBe("Offerta-Rossi.pdf");
		expect(pdf?.data.equals(file)).toBe(true);

		// Changed while the card waits: the card fails and nothing leaves.
		await reply(`/tool google_mail_send ${JSON.stringify(send)}`);
		const stale = (await cards()).find((c) => c.status === "pending") as { id: string };
		writeFileSync(join(workspace, "offerte", "Offerta-Rossi.pdf"), "%PDF-1.7\ncambiata\n");
		expect((await decide(stale.id, "approved")).status).toBe("failed");
		expect(google.sends).toHaveLength(1);

		const audit = readFileSync(auditFile(dataDir, tenantId(config.tenantId)), "utf8");
		const approved = audit
			.split("\n")
			.filter((l) => l.includes("google_action.approved"))
			.map((l) => JSON.parse(l).attachments);
		expect(approved).toEqual([1, 1]);
		for (const secret of ["Rossi", "rossi.example", "Offerta-Rossi", "offerte/"]) expect(audit).not.toContain(secret);
	}, 60_000);
});
