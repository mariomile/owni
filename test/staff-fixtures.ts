/** The staff tests' fixture: synthetic names and data only. */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_CHANNEL } from "../src/core/agent-messages.ts";
import type { AppointmentSettings } from "../src/core/appointments.ts";
import { AppointmentStore } from "../src/core/appointment-store.ts";
import type { ToolContext } from "../src/core/engine.ts";
import type { MakeInput } from "../src/core/make-document.ts";
import type { Absence, Person } from "../src/core/staff.ts";
import { StaffStore } from "../src/core/staff-store.ts";
import { type AppointmentEvent, createAppointmentTools } from "../src/core/tools/appointment-tools.ts";
import { createStaffTools, type StaffEvent } from "../src/core/tools/staff-tools.ts";
import type { TurnOrigin } from "../src/core/turn-origin.ts";
import { Workspace } from "../src/core/workspace.ts";

// Monday 19 October 2026, 10:00 in Rome (CEST).
export const NOW = new Date("2026-10-19T08:00:00Z");
export const MARK = { by: "test:u", at: NOW.toISOString() };

const NINE_SIX = [{ from: "09:00", to: "13:00" }, { from: "14:00", to: "18:00" }];
/** Giulia: Monday to Friday, 9-13 and 14-18; Marco: Tuesday to Saturday, 9-13 and 15-19, the resource «Marco». */
export const GIULIA: Person = { id: "PE-0001", name: "Giulia Verdi", role: "commessa", weeklyHours: "40", week: { "1": NINE_SIX, "2": NINE_SIX, "3": NINE_SIX, "4": NINE_SIX, "5": NINE_SIX }, ferieDays: "26", rolHours: "72", ...MARK };
const MARCO_DAY = [{ from: "09:00", to: "13:00" }, { from: "15:00", to: "19:00" }];
export const MARCO: Person = { id: "PE-0002", name: "Marco Neri", role: "parrucchiere", weeklyHours: "40", week: { "2": MARCO_DAY, "3": MARCO_DAY, "4": MARCO_DAY, "5": MARCO_DAY, "6": MARCO_DAY }, ferieDays: "26", rolHours: "72", resource: "Marco", ...MARK };

export const HOURS: AppointmentSettings = {
	business: "Salone Prova",
	week: {
		"1": [{ from: "09:00", to: "13:00" }, { from: "14:00", to: "19:00" }],
		"2": [{ from: "09:00", to: "13:00" }, { from: "14:00", to: "19:00" }],
		"3": [{ from: "09:00", to: "13:00" }, { from: "14:00", to: "19:00" }],
		"4": [{ from: "09:00", to: "13:00" }, { from: "14:00", to: "19:00" }],
		"5": [{ from: "09:00", to: "13:00" }, { from: "14:00", to: "19:00" }],
		"6": [{ from: "09:00", to: "13:00" }],
	},
	resources: ["Marco", "Giulia"],
	services: [{ name: "Taglio", minutes: 30 }],
	...MARK,
};

let n = 0;
export const absence = (o: Partial<Absence> & Pick<Absence, "person" | "kind" | "from">): Absence => ({ id: `AS-${String(++n).padStart(4, "0")}`, to: o.from, callId: `c${n}`, ...MARK, ...o }) as Absence;

let calls = 0;
export const fresh = (callId = `s${++calls}`, origin: TurnOrigin = "person", thread = { channel: "test", threadId: "t1" }): ToolContext => ({ step: (_key, work) => work(), progress: () => {}, origin, signal: new AbortController().signal, callId, thread });
export const agent = () => fresh(undefined, "agent", { channel: AGENT_CHANNEL, threadId: "a1" });

export const FENCE = /<<<dati (?:del personale|degli appuntamenti) ([0-9a-f]{12}):[^\n]*>>>\n([\s\S]*?)\n<<<fine dati (?:del personale|degli appuntamenti) \1>>>/g;
export const outside = (text: string) => text.replace(FENCE, "");
export const inside = (text: string) => [...text.matchAll(FENCE)].map((m) => m[2] as string).join("\n");
export const checkIn = (answer: string) => /il controllo ([0-9a-f]{16})/.exec(answer)?.[1] as string;
export const EMDASH = /\u2014/;

const dirs: string[] = [];
/** Only the directories the tests made, each by its exact path (afterEach). */
export function cleanup(): void {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function setup(o: { people?: Person[]; hours?: AppointmentSettings | null } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "owni-staff-"));
	dirs.push(dir);
	const root = join(dir, "workspace");
	mkdirSync(root, { recursive: true });
	const workspace = new Workspace(root);
	const store = new StaffStore(dir);
	const people = o.people ?? [GIULIA, MARCO];
	store.update("seed", (st) => ({ ...st, people, nextPerson: people.length + 1 }));
	const appointments = new AppointmentStore(dir);
	if (o.hours !== null) appointments.update("seed", (st) => ({ ...st, settings: o.hours ?? HOURS }));
	const events: (StaffEvent | AppointmentEvent)[] = [];
	const clock = { now: NOW };
	const made: MakeInput[] = [];
	const make = async (input: MakeInput) => {
		made.push(input);
		return { data: new TextEncoder().encode(input.text), notes: [] };
	};
	const [tool] = createStaffTools({ workspace, store, appointments, timeZone: "Europe/Rome", whoIs: () => "test:u", record: async (e) => void events.push(e), now: () => clock.now, make });
	const [appTool] = createAppointmentTools({ workspace, store: appointments, timeZone: "Europe/Rome", whoIs: () => "test:u", record: async (e) => void events.push(e), now: () => clock.now, absences: (day) => store.blocksOn(day), staffBroken: () => store.broken() });
	if (tool === undefined || appTool === undefined) throw new Error("no tool");
	const run = async (args: Record<string, unknown>, c: ToolContext = fresh()) => String(await tool.execute(args, c));
	const book = async (args: Record<string, unknown>, c: ToolContext = fresh()) => String(await appTool.execute(args, c));
	return { dir, root, store, appointments, events, clock, made, tool, run, book };
}

export type S = ReturnType<typeof setup>;
