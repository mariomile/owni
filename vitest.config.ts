import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 60_000,
		// Closing a real browser or a server at the end of a test legitimately takes more than the default 10s when the whole suite runs in parallel.
		hookTimeout: 60_000,
		pool: "forks",
	},
});
