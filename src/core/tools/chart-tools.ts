import { CHART_KINDS, CHART_LIMITS, ChartError, type ChartKind, type ChartSeries, type ChartSpec } from "../chart-spec.ts";
import { makeChartFile } from "../document-reader.ts";
import { DocumentError } from "../documents.ts";
import type { OwniTool } from "../engine.ts";
import { cellNumber, parseCsv } from "../make-xlsx.ts";
import { freePath, type Workspace, WorkspaceError } from "../workspace.ts";
import { slugify } from "./research-tools.ts";

export type ChartToolsOptions = {
	readonly workspace: Workspace;
	/** Send a workspace file to a thread (through the outbox). */
	readonly sendFile: (file: { channel: string; threadId: string; path: string; caption?: string; key: string }) => Promise<void>;
	readonly now?: () => Date;
};

/** The largest CSV a chart is drawn from. */
const MAX_CSV = 2 * 1024 * 1024;
/** The most columns of a CSV looked at: a label and the series, with room for columns of notes. */
const MAX_COLUMNS = 64;

/**
 * Charts from numbers (ADR 0030): bars, lines and a ring drawn as a PNG in `grafici/`, sent to
 * the conversation like a picture, and ready to go into a document with document_create.
 */
export function createChartTools(options: ChartToolsOptions): OwniTool[] {
	const { workspace } = options;
	return [
		{
			name: "chart_create",
			description:
				"Draw a chart as a picture and send it to the person: bar (compare amounts: sales by month, costs by item), line (a trend over time, many points) or pie (shares of one total, up to 6 parts). " +
				"For one or two numbers do not draw: write them. Give labels (the categories or dates, in order) and one or more series with a value for each label (null where one is missing), or source: a CSV of the workspace with the labels in the first column and a column per series. " +
				"All series share one unit and one axis: for amounts and counts together make two charts. The unit goes in unit (€, $, %, or a word like ore or kg), not in the numbers; percentages as 25 for 25%. " +
				"Title: short (under 60 characters), what the chart shows; details such as the period or the source in subtitle. " +
				"Bars: sort desc for rankings (top products); stacked to pile the series up; horizontal for long names (chosen by itself when they do not fit). target draws a reference line (a goal, a budget). At most 8 series: group the small ones. " +
				"The picture is saved in grafici/; to put it in a Word or PDF file, use send: false and then ![grafico](path) in document_create. Do not describe the chart afterwards.",
			parameters: {
				type: "object",
				properties: {
					kind: { type: "string", enum: [...CHART_KINDS] },
					title: { type: "string", maxLength: CHART_LIMITS.maxTitle },
					subtitle: { type: "string", maxLength: CHART_LIMITS.maxTitle, description: "A second line: the period, the source, what the numbers count" },
					labels: { type: "array", items: { type: "string", maxLength: CHART_LIMITS.maxLabel }, maxItems: CHART_LIMITS.maxPoints },
					series: {
						type: "array",
						maxItems: CHART_LIMITS.maxSeries,
						items: {
							type: "object",
							properties: { name: { type: "string", maxLength: CHART_LIMITS.maxLabel }, values: { type: "array", items: { type: ["number", "string", "null"], maxLength: 40 }, maxItems: CHART_LIMITS.maxPoints, description: "Numbers; a value written as text (1.200,50 or € 30) is read too" } },
							required: ["values"],
							additionalProperties: false,
						},
					},
					source: { type: "string", minLength: 1, maxLength: 300, description: "Instead of labels and series: a .csv file in the workspace" },
					stacked: { type: "boolean" },
					sort: { type: "string", enum: ["desc", "asc"], description: "Bars in order of value: desc for a ranking. Leave it out for periods (months, years)" },
					target: { type: "number", description: "A reference line at this value: a goal, a budget, an average" },
					targetLabel: { type: "string", maxLength: 40, description: "Its name, e.g. Obiettivo, Budget, Media" },
					horizontal: { type: "boolean" },
					unit: { type: "string", maxLength: 12 },
					decimals: { type: "integer", minimum: 0, maximum: 4 },
					path: { type: "string", minLength: 1, maxLength: 300, description: "Where to save it, ending in .png. Leave it out for grafici/<title>.png" },
					send: { type: "boolean", description: "false to only save it (to put it in a document). Sent to the conversation otherwise" },
					caption: { type: "string", maxLength: 200, description: "One short line sent with the picture, in the person's language" },
				},
				required: ["kind"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				const kind = String(args.kind) as ChartKind;
				if (!CHART_KINDS.includes(kind)) return "Errore: il tipo di grafico deve essere bar, line o pie.";
				const path = typeof args.path === "string" ? args.path.trim() : undefined;
				if (path !== undefined && !/\.png$/i.test(path)) return "Errore: il nome del file deve finire con .png.";
				const hasSource = typeof args.source === "string";
				const hasData = Array.isArray(args.series) || Array.isArray(args.labels);
				if (hasSource === hasData) return "Errore: dammi i dati in labels e series oppure un CSV del workspace in source (uno dei due).";
				const made = await ctx.step("draw", async (): Promise<{ path: string; notes: string[]; size: number } | { error: string }> => {
					try {
						const data = hasSource ? await fromCsv(workspace, String(args.source)) : fromArgs(args.labels, args.series);
						const notes = [...data.notes];
						const unit = typeof args.unit === "string" && args.unit.trim() !== "" ? args.unit.trim() : data.unit;
						const title = typeof args.title === "string" ? args.title : undefined;
						const spec: ChartSpec = {
							kind,
							labels: data.labels,
							series: data.series,
							...(title === undefined ? {} : { title }),
							...(typeof args.subtitle === "string" ? { subtitle: args.subtitle } : {}),
							...(args.stacked === true ? { stacked: true } : {}),
							...(typeof args.horizontal === "boolean" ? { horizontal: args.horizontal } : {}),
							...(unit === undefined ? {} : { unit }),
							...(typeof args.decimals === "number" ? { decimals: args.decimals } : {}),
							...(args.sort === "asc" || args.sort === "desc" ? { sort: args.sort } : {}),
							...(typeof args.target === "number" ? { target: args.target } : {}),
							...(typeof args.targetLabel === "string" ? { targetLabel: args.targetLabel } : {}),
						};
						const chart = await makeChartFile(spec);
						notes.push(...chart.notes);
						const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
						// slugify names an empty title «ricerca»: a chart without letters in its title is a «grafico».
						const name = /[a-z0-9]/i.test((title ?? "").normalize("NFD")) ? slugify(title as string).slice(0, 40).replace(/-+$/, "") : "grafico";
						const where = path ?? (await freePath(workspace, `grafici/${name}-${stamp}`, ".png"));
						// A name given by the model may be a person's picture: only charts are replaced.
						if (path !== undefined && !path.startsWith("grafici/") && (await workspace.stat(path)) !== undefined) {
							return { error: `${path} esiste già: scegli un altro nome, o lascia path vuoto` };
						}
						const file = await workspace.write(where, chart.data);
						return { path: file.path, notes, size: file.size };
					} catch (error) {
						if (error instanceof ChartError || error instanceof DocumentError || error instanceof WorkspaceError) return { error: error.message };
						throw error;
					}
				});
				if ("error" in made) {
					// A sentence of its own, with a capital letter unless it starts with a file name.
					const why = /^[^\s]*[/.]/.test(made.error) ? made.error : `${made.error.charAt(0).toUpperCase()}${made.error.slice(1)}`;
					return `Errore: non ho disegnato il grafico. ${why}.`;
				}
				const notes = made.notes.length === 0 ? "" : ` ${made.notes.join(" ")}`;
				const thread = ctx.thread;
				if (args.send === false || thread === undefined) {
					return `Grafico salvato in ${made.path} (${Math.max(1, Math.round(made.size / 1024))} KB).${notes} Per metterlo in un documento: ![grafico](${made.path}) in document_create; per mandarlo, file_send.`;
				}
				const caption = typeof args.caption === "string" && args.caption.trim() !== "" ? args.caption.trim() : undefined;
				try {
					await ctx.step("send", async () => {
						await options.sendFile({ channel: thread.channel, threadId: thread.threadId, path: made.path, ...(caption === undefined ? {} : { caption }), key: `${ctx.callId}:chart` });
						return true;
					});
				} catch (error) {
					return `Grafico salvato in ${made.path}, ma non sono riuscita a inviarlo (${error instanceof Error ? error.message : String(error)}). Dillo alla persona: su WhatsApp, dopo 24 ore di silenzio, deve scriverti prima; nella console lo trova tra i file.`;
				}
				return `Grafico inviato in questa conversazione (${made.path}).${notes} ${caption === undefined ? "Rispondi con una riga al massimo." : "Non serve altro testo."}`;
			},
		},
	];
}

type ChartData = { labels: string[]; series: ChartSeries[]; unit?: string; notes: string[] };

/** Labels and series as the model gave them; a value written as text (1.200,50 or € 30) is read as a number. */
function fromArgs(labelsArg: unknown, seriesArg: unknown): ChartData {
	const series = Array.isArray(seriesArg) ? seriesArg : [];
	const units = new Set<string>();
	const read = (v: unknown, i: number): number | null => {
		if (v === null || v === undefined || v === "") return null;
		if (typeof v === "number") return v;
		const n = typeof v === "string" ? cellNumber(v) : undefined;
		if (n === undefined) throw new ChartError(`la serie ${i + 1} ha un valore che non è un numero`);
		if (n.unit !== undefined) units.add(n.unit);
		return n.value;
	};
	const out: ChartSeries[] = series.map((s: { name?: unknown; values?: unknown }, i) => ({
		...(typeof s?.name === "string" ? { name: s.name } : {}),
		values: (Array.isArray(s?.values) ? s.values : []).map((v: unknown) => read(v, i)),
	}));
	if (!Array.isArray(labelsArg) || labelsArg.length === 0) throw new ChartError("servono le etichette (labels): le categorie o le date dei valori, una per valore");
	return { labels: labelsArg.map((l) => String(l)), series: out, notes: [], ...(units.size === 1 ? { unit: [...units][0] as string } : {}) };
}

const TOTAL = /^(totale|totali|total|totals|tot\.?|somma|subtotale|sub-totale|totale generale|grand total)$/i;

/** A CSV: labels in the first column, a series per column of numbers; a first row with names is the header. */
async function fromCsv(workspace: Workspace, source: string): Promise<ChartData> {
	if (!/\.(csv|tsv|txt)$/i.test(source)) throw new ChartError(`${source} non è un CSV: per una tabella di Excel o di un documento leggila con file_read e passa i numeri in labels e series`);
	const stat = await workspace.stat(source);
	if (stat === undefined) throw new ChartError(`${source} non c'è nel workspace`);
	if (stat.size > MAX_CSV) throw new ChartError(`${source} è troppo grande per un grafico (più di 2 MB): riassumi i dati prima`);
	const data = await workspace.read(source);
	if (data.includes(0)) throw new ChartError(`${source} non è un file di testo`);
	const rows = parseCsv(data.toString("utf8")).filter((r) => r.some((c) => c.trim() !== ""));
	if (rows.length === 0) throw new ChartError(`${source} è vuoto`);
	// Sizes first, before any cell is read as a number.
	if (rows.length > CHART_LIMITS.maxPoints + 2) throw new ChartError(`${source} ha ${rows.length} righe: per un grafico al massimo ${CHART_LIMITS.maxPoints}. Raggruppa i dati (per settimana o per mese) in un nuovo CSV`);
	let columns = 0;
	for (const r of rows) columns = Math.max(columns, r.length);
	if (columns < 2) throw new ChartError(`${source} ha una colonna sola: servono le etichette nella prima e i numeri nelle altre`);
	if (columns > MAX_COLUMNS) throw new ChartError(`${source} ha ${columns} colonne: per un grafico al massimo ${MAX_COLUMNS}`);
	const numbers = new Map<string, ReturnType<typeof cellNumber>>();
	const numberIn = (c: string) => {
		if (!numbers.has(c)) numbers.set(c, cellNumber(c));
		return numbers.get(c);
	};
	const isNumber = (c: string | undefined) => c === undefined || c.trim() === "" || numberIn(c) !== undefined;
	// The first row names the columns when it has words, or years above a column of labels (Mese;2024;2025).
	const first = rows[0] as string[];
	const years = first.slice(1).every((c) => /^\s*(19|20)\d{2}\s*$/.test(c)) && !isNumber(first[0]);
	const header = years || first.slice(1).some((c) => !isNumber(c));
	const notes: string[] = [];
	// A total row in an exported sheet would count everything twice.
	const totals = (header ? rows.slice(1) : rows).filter((r) => TOTAL.test((r[0] ?? "").trim()));
	const body = (header ? rows.slice(1) : rows).filter((r) => !totals.includes(r));
	if (totals.length > 0) notes.push(`Ho lasciato fuori ${totals.length === 1 ? "la riga" : "le righe"} «${(totals[0]?.[0] ?? "").trim()}»${totals.length > 1 ? " e simili" : ""}: è un totale delle altre.`);
	if (body.length === 0) throw new ChartError(`${source} ha solo l'intestazione`);
	const units = new Set<string>();
	const series: ChartSeries[] = [];
	const skipped: string[] = [];
	for (let col = 1; col < columns; col++) {
		const name = header ? (rows[0]?.[col] ?? "").trim() : "";
		if (!body.every((r) => isNumber(r[col]))) {
			skipped.push(name || `colonna ${col + 1}`);
			continue;
		}
		const values = body.map((r) => {
			const c = r[col];
			if (c === undefined || c.trim() === "") return null;
			const n = numberIn(c) as { value: number; unit?: string };
			if (n.unit !== undefined) units.add(n.unit);
			return n.value;
		});
		if (values.every((v) => v === null)) continue;
		series.push({ ...(name === "" ? {} : { name }), values });
	}
	if (series.length === 0) throw new ChartError(`in ${source} non ci sono colonne di numeri dopo la prima`);
	if (skipped.length > 0) notes.push(`Non ho disegnato le colonne che non sono numeri: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? " e altre" : ""}.`);
	if (series.length > CHART_LIMITS.maxSeries) {
		notes.push(`Ho disegnato le prime ${CHART_LIMITS.maxSeries} colonne di numeri su ${series.length}.`);
		series.length = CHART_LIMITS.maxSeries;
	}
	return { labels: body.map((r) => (r[0] ?? "").trim()), series, notes, ...(units.size === 1 ? { unit: [...units][0] as string } : {}) };
}
