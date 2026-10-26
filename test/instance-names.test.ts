import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { instanceId, tenantId } from "../src/core/ids.ts";
import { instanceFile } from "../src/core/paths.ts";
import { TenantRegistry } from "../src/core/registry.ts";
import { FAUX_MODEL, tempDataDir } from "./helpers.ts";

describe("instanceNamesSync", () => {
	it("reads the agent files once, and follows create, rename and delete", async () => {
		const dataDir = tempDataDir();
		const registry = new TenantRegistry(dataDir);
		await registry.createTenant({ id: "acme", name: "acme" });
		const make = (id: string, name: string) => registry.createInstance("acme", { id, name, model: FAUX_MODEL });
		await make("owni", "Owni");
		expect([...registry.instanceNamesSync("acme")]).toEqual([["owni", "Owni"]]);
		// Kept: a file changed behind the registry's back is not read again.
		const file = instanceFile(dataDir, tenantId("acme"), instanceId("owni"));
		writeFileSync(file, JSON.stringify({ id: "owni", name: "Changed on disk" }));
		expect(registry.instanceNamesSync("acme").get("owni")).toBe("Owni");
		// Create, rename and delete through the registry show at once.
		await make("conti", "Contabile");
		expect(registry.instanceNamesSync("acme").get("conti")).toBe("Contabile");
		await registry.updateInstance("acme", "conti", { name: "Contabilità" });
		expect(registry.instanceNamesSync("acme").get("conti")).toBe("Contabilità");
		writeFileSync(file, JSON.stringify({ id: "owni", name: "Owni", tenantId: "acme" }));
		await registry.deleteInstance("acme", "conti");
		expect([...registry.instanceNamesSync("acme").keys()]).toEqual(["owni"]);
		// A new registry over the same folder starts from what is on disk.
		expect(new TenantRegistry(dataDir).instanceNamesSync("acme").get("owni")).toBe("Owni");
	});
});
