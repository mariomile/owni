import { describe, expect, it } from "vitest";
import { runChecks } from "../src/main/check.ts";
import { loadOwniConfig } from "../src/main/config.ts";

const SECRETS = { ANTHROPIC_API_KEY: "sk-ant-secret-1", TELEGRAM_BOT_TOKEN: "111:tg-secret" };
const ENV = SECRETS;

type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

/** A fake internet: each host answers with its route, any other host is unreachable. */
function internet(routes: Record<string, Route>): { fetch: typeof fetch; calls: string[] } {
	const calls: string[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		calls.push(`${url.host}${url.pathname}`);
		const route = routes[url.host];
		if (route === undefined) throw new TypeError("fetch failed");
		return route(url, init);
	}) as typeof fetch;
	return { fetch: fetchImpl, calls };
}

const healthy: Record<string, Route> = {
	"api.anthropic.com": (_url, init) => (new Headers(init?.headers).get("x-api-key") === SECRETS.ANTHROPIC_API_KEY ? Response.json({ data: [{ id: "claude-sonnet-5-5" }] }) : Response.json({ error: {} }, { status: 401 })),
	"api.telegram.org": () => Response.json({ ok: true, result: { username: "owni_bot" } }),
};

describe("pnpm owni check", () => {
	it("a provider without a model list here: the key is there, the first reply proves it", async () => {
		const net = internet({});
		const [model] = await runChecks(loadOwniConfig({ OWNI_MODEL_PROVIDER: "google", GEMINI_API_KEY: "g-secret" }), net.fetch);
		expect(model).toMatchObject({ name: "Modello (google)", ok: true, detail: expect.stringContaining("GEMINI_API_KEY") });
		expect(JSON.stringify(model)).not.toContain("g-secret");
		expect(net.calls).toEqual([]);
	});

	it("all services answer: every check passes and says what it found", async () => {
		const net = internet(healthy);
		const results = await runChecks(loadOwniConfig(ENV), net.fetch);
		expect(results.map((r) => [r.name, r.ok])).toEqual([
			["Modello (anthropic)", true],
			["Telegram (agente)", true],
		]);
	});

	it("never prints a secret", async () => {
		const blocked = internet({});
		const failing = internet({ ...healthy, "api.anthropic.com": () => Response.json({ error: { message: "invalid x-api-key sk-ant-secret-1" } }, { status: 401 }) });
		for (const net of [blocked, failing]) {
			const text = JSON.stringify(await runChecks(loadOwniConfig(ENV), net.fetch));
			for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
		}
	});

	it("says which host is unreachable and which key is refused", async () => {
		const { "api.telegram.org": _t, ...rest } = healthy;
		const net = internet({ ...rest, "api.anthropic.com": () => Response.json({ error: {} }, { status: 401 }) });
		const results = await runChecks(loadOwniConfig(ENV), net.fetch);
		const by = (name: string) => results.find((r) => r.name === name);
		expect(by("Modello (anthropic)")).toMatchObject({ ok: false, detail: expect.stringContaining("ANTHROPIC_API_KEY") });
		expect(by("Telegram (agente)")).toMatchObject({ ok: false, detail: expect.stringContaining("api.telegram.org non raggiungibile") });
	});

	it("web search: one query with the key in a header; a refused key is named, never printed", async () => {
		const key = "BSA-secret-key";
		const env = { OWNI_DATA_DIR: "/tmp/x", OWNI_MODEL_PROVIDER: "faux", OWNI_SEARCH_API_KEY: key };
		const asked: URL[] = [];
		const ok = internet({ "api.search.brave.com": (url, init) => (asked.push(url), new Headers(init?.headers).get("x-subscription-token") === key ? Response.json({ web: { results: [] } }) : Response.json({}, { status: 401 })) });
		const passing = (await runChecks(loadOwniConfig(env), ok.fetch)).find((r) => r.name === "Ricerca sul web");
		expect(passing).toMatchObject({ ok: true, detail: expect.stringContaining("chiave valida") });
		expect(asked[0]?.searchParams.get("country")).toBe("IT");
		const refused = internet({ "api.search.brave.com": () => Response.json({ error: key }, { status: 401 }) });
		const failing = (await runChecks(loadOwniConfig(env), refused.fetch)).find((r) => r.name === "Ricerca sul web");
		expect(failing).toMatchObject({ ok: false, detail: expect.stringContaining("OWNI_SEARCH_API_KEY") });
		expect(JSON.stringify(failing)).not.toContain(key);
	});

	it("only checks what is configured; the local model needs no network", async () => {
		const net = internet({});
		const results = await runChecks(loadOwniConfig({ OWNI_MODEL_PROVIDER: "faux" }), net.fetch);
		expect(results).toEqual([{ name: "Modello (faux)", ok: true, detail: "modello locale di sviluppo, nessuna chiave" }]);
		expect(net.calls).toEqual([]);
	});
});
