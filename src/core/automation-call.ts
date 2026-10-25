import { createHash, randomUUID } from "node:crypto";
import { type AutomationRate, automationData, automationText } from "./automations.ts";
import { EgressDenied, NotFound, UserNotAllowed } from "./errors.ts";
import type { OwniRuntime } from "./runtime.ts";

/** What an automazione's caller gets back: 202 once the run is admitted, otherwise why not. */
export type AutomationCall = { readonly status: 202 | 404 | 409 | 429; readonly error?: string };

/**
 * Another service calls an automazione (ADR 0060): the token must be its own, the person it acts
 * for still allowed, the hour's calls under the limit. The run is admitted like a task programmato
 * firing, once per `key` (the caller's Idempotency-Key, when it sends one: a retried delivery runs once).
 */
export async function callAutomation(
	runtime: OwniRuntime,
	call: { tenant: string; instance: string; id: string; token: string; body: Buffer; contentType: string | undefined; key: string | undefined },
	rate: AutomationRate,
): Promise<AutomationCall> {
	let store;
	try {
		await runtime.registry.getInstance(call.tenant, call.instance);
		store = runtime.automations(call.tenant, call.instance);
	} catch {
		return { status: 404, error: "Not found" };
	}
	const automation = call.token === "" ? undefined : store.check(call.id, call.token);
	if (automation === undefined) return { status: 404, error: "Not found" };
	// A delivery the service sends again (same Idempotency-Key): it ran, and it is not counted twice.
	const key = call.key === undefined || call.key === "" ? randomUUID() : createHash("sha256").update(call.key).digest("hex").slice(0, 32);
	const where = `${call.tenant}/${call.instance}/${automation.id}`;
	if (call.key !== undefined && call.key !== "" && rate.seen(where, key)) return { status: 202 };
	if (!rate.allow(where)) {
		await runtime.audit(call.tenant).append({ type: "automation.limited", instanceId: call.instance, automationId: automation.id });
		return { status: 429, error: "Troppe chiamate in un'ora" };
	}
	try {
		await runtime.submitScheduled(call.tenant, call.instance, {
			channel: automation.channel,
			threadId: automation.threadId,
			text: automationText(automation, automationData(call.body, call.contentType)),
			messageId: `automation:${automation.id}:${key}`,
			scheduleId: automation.id,
			onBehalfOf: automation.person,
			kind: "automation",
		});
	} catch (error) {
		// Its person lost access, or its chat's channel was turned off: the caller should stop.
		if (error instanceof UserNotAllowed || error instanceof EgressDenied) return { status: 409, error: "L'automazione non può più scrivere nella sua conversazione" };
		// The agente is being deleted.
		if (error instanceof NotFound) return { status: 404, error: "Not found" };
		throw error;
	}
	rate.ran(where, key);
	store.ran(automation.id);
	return { status: 202 };
}
