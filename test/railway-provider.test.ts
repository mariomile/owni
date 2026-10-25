import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RailwayCellProvider } from "../src/cloud/railway-provider.ts";
import { tempDataDir } from "./helpers.ts";

/** Fake Railway: the GraphQL API and the cells' domains, every call recorded. */
function fakeRailway(options: { failOn?: string; coldStarts?: number; errorMessage?: string } = {}) {
	const calls: { operation: string; variables: any; auth: string }[] = [];
	const health: string[] = [];
	let cold = options.coldStarts ?? 0;
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/healthz")) {
			health.push(url);
			// The first requests to a sleeping service get a 502 while it boots.
			if (cold > 0) {
				cold--;
				return new Response("Bad Gateway", { status: 502 });
			}
			return Response.json({ ok: true });
		}
		const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: any };
		const operation = /^mutation (\w+)/.exec(query)?.[1] ?? "query";
		calls.push({ operation, variables, auth: String((init?.headers as Record<string, string>).authorization) });
		if (operation === options.failOn) return Response.json({ errors: [{ message: options.errorMessage ?? "Not Authorized" }] });
		const data: Record<string, unknown> = {
			projectCreate: { projectCreate: { id: "prj1", environments: { edges: [{ node: { id: "env1", name: "production" } }] } } },
			serviceCreate: { serviceCreate: { id: "svc1" } },
			volumeCreate: { volumeCreate: { id: "vol1" } },
			variableCollectionUpsert: { variableCollectionUpsert: true },
			serviceInstanceUpdate: { serviceInstanceUpdate: true },
			serviceDomainCreate: { serviceDomainCreate: { domain: "owni-a1.up.railway.app" } },
			serviceInstanceDeployV2: { serviceInstanceDeployV2: "dep1" },
			projectDelete: { projectDelete: true },
		};
		return Response.json({ data: data[operation] });
	}) as typeof fetch;
	return { fetch: fetchImpl, calls, health };
}

const provider = (dataDir: string, railway: ReturnType<typeof fakeRailway>) =>
	new RailwayCellProvider({ token: "rw-token", image: "ghcr.io/buildrs/owni:latest", dataDir, fetch: railway.fetch, pollMs: 5, startTimeoutMs: 2_000 });

describe("Railway cell provider", () => {
	it("a refused variable never brings the cell's secrets into an error", async () => {
		const railway = fakeRailway({ failOn: "variableCollectionUpsert", errorMessage: `Invalid value "${"s".repeat(32)}" for OWNI_CELL_SECRET` });
		const failed = provider(tempDataDir(), railway).create("a1", { OWNI_CELL_SECRET: "s".repeat(32) });
		await expect(failed).rejects.toThrow(/variableCollectionUpsert: refused/);
		await expect(failed).rejects.not.toThrow(/sssss/);
	});

	it("a cell destroyed while it wakes stays destroyed", async () => {
		const railway = fakeRailway({ coldStarts: 5 });
		const cells = provider(tempDataDir(), railway);
		await cells.create("a1", {});
		const waking = cells.start("a1");
		await cells.destroy("a1");
		await waking.catch(() => {});
		expect(await cells.status("a1")).toBe("missing");
	});

	it("creates a project per cell, with the image, the EU region before the volume on /data, sleep on, without deploying yet", async () => {
		const railway = fakeRailway();
		const cells = provider(tempDataDir(), railway);
		await cells.create("a1", { OWNI_TENANT_ID: "a1", OWNI_CELL_SECRET: "s".repeat(32) });
		expect(railway.calls.map((c) => c.operation)).toEqual(["projectCreate", "serviceCreate", "serviceInstanceUpdate", "volumeCreate", "variableCollectionUpsert", "serviceDomainCreate"]);
		expect(railway.calls.every((c) => c.auth === "Bearer rw-token")).toBe(true);
		const byName = Object.fromEntries(railway.calls.map((c) => [c.operation, c.variables]));
		expect(byName.projectCreate.input.name).toBe("owni-a1");
		expect(byName.serviceCreate.input).toEqual({ projectId: "prj1", name: "owni", source: { image: "ghcr.io/buildrs/owni:latest" } });
		expect(byName.volumeCreate.input).toEqual({ projectId: "prj1", environmentId: "env1", serviceId: "svc1", mountPath: "/data" });
		expect(byName.variableCollectionUpsert.input).toMatchObject({ skipDeploys: true, variables: { OWNI_TENANT_ID: "a1", OWNI_DATA_DIR: "/data", PORT: "8080" } });
		expect(byName.serviceDomainCreate.input).toEqual({ environmentId: "env1", serviceId: "svc1", targetPort: 8080 });
		expect(byName.serviceInstanceUpdate).toMatchObject({ serviceId: "svc1", environmentId: "env1", input: { sleepApplication: true, region: "europe-west4-drams3a", healthcheckPath: "/healthz" } });
		expect(await cells.status("a1")).toBe("stopped");
		expect(await cells.baseUrl("a1")).toBe("https://owni-a1.up.railway.app");
		expect(await cells.list()).toEqual(["a1"]);
	});

	it("the first start deploys; a start waits out the cold start's 502s; stop only lets Railway put it to sleep", async () => {
		const railway = fakeRailway({ coldStarts: 3 });
		const dataDir = tempDataDir();
		const cells = provider(dataDir, railway);
		await cells.create("a1", {});
		await cells.start("a1");
		expect(railway.calls.filter((c) => c.operation === "serviceInstanceDeployV2")).toHaveLength(1);
		expect(railway.health).toHaveLength(4);
		expect(await cells.status("a1")).toBe("running");
		const before = railway.calls.length;
		await cells.stop("a1");
		expect(railway.calls.length).toBe(before);
		expect(await cells.status("a1")).toBe("stopped");
		// Waking again: no new deploy, just a request.
		await cells.start("a1");
		expect(railway.calls.filter((c) => c.operation === "serviceInstanceDeployV2")).toHaveLength(1);
		// A restarted control plane does not trust what it knew: the cell may have slept meanwhile.
		expect(await cells.status("a1")).toBe("running");
		// Only the control plane forgets, when it starts; `pnpm cloud status` from another process reads what is known.
		const reader = provider(dataDir, railway);
		expect(await reader.status("a1")).toBe("running");
		reader.forgetAwake();
		expect(await reader.status("a1")).toBe("stopped");
	});

	it("a failed create leaves no project behind; errors name the operation, never the token", async () => {
		const railway = fakeRailway({ failOn: "volumeCreate" });
		const dataDir = tempDataDir();
		const cells = provider(dataDir, railway);
		const failed = cells.create("a1", {});
		await expect(failed).rejects.toThrow("railway volumeCreate: Not Authorized");
		await expect(failed).rejects.not.toThrow(/rw-token/);
		expect(railway.calls.at(-1)).toMatchObject({ operation: "projectDelete", variables: { id: "prj1" } });
		expect(await cells.status("a1")).toBe("missing");
		await expect(cells.create("../x", {})).rejects.toThrow(/Invalid cell id/);
	});

	it("upgrade sets new variables and redeploys, keeping the volume; destroy deletes the project", async () => {
		const railway = fakeRailway();
		const dataDir = tempDataDir();
		const cells = provider(dataDir, railway);
		await cells.create("a1", {});
		await cells.upgrade("a1", { OWNI_MODEL_ID: "nuovo" });
		const tail = railway.calls.slice(-3);
		expect(tail.map((c) => c.operation)).toEqual(["serviceInstanceUpdate", "variableCollectionUpsert", "serviceInstanceDeployV2"]);
		// The current image, not the one the cell was made with.
		expect(tail[0]?.variables.input).toEqual({ source: { image: "ghcr.io/buildrs/owni:latest" } });
		expect(tail[1]?.variables.input.variables).toEqual({ OWNI_MODEL_ID: "nuovo" });
		expect(railway.calls.some((c) => c.operation === "volumeDelete")).toBe(false);
		await cells.destroy("a1");
		expect(railway.calls.at(-1)).toMatchObject({ operation: "projectDelete", variables: { id: "prj1" } });
		expect(await cells.list()).toEqual([]);
		expect(readFileSync(join(dataDir, "railway-cells.json"), "utf8")).not.toContain("rw-token");
	});
});
