/**
 * Child process for test/lock.test.ts.
 *
 *   lock-worker.ts hold  <dataDir>   open instance acme/ops and keep it open
 *   lock-worker.ts close <dataDir>   open it, close it, stay alive
 *
 * stdout: OPENED <pid>, CLOSED, or LOCKED <error message> (then exit code 3).
 */
import { piDurableEngine } from "../../src/core/adapters/pi-durable.ts";
import { OwniRuntime, InstanceLocked } from "../../src/core/index.ts";

const [mode, dataDir] = process.argv.slice(2) as [string, string];
const runtime = new OwniRuntime({ dataDir, engine: piDurableEngine });
try {
	await runtime.openInstance("acme", "ops");
	console.log(`OPENED ${process.pid}`);
} catch (error) {
	if (!(error instanceof InstanceLocked)) throw error;
	console.log(`LOCKED ${error.message}`);
	process.exit(3);
}
if (mode === "close") {
	await runtime.close();
	console.log("CLOSED");
}
setInterval(() => {}, 1000);
