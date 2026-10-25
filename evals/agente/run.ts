/**
 * Deterministic check of the general agent's eval cases (ADR 0099), in PR CI: every case has a
 * unique id and a text, and every tool it expects is one the agent really gets. A tool renamed
 * or removed turns this red before the nightly run measures the wrong thing.
 */
import { bootOwni, loadCases } from "./owni.ts";
import { selectCases } from "./report.ts";

const cases = selectCases(await loadCases(), process.argv.slice(2));
const { close, tools } = await bootOwni({ OWNI_MODEL_PROVIDER: "faux" });
await close();

const known = new Set(tools);
const errors: string[] = [];
const ids = new Set<string>();
for (const c of cases) {
	if (ids.has(c.id)) errors.push(`${c.id}: duplicate id`);
	ids.add(c.id);
	if (typeof c.text !== "string" || c.text.trim() === "") errors.push(`${c.id}: empty text`);
	if (!Array.isArray(c.expect)) errors.push(`${c.id}: expect must be a list`);
	for (const name of c.expect ?? []) if (!known.has(name)) errors.push(`${c.id}: the agent has no tool "${name}"`);
}
if (tools.length === 0) errors.push("the general agent got no tools");

for (const e of errors) console.error(`✗ ${e}`);
console.log(`eval:agente:catalog: ${cases.length} cases, ${tools.length} tools, ${errors.length} errors (catalog membership only)`);
process.exit(errors.length === 0 ? 0 : 1);
