/**
 * `pnpm start`: Owni for one tenant in one process. Reads .env (see .env.example), creates
 * what is missing on first start and prints the owner's login link once.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startOwni } from "../app.ts";
import { InstanceLocked } from "../core/errors.ts";
import { SegreteriaConfigError } from "../segreteria/boot.ts";
import { type OwniConfig, ConfigError, loadOwniConfig } from "./config.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

let config: OwniConfig;
try {
	config = loadOwniConfig(process.env);
} catch (error) {
	if (error instanceof ConfigError) {
		console.error(`owni: ${error.message}`);
		process.exit(1);
	}
	throw error;
}

try {
	const owni = await startOwni(config);
	const url = config.web.publicUrl ?? `http://${config.web.host === "0.0.0.0" ? "localhost" : config.web.host}:${config.web.port}`;
	console.error(
		`owni: tenant=${config.tenantId} instance=${config.instanceId} model=${config.modelProvider}/${config.modelId} ` +
			`web=${url}${config.telegram === undefined ? "" : " telegram=on"}${owni.segreteria === undefined ? "" : ` segreteria=${owni.segreteria.instanceId}`}`,
	);
	if (owni.ownerLink !== undefined) {
		// Not in the logs (docker compose logs keeps them): only on a terminal, and in a 0600 file.
		const file = join(config.dataDir, "owner-login-link.txt");
		if (process.stderr.isTTY) console.error(`owni: first start. Owner login link (keep it private):\n\n  ${owni.ownerLink}\n`);
		console.error(`owni: first start. The owner's login link is in ${file} (read it, then delete the file). New links: pnpm owni person link <id>`);
	}
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => {
			void owni.stop().finally(() => process.exit(0));
		});
	}
} catch (error) {
	if (error instanceof SegreteriaConfigError || error instanceof InstanceLocked) {
		console.error(`owni: ${error.message}`);
		process.exit(1);
	}
	throw error;
}
