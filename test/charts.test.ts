import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningOwni, startOwni } from "../src/app.ts";
import { CHART_LIMITS, ChartError, type ChartSpec, drawChart, formatNumber, niceTicks, SERIES_COLORS, withUnit } from "../src/core/charts.ts";
import { makeChartFile } from "../src/core/document-reader.ts";
import { readPng } from "../src/core/png-read.ts";
import { fitText, measure, Raster, roundedRect, stroke, textContours, wrapText } from "../src/core/raster.ts";
import { createChartTools } from "../src/core/tools/chart-tools.ts";
import { Workspace } from "../src/core/workspace.ts";
import { loadOwniConfig } from "../src/main/config.ts";
import { tempDataDir } from "./helpers.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});

const NOW = Date.UTC(2026, 9, 17, 9, 30);

function pixel(png: Uint8Array, x: number, y: number): [number, number, number] {
	const picture = readPng(Buffer.from(png));
	const at = (y * picture.width + x) * 3;
	return [picture.pixels[at] as number, picture.pixels[at + 1] as number, picture.pixels[at + 2] as number];
}

/** How many pixels of a picture are (nearly) a colour. */
function count(png: Uint8Array, color: readonly number[], box?: { x0: number; y0: number; x1: number; y1: number }): number {
	const picture = readPng(Buffer.from(png));
	let n = 0;
	for (let y = box?.y0 ?? 0; y < (box?.y1 ?? picture.height); y++) {
		for (let x = box?.x0 ?? 0; x < (box?.x1 ?? picture.width); x++) {
			const at = (y * picture.width + x) * 3;
			if (Math.abs((picture.pixels[at] as number) - (color[0] as number)) + Math.abs((picture.pixels[at + 1] as number) - (color[1] as number)) + Math.abs((picture.pixels[at + 2] as number) - (color[2] as number)) < 12) n++;
		}
	}
	return n;
}

const BLUE = SERIES_COLORS[0] as readonly number[];
const ORANGE = SERIES_COLORS[1] as readonly number[];

describe("the rasteriser", () => {
	it("covers pixels by the area under the shape: a rectangle on half pixels gives half-tone edges", () => {
		const r = new Raster(10, 4, [255, 255, 255]);
		r.fill([roundedRect(2.5, 0, 5, 4)], [0, 0, 0]);
		const row = [...Array(10).keys()].map((x) => r.pixels[x * 3] as number);
		expect(row).toEqual([255, 255, 128, 0, 0, 0, 0, 128, 255, 255]);
	});

	it("adds overlapping pieces of one fill instead of cancelling them, and leaves holes in letters", () => {
		const r = new Raster(40, 20, [255, 255, 255]);
		r.fill(stroke([[2, 10], [20, 10], [38, 10]], 6), [0, 0, 0]);
		// The joint at x=20 is as dark as the rest of the line.
		expect(r.pixels[(10 * 40 + 20) * 3]).toBe(0);
		expect(r.pixels[(10 * 40 + 10) * 3]).toBe(0);
		const o = new Raster(60, 60, [255, 255, 255]);
		o.fill(textContours("O", 5, 50, { size: 60 }), [0, 0, 0]);
		// The middle of the O stays white.
		expect(o.pixels[(28 * 60 + 23) * 3]).toBe(255);
	});

	it("clips shapes that go past the canvas, without drawing outside or failing", () => {
		const r = new Raster(20, 20, [255, 255, 255]);
		r.fill([roundedRect(-1e6, -5, 2e6, 10)], [0, 0, 0]);
		r.fill([roundedRect(500, 500, 10, 10)], [0, 0, 0]);
		expect(r.pixels[(2 * 20 + 10) * 3]).toBe(0);
		expect(r.pixels[(10 * 20 + 10) * 3]).toBe(255);
	});

	it("clips slanted edges that leave the canvas exactly", () => {
		const area = (r: Raster) => {
			let a = 0;
			for (let i = 0; i < r.pixels.length; i += 3) a += (255 - (r.pixels[i] as number)) / 255;
			return a;
		};
		for (const [contour, expected] of [
			[[-10, 0, 10, 10, -10, 10], 25],
			[[0, -10, 10, 10, 0, 10], 75],
			[[-1e6, -5, 1e6, 15, -1e6, 15], 50],
		] as const) {
			const r = new Raster(10, 10, [255, 255, 255]);
			r.fill([[...contour]], [0, 0, 0]);
			expect(area(r)).toBeCloseTo(expected, 0);
		}
	});

	it("measures, cuts and wraps text", () => {
		expect(measure("Fatturato", 24)).toBeGreaterThan(measure("Fatto", 24));
		expect(measure("Fatturato", 24, "bold")).toBeGreaterThan(measure("Fatturato", 24));
		expect(fitText("Passaparola tra clienti", 120, 24)).toMatch(/…$/);
		expect(measure(fitText("Passaparola tra clienti", 120, 24), 24)).toBeLessThanOrEqual(120);
		expect(wrapText("Instagram e Facebook", 160, 24)).toEqual(["Instagram e", "Facebook"]);
	});
});

describe("numbers on a chart", () => {
	it("are written the Italian way, with the unit in its place", () => {
		expect(formatNumber(1234567.891, 2)).toBe("1.234.567,89");
		expect(formatNumber(-40, 0)).toBe("-40");
		expect(formatNumber(-0.001, 1)).toBe("0,0");
		expect(withUnit("1.200", "€")).toBe("€ 1.200");
		expect(withUnit("-2,50", "€")).toBe("-€ 2,50");
		expect(withUnit("15", "%")).toBe("15%");
		expect(withUnit("12", "ore")).toBe("12 ore");
	});

	it("get round axis steps", () => {
		expect(niceTicks(0, 151300)).toEqual([0, 50000, 100000, 150000, 200000]);
		expect(niceTicks(-40, 410)).toEqual([-100, 0, 100, 200, 300, 400, 500]);
		expect(niceTicks(0.1, 0.92)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
		expect(niceTicks(5, 5).length).toBeGreaterThan(1);
		// Ranges narrower than the float spacing and huge ones end at once, with a dozen ticks at most.
		expect(niceTicks(0.3, 0.30000000000000004).length).toBeLessThanOrEqual(12);
		expect(niceTicks(1e16, 1e16 + 2).length).toBeLessThanOrEqual(12);
		expect(niceTicks(0, Number.MAX_VALUE).length).toBeLessThanOrEqual(12);
	});
});

describe("drawing a chart", () => {
	const bars: ChartSpec = { kind: "bar", title: "Fatturato per trimestre", labels: ["T1", "T2", "T3", "T4"], series: [{ name: "Fatturato", values: [120500, 134200, 98000, 151300] }], unit: "€" };

	it("draws bars in the first colour on a light picture of 1200 × 900, with the title in ink", () => {
		const chart = drawChart(bars);
		expect(chart).toMatchObject({ width: 1200, height: 900, notes: [] });
		expect(Buffer.from(chart.data).subarray(1, 4).toString()).toBe("PNG");
		expect(pixel(chart.data, 2, 2)).toEqual([252, 252, 251]);
		expect(count(chart.data, BLUE)).toBeGreaterThan(30_000);
		expect(count(chart.data, ORANGE)).toBe(0);
		// The title is near-black text at the top left.
		expect(count(chart.data, [11, 11, 11], { x0: 44, y0: 44, x1: 700, y1: 104 })).toBeGreaterThan(1500);
	});

	it("gives each series its colour in the fixed order, for bars, stacks and lines", () => {
		for (const spec of [
			{ ...bars, series: [bars.series[0], { name: "2025", values: [100000, 110000, 90000, 120000] }] },
			{ ...bars, stacked: true, series: [bars.series[0], { name: "2025", values: [100000, 110000, 90000, 120000] }] },
			{ ...bars, kind: "line", series: [bars.series[0], { name: "2025", values: [100000, null, 90000, 120000] }] },
		] as ChartSpec[]) {
			const chart = drawChart(spec);
			expect(count(chart.data, BLUE)).toBeGreaterThan(1000);
			expect(count(chart.data, ORANGE)).toBeGreaterThan(1000);
			expect(count(chart.data, SERIES_COLORS[2] as readonly number[])).toBe(0);
		}
	});

	it("turns the bars sideways when the names do not fit under them", () => {
		const names = ["Passaparola tra clienti esistenti da anni", "Ricerca su Google e altri motori", "Instagram e Facebook a pagamento", "Fiere di settore in tutta Italia", "Telefonate a freddo ai negozi", "Newsletter mensile ai clienti"];
		const spec: ChartSpec = { kind: "bar", labels: names, series: [{ values: [48, 35, 22, 12, 6, 9] }] };
		const picture = readPng(Buffer.from(drawChart(spec).data));
		// The longest bar runs across: a long row of blue in the top band.
		let longest = 0;
		for (let y = 0; y < 400; y++) {
			let run = 0;
			for (let x = 0; x < 1200; x++) {
				const at = (y * 1200 + x) * 3;
				run = picture.pixels[at] === BLUE[0] && picture.pixels[at + 1] === BLUE[1] ? run + 1 : 0;
				longest = Math.max(longest, run);
			}
		}
		expect(longest).toBeGreaterThan(400);
		expect(drawChart({ ...spec, horizontal: false }).notes).toEqual(["I nomi sotto le barre non entrano tutti: accorciali o lascia le barre in orizzontale (senza horizontal: false)."]);
	});

	it("draws a ring with the total in the middle, and gathers the small slices in «Altri»", () => {
		const spec: ChartSpec = { kind: "pie", title: "Spese", labels: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "L"], series: [{ values: [1800, 6200, 450, 900, 320, 610, 200, 80, 150, 0] }], unit: "€" };
		const chart = drawChart(spec);
		expect(chart.notes).toEqual(["Le 4 voci più piccole sono raccolte in «Altri»: in una torta se ne distinguono al massimo 6. Per vederle tutte usa le barre."]);
		for (const color of SERIES_COLORS.slice(0, 5)) expect(count(chart.data, color)).toBeGreaterThan(50);
		// «Altri» is grey, never the sixth colour.
		expect(count(chart.data, SERIES_COLORS[5] as readonly number[])).toBe(0);
		expect(count(chart.data, [168, 167, 162])).toBeGreaterThan(500);
		// The biggest slice is the first colour, from 12 o'clock clockwise.
		expect(count(chart.data, BLUE)).toBeGreaterThan(count(chart.data, ORANGE));
	});

	it("writes letters it does not have as «?» and says so", () => {
		expect(drawChart({ ...bars, title: "Vendite 🚀 Ελλάδα" }).notes).toEqual(["6 lettere di alfabeti diversi dal latino sono scritte come «?»: nel grafico ci sono solo lettere latine."]);
		// Emoji are left out, not written as «?».
		expect(drawChart({ ...bars, title: "Gusti più venduti 🍦👍🏽 🇮🇹" }).notes).toEqual([]);
		expect(drawChart({ ...bars, title: "Ștefan, Łódź, Øresund, Kraków" }).notes).toEqual([]);
	});

	it("writes one short scale on the axis and on the values, and enough decimals for small numbers", async () => {
		const { valueText, tickText } = await import("../src/core/charts.ts");
		const mila = { unit: "€", decimals: 0, scale: 1e3, suffix: " mila" };
		expect(valueText(mila, 12460)).toBe("€ 12,5 mila");
		expect(valueText(mila, 26000)).toBe("€ 26 mila");
		expect(tickText(mila, 0, 5000)).toBe("€ 0");
		expect(tickText({ decimals: 0, scale: 1e9, suffix: " Mld" }, 2.5e9, 5e8)).toBe("2,5 Mld");
		const tiny = drawChart({ kind: "bar", labels: ["A", "B"], series: [{ values: [0.003, 0.0012] }], unit: "mg/l" });
		expect(tiny.notes).toEqual([]);
	});

	it("puts dates in Italian, a goal line in the legend, and sorts a ranking", () => {
		const dates = drawChart({ kind: "line", labels: ["2025-12-30", "2025-12-31", "2026-01-01"], series: [{ values: [1, 2, 3] }], target: 2, targetLabel: "Media" });
		expect(dates.notes).toEqual([]);
		const sorted = drawChart({ kind: "bar", sort: "desc", labels: ["a", "b", "c"], series: [{ values: [1, 3, 2] }] });
		const picture = readPng(Buffer.from(sorted.data));
		// The first bar (tallest after sorting) reaches higher than the last.
		const top = (x0: number, x1: number) => {
			for (let y = 0; y < picture.height; y++) for (let x = x0; x < x1; x++) if (picture.pixels[(y * picture.width + x) * 3] === BLUE[0] && picture.pixels[(y * picture.width + x) * 3 + 1] === BLUE[1]) return y;
			return picture.height;
		};
		expect(top(0, 500)).toBeLessThan(top(800, 1200));
	});

	it("refuses data it cannot draw honestly, saying why", () => {
		const refuse = (spec: Partial<ChartSpec>) => () => drawChart({ ...bars, ...spec } as ChartSpec);
		expect(refuse({ series: [] })).toThrow(ChartError);
		expect(refuse({ series: Array.from({ length: 9 }, () => ({ values: [1, 2, 3, 4] })) })).toThrow(/al massimo 8 serie/);
		expect(refuse({ series: [{ values: [1, 2, 3, 4, 5] }] })).toThrow(/5 valori ma le etichette sono 4/);
		expect(refuse({ series: [{ values: [1, Number.NaN, 3, 4] }] })).toThrow(/non è un numero/);
		expect(refuse({ series: [{ values: [null, null, null, null] }] })).toThrow(/vuoti/);
		expect(refuse({ labels: [] })).toThrow(/etichette/);
		expect(refuse({ kind: "pie", series: [{ values: [1, -2, 3, 4] }] })).toThrow(/negativi/);
		expect(refuse({ kind: "pie", series: [{ values: [1, 2, 3, 4] }, { values: [1, 2, 3, 4] }] })).toThrow(/una serie sola/);
		expect(refuse({ kind: "pie", series: [{ values: [0, 0, 0, 0] }] })).toThrow(/vuota/);
		expect(refuse({ kind: "line", labels: ["T1"], series: [{ values: [1] }] })).toThrow(/almeno due punti/);
		expect(refuse({ labels: Array.from({ length: 121 }, String), series: [{ values: [1] }] })).toThrow(/troppe barre/);
		expect(refuse({ kind: "line", labels: Array.from({ length: CHART_LIMITS.maxPoints + 1 }, String), series: [{ values: [1] }] })).toThrow(/punti per linea/);
		expect(refuse({ kind: "radar" as never })).toThrow(/bar, line o pie/);
		expect(refuse({ series: [{ values: [-1e308, 1e308, 1, 2] }] })).toThrow(/troppo grande/);
		expect(refuse({ series: [{ values: [1e-12, 1, 2, 3] }] })).toThrow(/troppo piccolo/);
		expect(refuse({ target: Number.POSITIVE_INFINITY })).toThrow(/target/);
		expect(refuse({ horizontal: true, labels: Array.from({ length: 60 }, String), series: Array.from({ length: 8 }, () => ({ values: Array.from({ length: 60 }, () => 1) })) })).toThrow(/troppe barre per lo spazio/);
	});

	it("draws in a worker, a big line chart in good time", async () => {
		const labels = Array.from({ length: 1000 }, (_, i) => `g${i}`);
		const series = Array.from({ length: 8 }, (_, s) => ({ name: `S${s}`, values: labels.map((_, i) => Math.sin(i / 20 + s) * 100 + s * 10) }));
		const start = Date.now();
		const chart = await makeChartFile({ kind: "line", title: "Molti punti", labels, series });
		expect(Date.now() - start).toBeLessThan(15_000);
		expect(readPng(chart.data).width).toBe(1200);
		await expect(makeChartFile({ kind: "pie", labels: ["a"], series: [{ values: [-1] }] })).rejects.toThrow(/negativi/);
	});
});

describe("chart_create", () => {
	function tool() {
		const workspace = new Workspace(tempDataDir());
		const sent: { path: string; caption?: string; key: string }[] = [];
		const [chart] = createChartTools({ workspace, now: () => new Date(NOW), sendFile: async (f) => void sent.push(f) });
		const ctx = (thread: boolean) => ({ step: <T>(_n: string, run: () => Promise<T>) => run(), callId: "c1", ...(thread ? { thread: { channel: "web", threadId: "t1" } } : {}) }) as never;
		return { workspace, sent, run: (args: Record<string, unknown>, thread = true) => (chart as NonNullable<typeof chart>).execute(args, ctx(thread)) };
	}

	it("saves the chart in grafici/ and sends it to the conversation", async () => {
		const { workspace, sent, run } = tool();
		const result = await run({ kind: "bar", title: "Vendite di ottobre", labels: ["Roma", "Milano"], series: [{ name: "Pezzi", values: [12, 30] }], caption: "Ecco" });
		expect(result).toBe("Grafico inviato in questa conversazione (grafici/vendite-di-ottobre-2026-10-17T09-30-00.png). Non serve altro testo.");
		expect(sent).toEqual([{ channel: "web", threadId: "t1", path: "grafici/vendite-di-ottobre-2026-10-17T09-30-00.png", caption: "Ecco", key: "c1:chart" }]);
		expect(readPng(await workspace.read("grafici/vendite-di-ottobre-2026-10-17T09-30-00.png")).width).toBe(1200);
	});

	it("only saves it when asked, to put it in a document", async () => {
		const { sent, run } = tool();
		const result = await run({ kind: "line", labels: ["a", "b"], series: [{ values: [1, 2] }], path: "report/andamento.png", send: false });
		expect(result).toMatch(/^Grafico salvato in report\/andamento\.png \(\d+ KB\)\. Per metterlo in un documento: !\[grafico\]\(report\/andamento\.png\) in document_create; per mandarlo, file_send\.$/);
		expect(sent).toEqual([]);
	});

	it("reads numbers written as text, and takes the unit from them", async () => {
		const { workspace, run } = tool();
		const result = await run({ kind: "bar", labels: ["a", "b"], series: [{ values: ["€ 1.200,50", "€ 300"] }], send: false });
		expect(result).toMatch(/^Grafico salvato in grafici\/grafico-2026-10-17T09-30-00\.png/);
		expect(await workspace.stat("grafici/grafico-2026-10-17T09-30-00.png")).toBeDefined();
		expect(await run({ kind: "bar", labels: ["a"], series: [{ values: ["molti"] }] })).toBe("Errore: non ho disegnato il grafico. La serie 1 ha un valore che non è un numero.");
	});

	it("draws a CSV of the workspace: labels in the first column, a series per column of numbers", async () => {
		const { workspace, run } = tool();
		await workspace.write("dati/vendite.csv", "Mese;Roma;Milano;Note\nGen;€ 1.200,00;€ 900,00;ok\nFeb;€ 1.350,00;;saldi\nMar;€ 1.100,00;€ 1.000,00;\n");
		const result = await run({ kind: "line", source: "dati/vendite.csv", title: "Vendite", send: false });
		expect(result).toContain("Grafico salvato in grafici/vendite-2026-10-17T09-30-00.png");
		expect(result).toContain("Non ho disegnato le colonne che non sono numeri: Note.");
		const chart = readPng(await workspace.read("grafici/vendite-2026-10-17T09-30-00.png"));
		expect(chart.width).toBe(1200);
		await workspace.write("dati/vuoto.csv", "Mese;Note\nGen;ok\n");
		expect(await run({ kind: "bar", source: "dati/vuoto.csv" })).toBe("Errore: non ho disegnato il grafico. In dati/vuoto.csv non ci sono colonne di numeri dopo la prima.");
		expect(await run({ kind: "bar", source: "dati/manca.csv" })).toBe("Errore: non ho disegnato il grafico. dati/manca.csv non c'è nel workspace.");
		expect(await run({ kind: "bar", source: "dati/foglio.xlsx" })).toMatch(/non è un CSV/);
	});

	it("reads years as the header, leaves out a total row and refuses CSVs too big to draw", async () => {
		const { workspace, run } = tool();
		await workspace.write("anni.csv", "Mese;2024;2025\nGen;10;12\nFeb;11;15\nTotale;21;27\n");
		const result = await run({ kind: "bar", source: "anni.csv", send: false });
		expect(result).toContain("Ho lasciato fuori la riga «Totale»: è un totale delle altre.");
		await workspace.write("lungo.csv", `a;b\n${"x;1\n".repeat(5000)}`);
		expect(await run({ kind: "line", source: "lungo.csv" })).toMatch(/ha 5001 righe: per un grafico al massimo 1000/);
		await workspace.write("largo.csv", `${Array.from({ length: 100 }, (_, i) => `c${i}`).join(";")}\n`);
		expect(await run({ kind: "line", source: "largo.csv" })).toMatch(/ha 100 colonne/);
	});

	it("never replaces a picture that is not a chart, and gives two charts of the same second two names", async () => {
		const { workspace, run } = tool();
		await workspace.write("uploads/foto.png", "x");
		expect(await run({ kind: "bar", labels: ["a"], series: [{ values: [1] }], path: "uploads/foto.png" })).toBe("Errore: non ho disegnato il grafico. uploads/foto.png esiste già: scegli un altro nome, o lascia path vuoto.");
		const one = await run({ kind: "bar", title: "Vendite", labels: ["a"], series: [{ values: [1] }], send: false });
		const two = await run({ kind: "bar", title: "Vendite", labels: ["a"], series: [{ values: [2] }], send: false });
		expect(one).toContain("grafici/vendite-2026-10-17T09-30-00.png");
		expect(two).toContain("grafici/vendite-2026-10-17T09-30-00-2.png");
	});

	it("asks for data one way, a .png name and a known kind", async () => {
		const { run } = tool();
		expect(await run({ kind: "bar" })).toMatch(/^Errore: dammi i dati/);
		expect(await run({ kind: "bar", source: "a.csv", labels: ["a"], series: [{ values: [1] }] })).toMatch(/^Errore: dammi i dati/);
		expect(await run({ kind: "bar", labels: ["a"], series: [{ values: [1] }], path: "a.jpg" })).toBe("Errore: il nome del file deve finire con .png.");
		expect(await run({ kind: "torta", labels: ["a"], series: [{ values: [1] }] })).toBe("Errore: il tipo di grafico deve essere bar, line o pie.");
		expect(await run({ kind: "bar", labels: ["a"], series: [{ values: [1] }] }, false)).toMatch(/^Grafico salvato in/);
	});
});

describe("charts in an instance", () => {
	it("are drawn from the chat, sent as a picture and can go into a PDF", async () => {
		const loaded = loadOwniConfig({ OWNI_DATA_DIR: tempDataDir(), OWNI_MODEL_PROVIDER: "faux", OWNI_WEB_PORT: "1" });
		const owni: RunningOwni = await startOwni({ ...loaded, web: { ...loaded.web, port: 0 } }, { schedulerIntervalMs: 60_000, log: () => {} });
		closers.push(() => owni.stop());
		const base = `http://127.0.0.1:${(owni.server.address() as AddressInfo).port}`;
		const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token: (owni.ownerLink as string).split("#")[1] }) });
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
		// biome-ignore lint: test
		const api = async (path: string, body?: unknown): Promise<any> => (await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { cookie, "x-owni": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json();
		const thread = (await api("/api/instances/owni/threads", {})).thread;
		const entries = async () => (await api(`/api/instances/owni/threads/${thread.id}`)).entries as { from: string; text?: string; file?: { path: string } }[];
		const reply = async (text: string): Promise<string> => {
			const answers = async () => (await entries()).filter((e) => e.from === "owni" && e.text !== undefined);
			const before = (await answers()).length;
			await api(`/api/instances/owni/threads/${thread.id}/messages`, { text });
			for (const start = Date.now(); Date.now() - start < 20_000; ) {
				const now = await answers();
				if (now.length > before) return now.at(-1)?.text ?? "";
				await new Promise((r) => setTimeout(r, 30));
			}
			throw new Error("no reply");
		};
		const made = await reply('/tool chart_create {"kind":"pie","title":"Spese","labels":["Affitto","Stipendi"],"series":[{"values":[1800,6200]}],"unit":"€"}');
		expect(made).toMatch(/Grafico inviato in questa conversazione \(grafici\/spese-[\w-]+\.png\)/);
		const path = /grafici\/[\w-]+\.png/.exec(made)?.[0] as string;
		expect((await entries()).some((e) => e.file?.path === path)).toBe(true);
		const pdf = await reply(`/tool document_create {"path":"report.pdf","content":"# Spese\\n\\n![grafico](${path})"}`);
		expect(pdf).toMatch(/Creato report\.pdf \(PDF, 1 pagina/);
		expect(pdf).not.toMatch(/immagin/i);
	});
});
