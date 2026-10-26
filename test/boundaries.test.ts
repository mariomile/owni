import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

function sourceFiles(dir: string): string[] {
	return readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
		.filter((name) => name.endsWith(".ts"))
		.map((name) => join(dir, name));
}

function importsOf(file: string): string[] {
	const text = readFileSync(join(ROOT, file), "utf8");
	const patterns = [
		/(?:import|export)[^;]*?from\s+["']([^"']+)["']/g, // import x from "y", export { x } from "y"
		/import\s+["']([^"']+)["']/g, // import "y"
		/import\s*\(\s*["']([^"']+)["']\s*\)/g, // import("y")
	];
	return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((m) => m[1] as string));
}

describe("module boundaries", () => {
	it("only src/core/adapters/pi-durable* imports Pi packages", () => {
		const offenders = sourceFiles("src")
			.filter((file) => !relative("src/core/adapters", file).startsWith("pi-durable"))
			.filter((file) => importsOf(file).some((spec) => spec.startsWith("@earendil-works/")));
		expect(offenders).toEqual([]);
	});

	it("the core imports nothing from channels", () => {
		const offenders = sourceFiles("src/core").filter((file) => importsOf(file).some((spec) => spec.includes("channels")));
		expect(offenders).toEqual([]);
	});
});
