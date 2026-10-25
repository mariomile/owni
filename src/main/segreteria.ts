/**
 * `pnpm dev:segreteria`: the segreteria commerciale of one tenant, in one process.
 * Gmail in, HubSpot for leads, Telegram for the sales people's approval. Reads .env;
 * creates the tenant and the instance on first start and stores the credentials in the
 * tenant's secret store. Never sends a reply without Approva. `pnpm start` runs the same
 * segreteria next to the general agent and the web console.
 */
import { existsSync } from "node:fs";
import { piDurableEngine } from "../core/adapters/pi-durable.ts";
import { InstanceLocked } from "../core/errors.ts";
import { OwniRuntime } from "../core/runtime.ts";
import { SegreteriaConfigError, startSegreteria } from "../segreteria/boot.ts";
import { ConfigError, loadSegreteriaConfig, type SegreteriaConfig } from "./config.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

let config: SegreteriaConfig;
try {
	config = loadSegreteriaConfig(process.env);
} catch (error) {
	if (error instanceof ConfigError) {
		console.error(`owni: ${error.message}`);
		process.exit(1);
	}
	throw error;
}

const runtime = new OwniRuntime({ dataDir: config.dataDir, engine: piDurableEngine });
try {
	const running = await startSegreteria(runtime, config, (message) => console.error(message));
	console.error(
		`owni: segreteria tenant=${config.tenantId} instance=${config.instanceId} model=${config.modelProvider} ` +
			`sales=${config.salesUserIds.length}, mailbox every ${config.pollSeconds}s (Ctrl+C to stop)`,
	);
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => {
			void running.stop().finally(() => process.exit(0));
		});
	}
} catch (error) {
	if (error instanceof SegreteriaConfigError || error instanceof InstanceLocked) {
		console.error(`owni: ${error.message}`);
		process.exit(1);
	}
	throw error;
}
