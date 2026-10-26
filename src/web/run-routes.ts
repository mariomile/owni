import type { RunRecord } from "../core/run-store.ts";
import type { OwniRuntime } from "../core/runtime.ts";
import type { Person } from "./auth.ts";
import type { WebChannel } from "./channel.ts";
import { type AddRoute, HttpError } from "./http.ts";

type RunRoutesDeps = {
	readonly runtime: OwniRuntime;
	readonly tenantId: string;
	readonly access: (person: Person, instanceId: string) => Promise<unknown>;
	readonly channel: (instanceId: string) => WebChannel;
};

/** Private conversation history stays private, including from the tenant owner. */
export function runRoutes(route: AddRoute, { runtime, tenantId, access, channel }: RunRoutesDeps): void {
	const ownThread = async (person: Person, instanceId: string, threadId: string) => {
		await access(person, instanceId);
		const thread = await channel(instanceId).thread(threadId);
		if (thread === undefined || thread.personId !== person.id) throw new HttpError(404, "No such thread");
	};
	route("GET", "/api/instances/:id/runs", "person", async ({ person: p, params, url }) => {
		const instanceId = params[0];
		await access(p, instanceId);
		const threads = await channel(instanceId).threads(p.id);
		const requested = url.searchParams.get("sources")?.split(",");
		const allowed: readonly string[] = ["message", "schedule", "brief", "watch", "automation", "notice", "agent"];
		if (requested?.some((source) => !allowed.includes(source))) throw new HttpError(400, "Tipo di esecuzione non valido");
		// Filter before limiting: someone else's busy conversations must not hide this person's work.
		const runs = await runtime.listRuns(tenantId, instanceId, { channel: "web", threadIds: threads.map((thread) => thread.id), sources: requested as RunRecord["source"][] | undefined, limit: 100 });
		return { runs: runs.map(publicRun) };
	});
	route("GET", "/api/instances/:id/threads/:thread/runs", "person", async ({ person, params }) => {
		const [instanceId, threadId] = params;
		await ownThread(person, instanceId, threadId);
		const recent = await runtime.listRuns(tenantId, instanceId, { channel: "web", threadId, limit: 50 });
		const active = await runtime.currentRuns(tenantId, instanceId, { channel: "web", threadId });
		return { runs: [...new Map([...recent, ...active].map((run) => [run.id, run])).values()].map(publicRun) };
	});
	route("POST", "/api/instances/:id/threads/:thread/stop", "person", async ({ person, params }) => {
		const [instanceId, threadId] = params;
		await ownThread(person, instanceId, threadId);
		const result = await runtime.stopConversation(tenantId, instanceId, { channel: "web", threadId });
		await runtime.audit(tenantId).append({ type: "agent.run.stopped", instanceId, personId: person.id, cancelled: result.cancelled });
		return { cancelled: result.cancelled, runs: result.runs.map(publicRun) };
	});
}

/** Keep internal admission/delivery identifiers and initiating identities out of console events. */
export function publicRun(run: RunRecord) {
	return {
		id: run.id, instanceId: run.instanceId, threadId: run.threadId,
		status: run.status, source: run.source, sourceId: run.sourceId,
		createdAt: run.createdAt, updatedAt: run.updatedAt, startedAt: run.startedAt,
		finishedAt: run.finishedAt, cancelRequestedAt: run.cancelRequestedAt,
		progress: run.progress, error: run.error, delivery: run.delivery,
	};
}
