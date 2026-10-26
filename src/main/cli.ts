/**
 * `pnpm owni <command>`: what the owner does from the command line.
 *
 *   person add <name> [--owner] [--instance <id>]...   create a person, print their login link
 *   person list
 *   person link <id>                                    new login link (the old one stops working)
 *   person remove <id>
 *   person reset-2fa <id>                               turn off two-factor login (lost phone)
 *   check                                               do the keys in .env work, are the services reachable?
 *   brief                                               who gets the brief del mattino, and who uses it (last 7 days)
 *   usage                                               what the agenti's turns took: tokens, cost, tools (last 7 days)
 *
 * Works on the data directory; Owni can be running.
 */
import { withChannel } from "../core/policy.ts";
import { existsSync } from "node:fs";
import { AuditLog } from "../core/audit.ts";
import { briefStats } from "../core/brief.ts";
import { instanceId as toInstanceId, tenantId as toTenantId } from "../core/ids.ts";
import { schedulesDir, tenantDir } from "../core/paths.ts";
import { ScheduleStore } from "../core/schedules.ts";
import { turnStats, UsageLedger } from "../core/usage.ts";
import { TenantRegistry } from "../core/registry.ts";
import { PeopleStore, SessionStore } from "../web/auth.ts";
import { runChecks } from "./check.ts";
import { ConfigError, loadOwniConfig } from "./config.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

const dataDir = process.env.OWNI_DATA_DIR?.trim() || "data";
const tenant = process.env.OWNI_TENANT_ID?.trim() || "default";
const base = process.env.OWNI_PUBLIC_URL?.trim().replace(/\/+$/, "") || `http://localhost:${process.env.OWNI_WEB_PORT?.trim() || "8080"}`;
const dir = tenantDir(dataDir, toTenantId(tenant));
const people = new PeopleStore(dir);
const registry = new TenantRegistry(dataDir);

const [group, command, ...rest] = process.argv.slice(2);

function usage(): never {
	console.error("usage: pnpm owni person add <name> [--owner] [--instance <id>]... | person list | person link <id> | person remove <id> | person reset-2fa <id> | check | brief | usage");
	process.exit(2);
}

if (group === "check") {
	let config: ReturnType<typeof loadOwniConfig>;
	try {
		config = loadOwniConfig(process.env);
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		console.log(`✗ Configurazione: ${error.message}`);
		process.exit(1);
	}
	const results = await runChecks(config);
	for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}: ${r.detail}`);
	process.exit(results.every((r) => r.ok) ? 0 : 1);
}

if (group === "brief") {
	// Brief thread → its person, from every instance's tasks programmati.
	const threads = new Map<string, string>();
	for (const instance of await registry.listInstances(tenant)) {
		for (const s of await new ScheduleStore(schedulesDir(dataDir, toTenantId(tenant), toInstanceId(instance.id))).list()) {
			if (s.kind === "brief" && s.createdBy.kind === "person") threads.set(s.threadId, s.createdBy.userId);
		}
	}
	const stats = briefStats(await new AuditLog(dataDir, toTenantId(tenant)).read(), threads, new Date());
	console.log(`Brief attivi: ${stats.active}`);
	console.log(`Ultimi 7 giorni: ${stats.deliveries} brief consegnati a ${stats.peopleDelivered} persone; ${stats.peopleWhoWrote} hanno poi scritto nella chat del brief.`);
	process.exit(0);
}

if (group === "usage") {
	const stats = turnStats(await new UsageLedger(tenantDir(dataDir, toTenantId(tenant))).records(), new Date());
	const usd = (n: number) => `$${n.toFixed(4)}`;
	console.log(`Ultimi 7 giorni: ${stats.turns} turni, ${stats.inputTokens} token in entrata, ${stats.outputTokens} in uscita, ${usd(stats.costUsd)}.`);
	for (const i of stats.instances) console.log(`  ${i.instanceId}: ${i.turns} turni, ${usd(i.costUsd)}`);
	if (stats.tools.length > 0) console.log(`Strumenti più usati: ${stats.tools.map((t) => `${t.name} (${t.calls})`).join(", ")}`);
	process.exit(0);
}

if (group !== "person") usage();

switch (command) {
	case "add": {
		const instances: string[] = [];
		const words: string[] = [];
		let owner = false;
		for (let i = 0; i < rest.length; i++) {
			const arg = rest[i] as string;
			if (arg === "--owner") owner = true;
			else if (arg === "--instance") instances.push(rest[++i] ?? usage());
			else words.push(arg);
		}
		if (words.length === 0) usage();
		const { person, token } = await people.add(words.join(" "), owner ? "owner" : "member");
		for (const id of instances) {
			const record = await registry.getInstance(tenant, id);
			await registry.setAllowedUsers(tenant, id, "web", [...(record.allowedUsers.web ?? []), person.id]);
			await registry.setEgress(tenant, id, (egress) => withChannel(egress, "web", true));
		}
		console.log(`${person.name} (${person.role}) ${person.id}${instances.length > 0 ? `, instances: ${instances.join(", ")}` : ""}\nLogin link (give it privately; it works until replaced):\n\n  ${base}/login#${token}\n`);
		break;
	}
	case "list":
		for (const p of await people.list()) console.log(`${p.id}\t${p.role}\t${p.name}\t${p.createdAt}${p.totp === undefined ? "" : "\t2FA"}`);
		break;
	case "link": {
		const id = rest[0] ?? usage();
		if ((await people.get(id)) === undefined) {
			console.error(`No person ${id}. See: pnpm owni person list`);
			process.exit(1);
		}
		const token = await people.rotate(id);
		await new SessionStore(dir).endAllOf(id);
		console.log(`New login link for ${id} (the old one and its sessions are revoked):\n\n  ${base}/login#${token}\n`);
		break;
	}
	case "remove": {
		const id = rest[0] ?? usage();
		const removed = await people.remove(id);
		await new SessionStore(dir).endAllOf(id);
		console.log(removed ? `Removed ${id}.` : `No person ${id}.`);
		break;
	}
	case "reset-2fa": {
		const id = rest[0] ?? usage();
		if ((await people.get(id)) === undefined) {
			console.error(`No person ${id}. See: pnpm owni person list`);
			process.exit(1);
		}
		await people.clearTotp(id);
		await new SessionStore(dir).endAllOf(id);
		console.log(`Two-factor login is off for ${id}; their sessions are ended and their link alone logs in again.`);
		break;
	}
	default:
		usage();
}
