import { join } from "node:path";
import { readJsonFile, updateJsonFile } from "../core/locked-json.ts";
import type { CellProvider, CellStatus } from "./provider.ts";

export type RailwayCellOptions = {
	/** An account or workspace token (Authorization: Bearer). Never logged. */
	readonly token: string;
	/** A public image of Owni, e.g. ghcr.io/<owner>/owni:latest (built by .github/workflows/image.yml). */
	readonly image: string;
	/** Where the control plane keeps which Railway project is which cell. */
	readonly dataDir: string;
	/** Railway workspace (team) the projects go to; the token's default if unset. */
	readonly workspaceId?: string;
	/** Railway region of every cell; default EU West, Amsterdam. */
	readonly region?: string;
	readonly fetch?: typeof fetch;
	readonly log?: (message: string) => void;
	/** How long a deploy or a cold start has to answer /healthz. */
	readonly startTimeoutMs?: number;
	readonly pollMs?: number;
};

type CellRecord = { readonly projectId: string; readonly environmentId: string; readonly serviceId: string; readonly domain: string; readonly deployed: boolean; readonly awake: boolean };

const API = "https://backboard.railway.com/graphql/v2";
const DEFAULT_REGION = "europe-west4-drams3a";

/**
 * The GraphQL documents, in one place. Taken from Railway's public API as used by open-source
 * clients (October 2026); the first live run is the check (docs/week9.md).
 */
const GQL = {
	projectCreate: "mutation projectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { id environments { edges { node { id name } } } } }",
	serviceCreate: "mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }",
	volumeCreate: "mutation volumeCreate($input: VolumeCreateInput!) { volumeCreate(input: $input) { id } }",
	variables: "mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }",
	instance: "mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }",
	domain: "mutation serviceDomainCreate($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }",
	deploy: "mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }",
	projectDelete: "mutation projectDelete($id: String!) { projectDelete(id: $id) }",
} as const;

/**
 * Cells on Railway: one project per tenant (its own private network and volume), one service
 * from Owni's image with a volume on /data, in the EU region, with Railway's serverless mode on.
 *
 * Railway puts a service to sleep by itself after minutes without outbound traffic and wakes it
 * on the next request, so "stopped" here means stopped for the control plane: it stops talking
 * to the cell and lets Railway put it to sleep; `start` wakes it with a request, retrying while
 * the cold start answers 502. The control plane reaches a cell on its Railway domain, like any
 * self-hosted Owni behind https: the cell's own login and cell secret guard it.
 *
 * `serviceCreate` with an image may deploy at once, before variables and volume exist: that
 * first deploy cannot start (no configuration) and the first `start` deploys again with all of it.
 */
export class RailwayCellProvider implements CellProvider {
	private readonly file: string;
	private readonly fetchImpl: typeof fetch;
	private readonly starting = new Map<string, Promise<void>>();

	constructor(private readonly options: RailwayCellOptions) {
		this.file = join(options.dataDir, "railway-cells.json");
		this.fetchImpl = options.fetch ?? fetch;
	}

	/**
	 * For a control plane that is starting: it knows nothing of what slept meanwhile, so every cell
	 * counts as stopped and the first request wakes it properly (a cheap check if it is up). Only
	 * the control plane calls this; a status reader must not, or the running one loses track.
	 */
	forgetAwake(): void {
		updateJsonFile<Record<string, CellRecord>>(this.file, {}, (all) => Object.fromEntries(Object.entries(all).map(([id, cell]) => [id, { ...cell, awake: false }])));
	}

	/**
	 * Railway puts a service to sleep after 5 to 10 minutes without outbound traffic: the control
	 * plane must call a cell idle sooner, or its check would wake a cell that is already asleep.
	 */
	static readonly IDLE_MS = 4 * 60_000;

	async create(id: string, env: Readonly<Record<string, string>>): Promise<void> {
		assertId(id);
		if (this.record(id) !== undefined) throw new Error(`Cell ${id} exists`);
		const project = (await this.gql<{ projectCreate: { id: string; environments: { edges: { node: { id: string; name: string } }[] } } }>(GQL.projectCreate, {
			input: { name: `owni-${id}`, ...(this.options.workspaceId === undefined ? {} : { teamId: this.options.workspaceId }) },
		})).projectCreate;
		const environmentId = project.environments.edges[0]?.node.id;
		try {
			if (environmentId === undefined) throw new Error(`Railway project for ${id} has no environment`);
			const scope = { projectId: project.id, environmentId };
			const serviceId = (await this.gql<{ serviceCreate: { id: string } }>(GQL.serviceCreate, { input: { projectId: project.id, name: "owni", source: { image: this.options.image } } })).serviceCreate.id;
			// Region first, so the volume (the tenant's data) is made in the EU.
			await this.gql(GQL.instance, { serviceId, environmentId, input: { sleepApplication: true, region: this.options.region ?? DEFAULT_REGION, healthcheckPath: "/healthz" } });
			await this.gql(GQL.volumeCreate, { input: { ...scope, serviceId, mountPath: "/data" } });
			await this.gql(GQL.variables, {
				input: { ...scope, serviceId, skipDeploys: true, variables: { ...env, OWNI_DATA_DIR: "/data", OWNI_WEB_HOST: "0.0.0.0", OWNI_WEB_PORT: "8080", PORT: "8080" } },
			});
			const domain = (await this.gql<{ serviceDomainCreate: { domain: string } }>(GQL.domain, { input: { environmentId, serviceId, targetPort: 8080 } })).serviceDomainCreate.domain;
			this.save(id, { ...scope, serviceId, domain, deployed: false, awake: false });
		} catch (error) {
			// Nothing half made stays behind, and nothing keeps costing.
			await this.gql(GQL.projectDelete, { id: project.id }).catch((cleanup: unknown) => this.options.log?.(`railway: project ${project.id} of cell ${id} left behind, delete it by hand: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`));
			throw error;
		}
	}

	start(id: string): Promise<void> {
		const pending = this.starting.get(id);
		if (pending !== undefined) return pending;
		const starting = this.wake(id).finally(() => this.starting.delete(id));
		this.starting.set(id, starting);
		return starting;
	}

	/** The control plane stops talking to it; Railway puts it to sleep minutes later. */
	async stop(id: string): Promise<void> {
		await this.starting.get(id)?.catch(() => {});
		this.change(id, { awake: false });
	}

	async destroy(id: string): Promise<void> {
		const cell = this.record(id);
		if (cell === undefined) return;
		await this.gql(GQL.projectDelete, { id: cell.projectId });
		updateJsonFile<Record<string, CellRecord>>(this.file, {}, ({ [id]: _gone, ...rest }) => rest);
	}

	async status(id: string): Promise<CellStatus> {
		const cell = this.record(id);
		if (cell === undefined) return "missing";
		return cell.awake ? "running" : "stopped";
	}

	async list(): Promise<string[]> {
		return Object.keys(readJsonFile<Record<string, CellRecord>>(this.file, {}));
	}

	async baseUrl(id: string): Promise<string> {
		return `https://${this.must(id).domain}`;
	}

	/** The current image and new settings (a new model key), then a redeploy; the volume stays. */
	async upgrade(id: string, changes: Readonly<Record<string, string>> = {}): Promise<void> {
		const cell = this.must(id);
		await this.gql(GQL.instance, { serviceId: cell.serviceId, environmentId: cell.environmentId, input: { source: { image: this.options.image } } });
		if (Object.keys(changes).length > 0) await this.gql(GQL.variables, { input: { projectId: cell.projectId, environmentId: cell.environmentId, serviceId: cell.serviceId, skipDeploys: true, variables: changes } });
		await this.gql(GQL.deploy, { serviceId: cell.serviceId, environmentId: cell.environmentId });
		this.change(id, { deployed: true, awake: false });
	}

	private async wake(id: string): Promise<void> {
		const cell = this.must(id);
		if (!cell.deployed) {
			await this.gql(GQL.deploy, { serviceId: cell.serviceId, environmentId: cell.environmentId });
			this.change(id, { deployed: true });
		}
		// The first request to a sleeping service may get a 502 while it boots: keep asking.
		// Under a front proxy's usual 100 s: a request waiting on a cold start must not be cut first.
		const deadline = Date.now() + (this.options.startTimeoutMs ?? 90_000);
		while (Date.now() < deadline) {
			const ok = await this.fetchImpl(`https://${cell.domain}/healthz`, { signal: AbortSignal.timeout(10_000) })
				.then((r) => r.ok)
				.catch(() => false);
			if (ok) {
				this.change(id, { awake: true });
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 1_000));
		}
		throw new Error(`Cell ${id} did not answer in time`);
	}

	private async gql<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T> {
		const operation = /^mutation (\w+)/.exec(query)?.[1] ?? "query";
		const response = await this.fetchImpl(API, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${this.options.token}` },
			body: JSON.stringify({ query, variables }),
			signal: AbortSignal.timeout(30_000),
			redirect: "error",
		});
		const body = (await response.json().catch(() => ({}))) as { data?: T; errors?: { message?: string }[] };
		if (!response.ok || body.errors !== undefined || body.data === undefined) {
			// A refused value can be repeated in the error: the variables of a cell are its secrets.
			if (operation === "variableCollectionUpsert") throw new Error(`railway ${operation}: refused (HTTP ${response.status}; details left out, they may contain the cell's secrets)`);
			const message = body.errors?.map((e) => e.message).join("; ") || `HTTP ${response.status}`;
			throw new Error(`railway ${operation}: ${message.slice(0, 300)}`);
		}
		return body.data;
	}

	private record(id: string): CellRecord | undefined {
		return readJsonFile<Record<string, CellRecord>>(this.file, {})[id];
	}

	private must(id: string): CellRecord {
		const cell = this.record(id);
		if (cell === undefined) throw new Error(`No cell ${id}`);
		return cell;
	}

	private save(id: string, cell: CellRecord): void {
		updateJsonFile<Record<string, CellRecord>>(this.file, {}, (all) => ({ ...all, [id]: cell }));
	}

	/** Change fields of a cell as it is now; a cell destroyed meanwhile stays destroyed. */
	private change(id: string, fields: Partial<Pick<CellRecord, "deployed" | "awake">>): void {
		updateJsonFile<Record<string, CellRecord>>(this.file, {}, (all) => (all[id] === undefined ? all : { ...all, [id]: { ...all[id], ...fields } }));
	}
}

function assertId(id: string): void {
	if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new Error(`Invalid cell id ${id}`);
}
