/**
 * Accounting on a real model (ADR 0119): six questions whose answer is a number, on a 1000-row
 * invoice export and on a quote, scored against the true figure to the cent. Runs on the person's
 * Claude Code subscription (`claude auth login`), no API key. Prints one line per case and the tools used.
 */
import type { AddressInfo } from "node:net";
import { instanceId, tenantId } from "../../src/core/ids.ts";
import { tenantDir, workspaceDir } from "../../src/core/paths.ts";
import { UsageLedger } from "../../src/core/usage.ts";
import { Workspace } from "../../src/core/workspace.ts";
import { bootOwni } from "./owni.ts";

const MODEL = process.env.OWNI_MODEL_ID?.trim() || "sonnet";
const TURN_TIMEOUT_MS = 300_000;

// 1000 invoices, Italian export: «;» and the comma for decimals. Amounts in cents to know the truth.
const rows: { date: string; client: string; cents: number }[] = [];
for (let i = 0; i < 1000; i++) {
	const month = (i % 4) + 1;
	rows.push({ date: `2026-${String(month).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`, client: `Cliente ${(i * 13) % 41}`, cents: 2500 + ((i * 7919) % 180_000) });
}
const csv = ["Data;Numero;Cliente;Importo", ...rows.map((r, i) => `${r.date.split("-").reverse().join("/")};2026/${i + 1};${r.client};${Math.floor(r.cents / 100).toLocaleString("it-IT")},${String(r.cents % 100).padStart(2, "0")}`)].join("\n");

const sum = (list: typeof rows) => list.reduce((s, r) => s + r.cents, 0);
const byClient = new Map<string, number>();
for (const r of rows) byClient.set(r.client, (byClient.get(r.client) ?? 0) + r.cents);
const [topClient, topCents] = [...byClient].sort((a, b) => b[1] - a[1])[0] as [string, number];
const feb = rows.filter((r) => r.date.startsWith("2026-02"));

type Case = { id: string; text: string; cents: number[]; words?: string[] };
const FILE = "Il file è uploads/fatture.csv.";
const cases: Case[] = [
	{ id: "totale-marzo", text: `Quanto ho fatturato a marzo 2026? ${FILE}`, cents: [sum(rows.filter((r) => r.date.startsWith("2026-03")))] },
	{ id: "conteggio-cliente", text: `Quante fatture ho fatto a Cliente 7? ${FILE}`, cents: [rows.filter((r) => r.client === "Cliente 7").length * 100] },
	{ id: "miglior-cliente", text: `Qual è il cliente a cui ho fatturato di più in tutto, e quanto? ${FILE}`, cents: [topCents], words: [topClient] },
	{ id: "media-febbraio", text: `Qual è l'importo medio delle fatture di febbraio, al centesimo? ${FILE}`, cents: [Math.round(sum(feb) / feb.length)] },
	{ id: "preventivo", text: "Preventivo: 3 giornate di consulenza a 450 € l'una e 2 licenze a 129,90 € l'una, sconto del 10% sul totale, poi IVA al 22%. Quanto paga il cliente in tutto?", cents: [176756] },
	{ id: "rate", text: "Devo dividere 1.000 € in 3 rate al centesimo, con il resto sull'ultima: quanto è ogni rata?", cents: [33333, 33334] },
];

/** Every number in the reply, read both the Italian way and the English way, in cents. */
function centsIn(text: string): Set<number> {
	const found = new Set<number>();
	for (const token of text.match(/\d[\d.,]*/g) ?? []) {
		const t = token.replace(/[.,]$/, "");
		for (const [thousands, decimal] of [[".", ","], [",", "."]] as const) {
			const plain = t.split(thousands).join("").replace(decimal, ".");
			if (/^\d+(\.\d+)?$/.test(plain)) found.add(Math.round(Number(plain) * 100));
		}
	}
	return found;
}

/** Each case in an Owni of its own: the answer to one is not in the next one's conversation. */
async function ask(c: Case): Promise<{ reply?: string; tools: readonly string[]; offered: string[] }> {
	const boot = await bootOwni({ OWNI_LOCAL_PROVIDERS: "1", OWNI_MODEL_PROVIDER: "claude-code", OWNI_MODEL_ID: MODEL });
	try {
		const base = `http://127.0.0.1:${(boot.owni.server.address() as AddressInfo).port}`;
		const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token: boot.owni.ownerLink?.split("#")[1] }) });
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
		// biome-ignore lint: eval script
		const api = async (path: string, body?: unknown): Promise<any> => {
			const res = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { cookie, "x-owni": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
			if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
			return res.json();
		};
		const connected = await api("/api/providers/claude-code/connect", {});
		if (connected.provider?.status !== "connected") throw new Error(`Claude Code non collegato: ${connected.provider?.status} ${connected.provider?.error ?? ""}`);
		await new Workspace(workspaceDir(boot.dataDir, tenantId("default"), instanceId("owni"))).write("uploads/fatture.csv", csv);
		const ledger = new UsageLedger(tenantDir(boot.dataDir, tenantId("default")));
		const thread = (await api("/api/instances/owni/dm", {})).thread;
		await api(`/api/instances/owni/threads/${thread.id}/messages`, { text: c.text });
		let reply: string | undefined;
		for (const start = Date.now(); reply === undefined && Date.now() - start < TURN_TIMEOUT_MS; ) {
			const entries = (await api(`/api/instances/owni/threads/${thread.id}`)).entries as { from: string; text?: string }[];
			reply = entries.filter((e) => e.from === "owni" && e.text !== undefined).at(-1)?.text;
			if (reply === undefined) await new Promise((r) => setTimeout(r, 1000));
		}
		const turn = (await ledger.records()).find((r) => r.role === "agent" && r.threadId === thread.id);
		return { reply, tools: turn?.tools ?? [], offered: boot.tools.filter((t) => ["code_run", "table_query", "calculate"].includes(t)) };
	} finally {
		await boot.close();
	}
}

// `pnpm eval:agente:conti rate preventivo`: only these cases.
const chosen = process.argv.length > 2 ? cases.filter((c) => process.argv.slice(2).includes(c.id)) : cases;
let right = 0;
for (const c of chosen) {
	const { reply, tools, offered } = await ask(c);
	if (c === chosen[0]) console.log(`Modello: claude-code/${MODEL} · strumenti per i conti offerti: ${offered.join(", ")}`);
	const numbers = centsIn(reply ?? "");
	const ok = reply !== undefined && c.cents.every((n) => numbers.has(n)) && (c.words ?? []).every((w) => new RegExp(`\\b${w}\\b`).test(reply));
	if (ok) right++;
	console.log(`${ok ? "ok " : "NO "} ${c.id} · tool: ${tools.join(", ") || "nessuno"} · ${(reply ?? "(nessuna risposta)").replace(/\s+/g, " ").slice(0, 220)}`);
}
console.log(`Giusti: ${right}/${chosen.length}`);
