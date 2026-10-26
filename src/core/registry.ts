import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AuditLog } from "./audit.ts";
import { NotFound } from "./errors.ts";
import { type InstanceId, instanceId, type TenantId, tenantId } from "./ids.ts";
import { instanceDir, instanceFile, removedDir, tenantDir, tenantFile } from "./paths.ts";
import { writeFileAtomic } from "./atomic-file.ts";
import type { Persona } from "./persona.ts";
import { type AllowedUsers, CHANNEL_PATTERN, DENY_ALL, type EgressPolicy } from "./policy.ts";

export type ModelSelection = {
	/** pi-ai provider ID, e.g. "anthropic". Must also be allowed by the egress policy. */
	readonly provider: string;
	readonly modelId: string;
};

export type TenantRecord = {
	readonly id: TenantId;
	readonly name: string;
	readonly createdAt: string;
};

export type InstanceRecord = {
	readonly id: InstanceId;
	readonly tenantId: TenantId;
	readonly name: string;
	readonly model: ModelSelection;
	readonly egress: EgressPolicy;
	/** Channel → user IDs allowed to talk to this instance. Missing channel: nobody. */
	readonly allowedUsers: AllowedUsers;
	/** Channel → user IDs who may approve this instance's actions (tools proposti). Missing: nobody. */
	readonly approvers?: AllowedUsers;
	readonly instructions?: string;
	/** Face and voice of the agente (ADR 0041); missing: Owni as she is. */
	readonly persona?: Persona;
	readonly createdAt: string;
};

export type CreateInstanceInput = {
	readonly id: string;
	readonly name: string;
	readonly model: ModelSelection;
	/** Omitted: deny everything. */
	readonly egress?: EgressPolicy;
	/** Omitted: nobody may talk to the instance on any channel. */
	readonly allowedUsers?: AllowedUsers;
	readonly approvers?: AllowedUsers;
	readonly instructions?: string;
	readonly persona?: Persona;
};

/**
 * The owner's view of all tenants and their instances, stored as JSON files under the
 * data directory. This is what a future owner dashboard reads and writes.
 */
export class TenantRegistry {
	/**
	 * Creations of the same instance in this process, one after the other: an orphan folder is set
	 * aside before the record is written, so two creations at once could set aside each other's
	 * folder between its mkdir and its write. In turn, the second finds the record and loses cleanly.
	 */
	private readonly creating = new Map<string, Promise<unknown>>();

	/** Each tenant's instance names, read from disk once and kept in step by the writers below. */
	private readonly names = new Map<TenantId, Map<string, string>>();

	constructor(readonly dataDir: string) {}

	async createTenant(input: { id: string; name: string }): Promise<TenantRecord> {
		const id = tenantId(input.id);
		const record: TenantRecord = { id, name: input.name, createdAt: new Date().toISOString() };
		await writeJsonExclusive(tenantFile(this.dataDir, id), record);
		await new AuditLog(this.dataDir, id).append({ type: "tenant.created" });
		return record;
	}

	async getTenant(id: string): Promise<TenantRecord> {
		const tenant = tenantId(id);
		const record = await readJson<TenantRecord>(tenantFile(this.dataDir, tenant));
		if (record === undefined) throw new NotFound(`Tenant "${tenant}" not found`);
		return record;
	}

	async listTenants(): Promise<TenantRecord[]> {
		const ids = await listDirs(join(this.dataDir, "tenants"));
		return Promise.all(ids.map((id) => this.getTenant(id)));
	}

	async createInstance(tenant: string, input: CreateInstanceInput): Promise<InstanceRecord> {
		const owner = await this.getTenant(tenant);
		const id = instanceId(input.id);
		const key = `${owner.id}/${id}`;
		const before = this.creating.get(key) ?? Promise.resolve();
		const run = before.catch(() => undefined).then(() => this.writeInstance(owner.id, id, input));
		this.creating.set(key, run);
		try {
			return await run;
		} finally {
			if (this.creating.get(key) === run) this.creating.delete(key);
		}
	}

	private async writeInstance(tenant: TenantId, id: InstanceId, input: CreateInstanceInput): Promise<InstanceRecord> {
		await this.setAsideOrphan(tenant, id);
		const record: InstanceRecord = {
			id,
			tenantId: tenant,
			name: input.name,
			model: input.model,
			egress: input.egress ?? DENY_ALL,
			allowedUsers: input.allowedUsers ?? {},
			...(input.approvers === undefined ? {} : { approvers: input.approvers }),
			...(input.instructions === undefined ? {} : { instructions: input.instructions }),
			...(input.persona === undefined || Object.keys(input.persona).length === 0 ? {} : { persona: input.persona }),
			createdAt: new Date().toISOString(),
		};
		await writeJsonExclusive(instanceFile(this.dataDir, tenant, id), record);
		this.names.get(tenant)?.set(id, record.name);
		await new AuditLog(this.dataDir, tenant).append({
			type: "instance.created",
			instanceId: id,
			modelProvider: input.model.provider,
			allowedModelProviders: record.egress.modelProviders.join(","),
			allowedChannels: record.egress.channels.join(","),
		});
		return record;
	}

	async getInstance(tenant: string, id: string): Promise<InstanceRecord> {
		const t = tenantId(tenant);
		const i = instanceId(id);
		const record = await readJson<InstanceRecord>(instanceFile(this.dataDir, t, i));
		if (record === undefined) throw new NotFound(`Instance "${i}" not found in tenant "${t}"`);
		return record;
	}

	/** Replace the users allowed on one channel. Takes effect the next time the instance is opened. */
	async setAllowedUsers(tenant: string, id: string, channel: string, userIds: readonly string[]): Promise<InstanceRecord> {
		if (!CHANNEL_PATTERN.test(channel)) throw new Error(`Invalid channel name "${channel}"`);
		const current = await this.getInstance(tenant, id);
		const record: InstanceRecord = { ...current, allowedUsers: { ...current.allowedUsers, [channel]: [...new Set(userIds)] } };
		await writeFileAtomic(instanceFile(this.dataDir, record.tenantId, record.id), `${JSON.stringify(record, null, 2)}\n`);
		await new AuditLog(this.dataDir, record.tenantId).append({
			type: "instance.allowlist.updated",
			instanceId: record.id,
			channel,
			users: record.allowedUsers[channel]?.length ?? 0,
		});
		return record;
	}

	/** Change name, instructions, persona or approvers. Takes effect the next time the instance is opened. */
	async updateInstance(tenant: string, id: string, change: { name?: string; instructions?: string | null; persona?: Persona | null; approvers?: AllowedUsers }): Promise<InstanceRecord> {
		const current = await this.getInstance(tenant, id);
		const { instructions: _old, persona: _face, ...rest } = current;
		const instructions = change.instructions === undefined ? current.instructions : change.instructions ?? undefined;
		const persona = change.persona === undefined ? current.persona : change.persona === null || Object.keys(change.persona).length === 0 ? undefined : change.persona;
		const record: InstanceRecord = {
			...rest,
			...(change.name === undefined ? {} : { name: change.name }),
			...(change.approvers === undefined ? {} : { approvers: change.approvers }),
			...(instructions === undefined ? {} : { instructions }),
			...(persona === undefined ? {} : { persona }),
		};
		await writeFileAtomic(instanceFile(this.dataDir, record.tenantId, record.id), `${JSON.stringify(record, null, 2)}\n`);
		this.names.get(record.tenantId)?.set(record.id, record.name);
		await new AuditLog(this.dataDir, record.tenantId).append({ type: "instance.updated", instanceId: record.id, fields: Object.keys(change).join(",") });
		return record;
	}

	/**
	 * Run the instance on another model, and allow its provider: added to the providers the
	 * owner already allowed, never in their place. The model takes effect the next time the
	 * instance is opened; the provider's key is reachable at once (the engine reads the policy as stored).
	 */
	async setModel(tenant: string, id: string, model: ModelSelection): Promise<InstanceRecord> {
		const current = await this.getInstance(tenant, id);
		const record: InstanceRecord = { ...current, model: { provider: model.provider, modelId: model.modelId }, egress: withModelProvider(current.egress, model.provider) };
		await writeFileAtomic(instanceFile(this.dataDir, record.tenantId, record.id), `${JSON.stringify(record, null, 2)}\n`);
		await new AuditLog(this.dataDir, record.tenantId).append({ type: "instance.model.updated", instanceId: record.id, modelProvider: model.provider, modelId: model.modelId });
		return record;
	}

	/**
	 * Allow one more model provider, keeping the rest of the policy as stored now: for a chat's own
	 * model (ADR 0036). Takes effect at once.
	 */
	async allowModelProvider(tenant: string, id: string, provider: string): Promise<InstanceRecord> {
		const current = await this.getInstance(tenant, id);
		if (current.egress.modelProviders.includes(provider)) return current;
		const record: InstanceRecord = { ...current, egress: withModelProvider(current.egress, provider) };
		await writeFileAtomic(instanceFile(this.dataDir, record.tenantId, record.id), `${JSON.stringify(record, null, 2)}\n`);
		await new AuditLog(this.dataDir, record.tenantId).append({ type: "instance.model_provider.allowed", instanceId: record.id, modelProvider: provider });
		return record;
	}

	/**
	 * Replace the egress policy. Model providers take effect at once (the engine reads the policy as
	 * stored); channels, connectors and sites the next time the instance is opened.
	 */
	async setEgress(tenant: string, id: string, egress: EgressPolicy): Promise<InstanceRecord> {
		const current = await this.getInstance(tenant, id);
		const record: InstanceRecord = { ...current, egress };
		await writeFileAtomic(instanceFile(this.dataDir, record.tenantId, record.id), `${JSON.stringify(record, null, 2)}\n`);
		await new AuditLog(this.dataDir, record.tenantId).append({
			type: "instance.egress.updated",
			instanceId: record.id,
			modelProviders: egress.modelProviders.join(","),
			channels: egress.channels.join(","),
			connectors: (egress.connectors ?? []).join(","),
		});
		return record;
	}

	/**
	 * Delete an instance and everything under its folder (ADR 0046). The folder is first moved
	 * aside in one step, so the instance is gone at once even if removing its files takes a while
	 * or fails half-way; what is left aside is removed again at the next start. The caller closes
	 * the instance first. The audit log keeps that it existed.
	 */
	async deleteInstance(tenant: string, id: string): Promise<void> {
		const record = await this.getInstance(tenant, id);
		try {
			await this.setAside(record.tenantId, record.id);
		} catch (error) {
			// Deleted meanwhile by someone else.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new NotFound(`Instance "${record.id}" not found in tenant "${record.tenantId}"`);
			throw error;
		}
		this.names.get(record.tenantId)?.delete(record.id);
		await new AuditLog(this.dataDir, record.tenantId).append({ type: "instance.deleted", instanceId: record.id, name: record.name });
		// The instance is gone already: files that resist are removed at the next start.
		await this.purgeRemoved(record.tenantId).catch(() => {});
	}

	/** Remove what deleted instances left aside. */
	async purgeRemoved(tenant: string): Promise<void> {
		await rm(removedDir(this.dataDir, tenantId(tenant)), { recursive: true, force: true });
	}

	/** Move an instance's folder out of `instances/` in one step. */
	private async setAside(tenant: TenantId, id: InstanceId): Promise<void> {
		const aside = join(removedDir(this.dataDir, tenant), `${id}-${randomBytes(6).toString("hex")}`);
		await mkdir(dirname(aside), { recursive: true });
		await rename(instanceDir(this.dataDir, tenant, id), aside);
	}

	/**
	 * A folder with no record: files a late writer put back after the instance was deleted. A new
	 * instance with the same ID starts without them.
	 */
	private async setAsideOrphan(tenant: TenantId, id: InstanceId): Promise<void> {
		if ((await readJson(instanceFile(this.dataDir, tenant, id))) !== undefined) return;
		await this.setAside(tenant, id).catch((error: unknown) => {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		});
	}

	async listInstances(tenant: string): Promise<InstanceRecord[]> {
		const t = tenantId(tenant);
		const ids = await listDirs(join(tenantDir(this.dataDir, t), "instances"));
		// A folder without its record (being deleted, or put back by a late write) is not an instance.
		const records = await Promise.all(ids.map((id) => this.getInstance(t, id).catch((error: unknown) => (error instanceof NotFound ? undefined : Promise.reject(error)))));
		return records.filter((r) => r !== undefined);
	}

	/**
	 * Each instance's ID and name, at once: for an agente's instructions, built on every request
	 * without waiting (ADR 0117). Read from disk on first use, then kept by create, update and
	 * delete. A folder without a readable record is skipped.
	 */
	instanceNamesSync(tenant: string): ReadonlyMap<string, string> {
		const t = tenantId(tenant);
		const kept = this.names.get(t);
		if (kept !== undefined) return kept;
		const names = new Map<string, string>();
		let ids: string[] = [];
		try {
			ids = readdirSync(join(tenantDir(this.dataDir, t), "instances"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
		} catch {
			// No instances yet.
		}
		for (const id of ids) {
			try {
				const record = JSON.parse(readFileSync(instanceFile(this.dataDir, t, instanceId(id)), "utf8")) as InstanceRecord;
				names.set(record.id, record.name);
			} catch {
				// Being made or deleted: not an instance now.
			}
		}
		this.names.set(t, names);
		return names;
	}
}

async function writeJsonExclusive(file: string, value: unknown): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	try {
		await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Already exists: ${file}`);
		throw error;
	}
}

async function readJson<T>(file: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(file, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function listDirs(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function withModelProvider(egress: EgressPolicy, provider: string): EgressPolicy {
	return egress.modelProviders.includes(provider) ? egress : { ...egress, modelProviders: [...egress.modelProviders, provider] };
}
