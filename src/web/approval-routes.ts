import { randomUUID } from "node:crypto";
import { WebActionError } from "../core/web-actions.ts";
import { cardView, decideGoogleAction, GoogleActionError } from "../core/google-actions.ts";
import { connectorAction, decide, isApprover, NotAnApprover, toolProposal, type Approver, webAction } from "../core/approvals.ts";
import { ConnectorActionError } from "../core/connector-actions.ts";
import type { Pratica } from "../core/practice.ts";
import type { InstanceRecord } from "../core/registry.ts";
import type { OwniRuntime } from "../core/runtime.ts";
import type { Person } from "./auth.ts";
import { type AddRoute, HttpError, readJson } from "./http.ts";
import type { WebAppOptions } from "./server.ts";

export type ApprovalRoutesDeps = Pick<WebAppOptions, "segreterie" | "sendWebAction" | "runConnectorAction" | "google" | "board" | "log"> & {
	readonly runtime: OwniRuntime;
	readonly tenantId: string;
	readonly instanceAccess: (person: Person, instanceId: string) => Promise<{ readonly record: InstanceRecord; readonly member: boolean }>;
	readonly approverOf: (person: Person) => Approver;
	/** What the model cost today, for the console's rail. */
	readonly usageSummary: () => Promise<{ readonly todayUsd: number; readonly softUsd: number; readonly hardUsd: number }>;
};

/**
 * What waits for a person's decision (ADR 0011, 0021, 0025): tools proposti, forms to send,
 * connector calls, writes to Google, the segreteria's pratiche; and the inbox that gathers them.
 */
export function approvalRoutes(route: AddRoute, options: ApprovalRoutesDeps): void {
	const { runtime, tenantId, instanceAccess, approverOf, usageSummary } = options;
	const mayDecideAll = async (p: Person, instanceId: string) => isApprover(runtime, tenantId, instanceId, approverOf(p));
	/**
	 * A decision on one request, the same steps for every kind: the instance, the body, then what the
	 * kind does. Someone who may not decide it is refused with `refused`; a request that is not there
	 * (for Google, also someone else's: for this person, one that does not exist) answers 404.
	 */
	const decisionRoute = (requests: "proposals" | "web-actions" | "connector-actions" | "google-actions", decideIt: (p: Person, instance: string, id: string, decision: "approved" | "rejected") => Promise<unknown>, refused?: string) =>
		route("POST", `/api/instances/:id/${requests}/:rid/decision`, "person", async ({ person: p, params, req }) => {
			await instanceAccess(p, params[0]);
			const body = (await readJson(req)) as { decision?: string };
			if (body.decision !== "approved" && body.decision !== "rejected") throw new HttpError(400, "decision: approved | rejected");
			try {
				return await decideIt(p, params[0], params[1], body.decision);
			} catch (error) {
				if (error instanceof NotAnApprover && refused !== undefined) throw new HttpError(403, refused);
				if (error instanceof WebActionError || error instanceof ConnectorActionError || error instanceof GoogleActionError) throw new HttpError(404, "Richiesta inesistente");
				throw error;
			}
		});

	// --- tools proposti ---
	route("GET", "/api/instances/:id/proposals", "person", async ({ person, params }) => {
		await instanceAccess(person, params[0]);
		return { proposals: await runtime.proposals(tenantId, params[0]).list() };
	});
	decisionRoute("proposals", async (p, instance, id, decision) => ({ proposal: await decide(toolProposal, runtime, tenantId, instance, id, decision, approverOf(p)) }), "Non sei un approvatore di questo agente");

	// --- forms Owni asked to send (web_submit): the person who asked, or an approver, decides ---
	route("GET", "/api/instances/:id/web-actions", "person", async ({ person: p, params }) => {
		await instanceAccess(p, params[0]);
		const all = await runtime.webActions(tenantId, params[0]).list();
		const everyone = await mayDecideAll(p, params[0]);
		return { actions: everyone ? all : all.filter((a) => a.requester === `web:${p.id}`) };
	});
	decisionRoute(
		"web-actions",
		async (p, instance, id, decision) => {
			if (options.sendWebAction === undefined) throw new HttpError(501, "Le azioni sul web non sono disponibili su questo server");
			return { action: await decide(webAction(options.sendWebAction(instance)), runtime, tenantId, instance, id, decision, approverOf(p)) };
		},
		"Questa richiesta la decide chi l'ha fatta o un approvatore",
	);
	// --- connector calls that change something (ADR 0025): the person who asked, or an approver, decides ---
	route("GET", "/api/instances/:id/connector-actions", "person", async ({ person: p, params }) => {
		await instanceAccess(p, params[0]);
		const all = await runtime.connectorActions(tenantId, params[0]).list();
		const everyone = await mayDecideAll(p, params[0]);
		return { actions: everyone ? all : all.filter((a) => a.requester === `web:${p.id}`) };
	});
	decisionRoute(
		"connector-actions",
		async (p, instance, id, decision) => {
			if (options.runConnectorAction === undefined) throw new HttpError(501, "Le azioni dei connettori non sono disponibili su questo server");
			return { action: await decide(connectorAction(options.runConnectorAction(instance)), runtime, tenantId, instance, id, decision, approverOf(p)) };
		},
		"Questa richiesta la decide chi l'ha fatta o un approvatore",
	);
	// --- writes to a person's Google account (ADR 0021): only that person sees and decides them ---
	route("GET", "/api/instances/:id/google-actions", "person", async ({ person: p, params }) => {
		await instanceAccess(p, params[0]);
		return { actions: (await runtime.googleActions(tenantId, params[0]).list()).filter((a) => a.personId === p.id).map(cardView) };
	});
	decisionRoute("google-actions", async (p, instance, id, decision) => {
		const run = options.google?.runAction;
		if (run === undefined) throw new HttpError(501, "Google non può scrivere su questo server");
		return { action: cardView(await decideGoogleAction(runtime, tenantId, instance, id, decision, p.id, run(instance), options.log)) };
	});

	// --- segreteria ---
	const publicPractices = (all: readonly Pratica[]) => [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ mail: _mail, ...p }) => p);
	route("GET", "/api/instances/:id/pratiche", "person", async ({ person, params }) => {
		await instanceAccess(person, params[0]);
		const service = options.segreterie?.get(params[0]);
		if (service === undefined) throw new HttpError(404, "Questo agente non è una segreteria");
		const all = await service.practices.list();
		return { pratiche: publicPractices(all) };
	});
	route("POST", "/api/instances/:id/pratiche/:pid/action", "person", async ({ person: p, params, req }) => {
		await instanceAccess(p, params[0]);
		const service = options.segreterie?.get(params[0]);
		if (service === undefined) throw new HttpError(404, "Questo agente non è una segreteria");
		if (!(await isApprover(runtime, tenantId, params[0], approverOf(p)))) throw new HttpError(403, "Non sei un approvatore di questo agente");
		const body = (await readJson(req)) as { action?: string; text?: string; requestId?: string; draftVersion?: number };
		if (body.action !== "approve" && body.action !== "edit" && body.action !== "discard") throw new HttpError(400, "action: approve | edit | discard");
		const result = await service.act({ userId: `web:${p.id}` }, params[1], body.action, {
			...(typeof body.text === "string" ? { text: body.text } : {}),
			...(typeof body.draftVersion === "number" ? { draftVersion: body.draftVersion } : {}),
			actionId: typeof body.requestId === "string" ? body.requestId.slice(0, 80) : randomUUID(),
		});
		return { result: result.kind === "handled" ? { kind: "handled", sent: result.sent, status: result.pratica.status } : result };
	});

	// The inbox and rail share the same eligible objects across every visible instance. Counts
	// skip the public payload projections; no source failure is turned into an empty queue.
	const collectApprovals = async (p: Person, includeGroups: boolean) => {
		const visible = (await runtime.registry.listInstances(tenantId)).filter((r) => p.role === "owner" || (r.allowedUsers.web ?? []).includes(p.id));
		const groups = [];
		let pendingApprovals = 0;
		const now = new Date();
		for (const r of visible) {
			const approver = await mayDecideAll(p, r.id);
			const [allWeb, allConnectors, allGoogle, proposals, practices] = await Promise.all([
				runtime.webActions(tenantId, r.id).list(now),
				runtime.connectorActions(tenantId, r.id).list(now),
				runtime.googleActions(tenantId, r.id).list(now),
				approver ? runtime.proposals(tenantId, r.id).list() : [],
				approver ? (options.segreterie?.get(r.id)?.practices.list() ?? []) : [],
			]);
			const webActions = approver ? allWeb : allWeb.filter((a) => a.requester === `web:${p.id}`);
			const connectorActions = approver ? allConnectors : allConnectors.filter((a) => a.requester === `web:${p.id}`);
			const googleActions = allGoogle.filter((a) => a.personId === p.id);
			for (const items of [proposals, webActions, connectorActions, googleActions]) {
				pendingApprovals += items.filter((a) => a.status === "pending").length;
			}
			pendingApprovals += practices.filter((a) => a.status === "draft_ready").length;
			if (includeGroups) groups.push({
				instance: { id: r.id, name: r.name, isApprover: approver },
				proposals,
				webActions,
				connectorActions,
				googleActions: googleActions.map(cardView),
				pratiche: publicPractices(practices),
			});
		}
		return { groups, pendingApprovals };
	};
	route("GET", "/api/approvals", "person", async ({ person }) => collectApprovals(person, true));
	route("GET", "/api/console-summary", "person", async ({ person: p }) => {
		const { pendingApprovals } = await collectApprovals(p, false);
		let boardReview = 0;
		if (options.board !== undefined) {
			for (const card of options.board.store.list()) {
				if (card.status !== "da_rivedere") continue;
				const mine = card.work !== undefined && card.work.agent === card.assignee ? card.work.personId === p.id : p.role === "owner";
				if (mine && await options.board.work.visibleTo(card, p.id)) boardReview++;
			}
		}
		return { usage: await usageSummary(), pendingApprovals, boardReview };
	});
}
