import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { OwniRuntime, InstanceLocked } from "../src/core/index.ts";
import type { DurableEngine } from "../src/core/engine.ts";
import { runtimeWithInstance } from "./helpers.ts";
import { kill9, spawnFixture, type Worker } from "./processes.ts";

const workers: Worker[] = [];
afterEach(async () => {
	await Promise.all(workers.splice(0).map(kill9));
});

function lockWorker(mode: "hold" | "close", dataDir: string): Worker {
	const worker = spawnFixture("lock-worker.ts", [mode, dataDir]);
	workers.push(worker);
	return worker;
}

const ownerFile = (dataDir: string) => join(dataDir, "tenants", "acme", "instances", "ops", "instance.lock.owner");

describe("instance lock", () => {
	it("in one process: a second runtime cannot open an open instance, and can once it is closed", async () => {
		const { runtime, dataDir } = await runtimeWithInstance({});
		await runtime.openInstance("acme", "ops");

		const other = new OwniRuntime({ dataDir, engine: piDurableEngine });
		const error = await other.openInstance("acme", "ops").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(InstanceLocked);
		expect((error as Error).message).toContain(`Instance acme/ops is already open in another process (pid ${process.pid} on `);

		await runtime.close();
		await expect(other.openInstance("acme", "ops")).resolves.toBeDefined();
		await other.close();
	});

	it("in one process: an engine that fails to close and tools that fail to release still leave the instance closed, its lock free, and close repeatable", async () => {
		const { dataDir } = await runtimeWithInstance({});
		let engineCloses = 0;
		const failingClose: DurableEngine = {
			async open(options) {
				const session = await piDurableEngine.open(options);
				// The engine closes, then reports a failure, on its first close only.
				const close = async () => {
					engineCloses += 1;
					if (engineCloses > 1) return;
					await session.close();
					throw new Error("engine close failed");
				};
				return new Proxy(session, {
					get: (target, key) => {
						if (key === "close") return close;
						const value: unknown = Reflect.get(target, key, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
			},
		};
		let releases = 0;
		const runtime = new OwniRuntime({
			dataDir,
			engine: failingClose,
			tools: async () => ({
				tools: [],
				close: async () => {
					releases += 1;
					throw new Error("tool release failed");
				},
			}),
		});
		const instance = await runtime.openInstance("acme", "ops");

		// The engine's error is the one thrown; the tools were released all the same.
		await expect(runtime.close()).rejects.toThrow("engine close failed");
		expect(releases).toBe(1);

		// Closing again tries again only what failed and throws nothing more; then it is a no-op.
		await expect(instance.close()).resolves.toBeUndefined();
		expect(engineCloses).toBe(2);
		await expect(instance.close()).resolves.toBeUndefined();
		expect(engineCloses).toBe(2);
		expect(releases).toBe(1);

		// The lock was released by the failing close: the instance opens again.
		const next = new OwniRuntime({ dataDir, engine: piDurableEngine });
		await expect(next.openInstance("acme", "ops")).resolves.toBeDefined();
		await next.close();
	});

	it("across processes: the second fails with a clear error; SIGKILL of the owner frees the lock", async () => {
		const { runtime, dataDir } = await runtimeWithInstance({});
		await runtime.close();

		const owner = lockWorker("hold", dataDir);
		await owner.waitForLine("OPENED");

		const intruder = lockWorker("hold", dataDir);
		const refused = await intruder.waitForLine("LOCKED");
		expect(await intruder.exited).toBe(3);
		expect(refused).toContain("Instance acme/ops is already open in another process");
		expect(refused).toContain(`pid ${owner.child.pid} on `);

		// The owner dies without any cleanup: the kernel drops its lock, the owner file stays behind.
		await kill9(owner);
		expect(JSON.parse(readFileSync(ownerFile(dataDir), "utf8")).pid).toBe(owner.child.pid);

		const next = lockWorker("hold", dataDir);
		expect(await next.waitForLine("OPENED")).toBe(`OPENED ${next.child.pid}`);
		expect(JSON.parse(readFileSync(ownerFile(dataDir), "utf8")).pid).toBe(next.child.pid);
	});

	it("across processes: closing the instance releases the lock while the process lives on", async () => {
		const { runtime, dataDir } = await runtimeWithInstance({});
		await runtime.close();

		const first = lockWorker("close", dataDir);
		await first.waitForLine("CLOSED");
		const second = lockWorker("hold", dataDir);
		expect(await second.waitForLine("OPENED")).toBe(`OPENED ${second.child.pid}`);
		expect(first.child.exitCode).toBeNull();
	});
});
