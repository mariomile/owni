import { join } from "node:path";
import type { InstanceId, TenantId } from "./ids.ts";

/**
 * On-disk layout. Everything a tenant owns lives under its own directory:
 *
 *   <dataDir>/tenants/<tenantId>/tenant.json
 *   <dataDir>/tenants/<tenantId>/secrets.json          (mode 0600)
 *   <dataDir>/tenants/<tenantId>/audit.jsonl           (append-only)
 *   <dataDir>/tenants/<tenantId>/instances/<instanceId>/instance.json
 *   <dataDir>/tenants/<tenantId>/instances/<instanceId>/instance.lock (held while a process has it open)
 *   <dataDir>/tenants/<tenantId>/instances/<instanceId>/engine/   (durable engine storage)
 *   <dataDir>/tenants/<tenantId>/instances/<instanceId>/outbox/   (replies until their channel confirms them)
 *   <dataDir>/tenants/<tenantId>/removed/              (deleted instances, until their files are gone)
 */
export function tenantDir(dataDir: string, tenant: TenantId): string {
	return join(dataDir, "tenants", tenant);
}

export function tenantFile(dataDir: string, tenant: TenantId): string {
	return join(tenantDir(dataDir, tenant), "tenant.json");
}

export function secretsFile(dataDir: string, tenant: TenantId): string {
	return join(tenantDir(dataDir, tenant), "secrets.json");
}

export function auditFile(dataDir: string, tenant: TenantId): string {
	return join(tenantDir(dataDir, tenant), "audit.jsonl");
}

/** Where a deleted instance's folder is moved before its files are removed (ADR 0046). */
export function removedDir(dataDir: string, tenant: TenantId): string {
	return join(tenantDir(dataDir, tenant), "removed");
}

export function instanceDir(dataDir: string, tenant: TenantId, instance: InstanceId): string {
	return join(tenantDir(dataDir, tenant), "instances", instance);
}

export function instanceFile(dataDir: string, tenant: TenantId, instance: InstanceId): string {
	return join(instanceDir(dataDir, tenant, instance), "instance.json");
}

export function engineDir(dataDir: string, tenant: TenantId, instance: InstanceId): string {
	return join(instanceDir(dataDir, tenant, instance), "engine");
}

export function lockFile(dataDir: string, tenant: TenantId, instance: InstanceId): string {
	return join(instanceDir(dataDir, tenant, instance), "instance.lock");
}

export function webActionsDir(dataDir: string, tenant: TenantId, instance: InstanceId): string {
	return join(instanceDir(dataDir, tenant, instance), "web-actions");
}

export function googleActionsDir(dataDir: string, tenant: TenantId, instance: InstanceId): string {
	return join(instanceDir(dataDir, tenant, instance), "google-actions");
}

export function connectorActionsDir(dataDir: string, tenant: TenantId, instance: InstanceId): string {
	return join(instanceDir(dataDir, tenant, instance), "connector-actions");
}

/** What each agente that wrote to this one last asked, per conversation (ADR 0108). */
export function agentAsksFile(dataDir: string, tenant: TenantId, instance: InstanceId): string {
	return join(instanceDir(dataDir, tenant, instance), "agent-asks.json");
}

export function proposalsDir(dataDir: string, tenant: TenantId, instance: InstanceId): string {
	return join(instanceDir(dataDir, tenant, instance), "proposals");
}

/** Approved tools' own folders, and the sandbox runner. */
export function customToolsDir(dataDir: string, tenant: TenantId, instance: InstanceId): string {
	return join(instanceDir(dataDir, tenant, instance), "tools");
}

export function schedulesDir(dataDir: string, tenant: TenantId, instance: InstanceId): string {
	return join(instanceDir(dataDir, tenant, instance), "schedules");
}

export function watchesDir(dataDir: string, tenant: TenantId, instance: InstanceId): string {
	return join(instanceDir(dataDir, tenant, instance), "watches");
}

export function workspaceDir(dataDir: string, tenant: TenantId, instance: InstanceId): string {
	return join(instanceDir(dataDir, tenant, instance), "workspace");
}

export function outboxDir(dataDir: string, tenant: TenantId, instance: InstanceId): string {
	return join(instanceDir(dataDir, tenant, instance), "outbox");
}
