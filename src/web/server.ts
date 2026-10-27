import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, sep } from "node:path";
import type { WebAction, WebActionResult } from "../core/web-actions.ts";
import type { GoogleAction, GoogleActionResult } from "../core/google-actions.ts";
import { desktopConnector, type DesktopPermission, type DesktopPermissions } from "../core/desktop.ts";
import type { PhoneAdapter } from "../channels/phone.ts";
import type { WhatsAppAdapter, WhatsAppTemplate } from "../channels/whatsapp.ts";
import type { CatalogEntry } from "../connectors/catalog.ts";
import type { ConnectorStatus, ConnectorStore } from "../connectors/mcp.ts";
import type { McpOAuth } from "../connectors/mcp-oauth.ts";
import { isApprover, OWNER, type Approver } from "../core/approvals.ts";
import type { ConnectorAction, ConnectorActionResult } from "../core/connector-actions.ts";
import { NotFound } from "../core/errors.ts";
import { SHARED, subjectOf } from "../core/memory.ts";
import { checkPersona, cleanName, type Persona, PersonaError } from "../core/persona.ts";
import { AGENT_CHANNEL } from "../core/agent-messages.ts";
import { AGENT_STATUS, agentStatus, runtimeActivity } from "../core/agent-activity.ts";
import type { BoardStore } from "../core/board.ts";
import type { ScreenViews } from "../core/screen-views.ts";
import type { RoutineStore } from "../core/board-routines.ts";
import type { BoardWork } from "../core/board-work.ts";
import type { ModelInfo } from "../core/model-providers.ts";
import { withChannel } from "../core/policy.ts";
import { type GoogleAccounts, type GoogleOAuth, type GoogleService, googleReturnQuery } from "../connectors/google.ts";
import { instanceId } from "../core/ids.ts";
import type { InstanceRecord, ModelSelection } from "../core/registry.ts";
import { ChatModels } from "../core/chat-models.ts";
import type { OwniRuntime } from "../core/runtime.ts";
import { DEFAULT_COST_CAPS, type UsageLedger } from "../core/usage.ts";
import { type PeopleStore, type Person, publicPerson, type SessionStore } from "./auth.ts";
import { WebChannel, type WebEntry } from "./channel.ts";
import { boardRoutes } from "./board-routes.ts";
import { capabilityRoutes } from "./capability-routes.ts";
import { orgRoutes } from "./org-routes.ts";
import { eventsRoutes } from "./events-routes.ts";
import { filesRoutes } from "./files-routes.ts";
import { mine, mineWatch, scheduleRoutes } from "./schedule-routes.ts";
import { approvalRoutes } from "./approval-routes.ts";
import { channelRoutes } from "./channel-routes.ts";
import { memoryRoutes } from "./memory-routes.ts";
import { modelRoutes } from "./model-routes.ts";
import { type BrowserPanel, browserRoutes } from "./browser-routes.ts";
import { chatRoutes } from "./chat-routes.ts";
import { connectorRoutes } from "./connector-routes.ts";
import { peopleRoutes } from "./people-routes.ts";
import { roomError, roomsRoutes } from "./rooms-routes.ts";
import { settingsRoutes } from "./settings-routes.ts";
import { webhooks } from "./hooks.ts";
import { type AddRoute, type Handler, HttpError, pathPattern, type Route, readJson, STREAMED, send } from "./http.ts";
import { screenRoutes } from "./screen-routes.ts";
import { runRoutes } from "./run-routes.ts";
import type { RoomEntry, Rooms } from "./rooms.ts";
import { ABOUT_MAX, INSTRUCTIONS_MAX, withAbout } from "./setup.ts";
import { proxyToken, sameSecret } from "./compare.ts";
import { otpauthUri } from "./totp.ts";
import { sendAsset } from "./assets.ts";

/** What a cell tells the control plane of Owni Cloud before being stopped. */
export type CellState = {
	/** Work under way: stopping now would delay it until the next start. */
	readonly busy: boolean;
	/** When to start it again by itself (next task programmato), or null. */
	readonly nextWakeAt: string | null;
	/**
	 * What the cell spent on the model (estimate from list prices): today, and per month
	 * ("YYYY-MM", Europe/Rome) so a month that closed while the cell slept can still be billed.
	 */
	readonly usage?: { readonly day: string; readonly todayUsd: number; readonly months: Readonly<Record<string, number>> };
};

export type TelegramStatus = {
	readonly connected: boolean;
	readonly username?: string;
	readonly mode: "webhook" | "polling";
	readonly allowedUsers: readonly string[];
	readonly approvers: readonly string[];
};

export type WhatsAppStatus = {
	readonly connected: boolean;
	readonly number?: string;
	readonly name?: string;
	/** Where Meta must send messages; null when this server has no public https address. */
	readonly webhookUrl: string | null;
	readonly verifyToken?: string;
	readonly allowedUsers: readonly string[];
	readonly approvers: readonly string[];
	/** The approved template sent outside the 24-hour window; null: messages wait without notice. */
	readonly template: WhatsAppTemplate | null;
};

export type WebAppOptions = {
	readonly runtime: OwniRuntime;
	readonly tenantId: string;
	readonly people: PeopleStore;
	readonly sessions: SessionStore;
	/** The web channel of each instance that has one. */
	readonly channels: ReadonlyMap<string, WebChannel>;
	/** Stanze with more agenti (ADR 0063); without them the console shows none. */
	readonly rooms?: Rooms;
	/** The general agente: its direct conversation comes first and opens the console (ADR 0113). */
	readonly main?: string;
	readonly connectors: (instanceId: string) => ConnectorStore;
	readonly connectorStatus: (instanceId: string) => readonly ConnectorStatus[];
	/** The browser panel of the chat; without it the console shows none. */
	readonly browser?: BrowserPanel;
	readonly usage: UsageLedger;
	readonly uiDir: string;
	/** Send cookies with Secure (behind https). */
	readonly secureCookies: boolean;
	readonly defaultTimeZone: string;
	/** The instructions a new instance starts with: «Primi passi» asks the owner to add their own. */
	readonly defaultInstructions?: string;
	/** The channels of an instance that are connected now (no network call): «Primi passi» reads them. */
	readonly connectedChannels?: (instanceId: string) => readonly string[];
	/** Read a page under an instance's policy, for a sentinella's first look (ADR 0018). */
	readonly watchRead?: (instanceId: string, url: string) => Promise<{ title: string; text: string }>;
	/** Telegram bots in webhook mode, by instance: the secret Telegram sends, and where the update goes. */
	readonly telegramHooks?: ReadonlyMap<string, { readonly secret: string; readonly handle: (update: unknown) => Promise<void> }>;
	/** The Telegram bot of each instance, connected by the owner from the console. */
	readonly telegram?: {
		status(instanceId: string): Promise<TelegramStatus>;
		/** Check the token with Telegram, keep it in the secret store, start the bot. */
		connect(instanceId: string, token: string): Promise<{ username: string | undefined }>;
		disconnect(instanceId: string): Promise<void>;
	};
	/** Voice messages can be transcribed here, by this service; the owner allows it per instance. */
	readonly voice?: { readonly host: string };
	/** Replies can go back as voice notes, made by this service (ADR 0020); the owner allows it per instance. */
	readonly speech?: { readonly host: string; readonly voice: string };
	/** The image service, when the operator set one (ADR 0023). */
	readonly images?: { readonly host: string; readonly maxPerDay: number };
	/** Sign-ins to MCP servers with OAuth (ADR 0024); without it, only token and public connectors. */
	readonly mcpOAuth?: McpOAuth;
	/** The one-click connectors (tests: fakes); the well-known servers otherwise. */
	readonly catalog?: readonly CatalogEntry[];
	/** The server's web search service (ADR 0017), by host; each owner turns it on per instance. */
	readonly search?: { readonly host: string };
	/** The instances' computers (ADR 0013), when this server has them: `reset` removes one with its files. */
	readonly computer?: { reset(instanceId: string): Promise<void>; check(): Promise<string | undefined> };
	/** What each agente last saw on its screen, per conversation (ADR 0067). */
	readonly screens?: ScreenViews;
	/** The agenti's screens through Cua (ADR 0045), when this server has them: whether they reach the internet, and whether one screen is shared. */
	readonly desktop?: { reset(instanceId: string): Promise<void>; check(): Promise<string | undefined>; readonly network: "none" | "internet" | "unknown"; readonly shared: boolean; readonly kind?: "local" | "remote"; permissions?(): Promise<DesktopPermissions>; requestPermission?(permission: DesktopPermission): Promise<DesktopPermissions> };
	/** Sends a form a person approved (ADR 0011), for an instance. */
	readonly sendWebAction?: (instanceId: string) => (action: WebAction) => Promise<WebActionResult>;
	/** Runs an approved connector call on the instance's live connection (ADR 0025). */
	readonly runConnectorAction?: (instanceId: string) => (action: ConnectorAction) => Promise<ConnectorActionResult>;
	/** The WhatsApp number of each instance that has one: its webhook. */
	readonly whatsappHooks?: ReadonlyMap<string, WhatsAppAdapter>;
	/** The phone number of each instance that has one: its webhook (ADR 0012). */
	readonly phoneHooks?: ReadonlyMap<string, PhoneAdapter>;
	/** A Twilio number per instance, connected by the owner from the console. */
	readonly phone?: {
		status(instanceId: string): Promise<{ connected: boolean; https: boolean; number?: string; accountSid?: string; allowedUsers: readonly string[] }>;
		/** Check with Twilio, point the number at this cell, keep the credentials. Values left out keep the saved ones. */
		connect(instanceId: string, credentials: { accountSid?: string; authToken?: string; number?: string; pin?: string }): Promise<{ number: string }>;
		disconnect(instanceId: string): Promise<void>;
	};
	/** WhatsApp per instance, connected by the owner from the console. */
	readonly whatsapp?: {
		status(instanceId: string): Promise<WhatsAppStatus>;
		/** Check with Meta, keep the credentials in the secret store, start receiving. Values left out keep the saved ones. */
		connect(instanceId: string, credentials: { accessToken?: string; phoneNumberId?: string; appSecret?: string; template?: WhatsAppTemplate | null }): Promise<{ number: string | undefined; name: string | undefined }>;
		disconnect(instanceId: string): Promise<void>;
	};
	/** Running as a cell of Owni Cloud: the control plane asks, with this secret, whether it may stop it. */
	readonly cell?: { readonly secret: string; readonly state: () => Promise<CellState> };
	/** People connect their own Google account (Gmail and Calendar): read, and write with their approval when `write` (ADR 0021). */
	readonly google?: {
		readonly oauth: GoogleOAuth;
		readonly accounts: GoogleAccounts;
		readonly services: readonly GoogleService[];
		readonly forget: (personId: string) => void;
		readonly write?: boolean;
		readonly canWrite?: (personId: string) => boolean;
		readonly runAction?: (instanceId: string) => (action: GoogleAction) => Promise<GoogleActionResult>;
	};
	/** The models of a provider Owni offers (ADR 0032); without it, the model cannot be changed here. */
	readonly models?: (provider: string) => readonly ModelInfo[];
	/** Providers whose key the operator gave the server: the owner uses it and cannot replace it. */
	readonly serverModelKeys?: readonly string[];
	/** Create an instance with its web channel, open for `ownerId` (owner only). */
	readonly createInstance?: (input: { id: string; name: string; instructions: string | undefined; persona: Persona; ownerId: string }) => Promise<void>;
	/** Delete an agente for good (ADR 0046); never the general one. */
	readonly deleteInstance?: { readonly main: string; readonly run: (id: string) => Promise<void> };
	/** The board (ADR 0050). */
	readonly board?: { readonly store: BoardStore; readonly work: BoardWork; readonly routines?: RoutineStore };
	readonly log?: (message: string) => void;
};

const COOKIE = "owni_session";
const MAX_CODE_ATTEMPTS = 5;
const CODE_LOCK_MS = 10 * 60 * 1000;

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

/** The web console and web channel of one tenant. */
export function createWebApp(options: WebAppOptions): Server {
	const { runtime, tenantId } = options;
	// Every file of a type in TYPES under the UI directory is served at its own path: a new page needs no entry here.
	const STATIC: Record<string, string> = { "/": "index.html", "/login": "index.html" };
	for (const file of readdirSync(options.uiDir, { recursive: true, encoding: "utf8" })) {
		const name = file.split(sep).join("/");
		if (extname(name) in TYPES) STATIC[`/${name}`] = name;
	}
	// The OpenUI frame (ADR 0118), next to the UI and outside the service worker's shell.
	const openuiDir = join(options.uiDir, "..", "openui");
	const OPENUI: Record<string, string> = { "/openui/frame": "frame.html", "/openui/frame.js": "frame.js", "/openui/frame.css": "frame.css", "/openui/openui-bundle.min.js": "openui-bundle.min.js", "/openui/openui-styles.css": "openui-styles.css" };
	const routes: Route[] = [];
	const route: AddRoute = (method, path, auth, handler) =>
		routes.push({ method, pattern: pathPattern(path), auth, handler: handler as unknown as Handler });

	// The agente of this id, or a 404.
	const knownInstance = (id: string) =>
		runtime.registry.getInstance(tenantId, id).catch(() => {
			throw new HttpError(404, "Agente inesistente");
		});
	const instanceAccess = async (person: Person, instanceId: string) => {
		let record;
		try {
			record = await runtime.registry.getInstance(tenantId, instanceId);
		} catch {
			throw new HttpError(404, "No such instance");
		}
		const member = (record.allowedUsers.web ?? []).includes(person.id);
		if (person.role !== "owner" && !member) throw new HttpError(404, "No such instance");
		return { record, member };
	};
	// Two-factor codes tried per person, in this process. An attempt counts before the
	// check, so codes sent all at once cannot slip past the limit; a right code clears it.
	const codeAttempts = new Map<string, number[]>();
	const checkCode = async (personId: string, code: string): Promise<boolean> => {
		const recent = (codeAttempts.get(personId) ?? []).filter((at) => at > Date.now() - CODE_LOCK_MS);
		if (recent.length >= MAX_CODE_ATTEMPTS) throw new HttpError(429, "Troppi codici sbagliati: riprova tra qualche minuto", { twoFactor: true });
		codeAttempts.set(personId, [...recent, Date.now()]);
		if (!(await options.people.useTotp(personId, code))) return false;
		codeAttempts.delete(personId);
		return true;
	};
	// Each open event stream, as the way to attach it to a channel created later.
	const streamAttachers = new Set<(channel: WebChannel) => void>();
	const approverOf = (person: Person): Approver => (person.role === "owner" ? OWNER : { channel: "web", userId: person.id });
	const channelOf = (instanceId: string) => {
		const channel = options.channels.get(instanceId);
		if (channel === undefined) throw new HttpError(409, "This instance has no web channel");
		return channel;
	};
	/** A console conversation of the person with an agente they can open; anyone else's is not there. */
	const ownThread = async (person: Person, instanceId: string, threadId: string) => {
		const { record } = await instanceAccess(person, instanceId);
		const thread = await channelOf(instanceId).thread(threadId);
		if (thread === undefined || thread.personId !== person.id) throw new HttpError(404, "No such thread");
		return record;
	};
	// The models of the console's chats (ADR 0036), with the instance's and the owner's keys.
	const chats = new ChatModels(runtime, tenantId, { models: (provider) => options.models?.(provider) ?? [], serverModelKeys: options.serverModelKeys ?? [] });
	const named = (model: ModelSelection) => chats.named(model);
	/** An entry of a chat or a stanza with the name of the model that wrote it. */
	const shown = <E extends WebEntry | RoomEntry>(entry: E): E => (entry.model === undefined ? entry : { ...entry, model: named(entry.model) });
	const usageSummary = async () => ({ todayUsd: await options.usage.todaySpent(), softUsd: DEFAULT_COST_CAPS.softUsdPerDay, hardUsd: DEFAULT_COST_CAPS.hardUsdPerDay });
	const { phoneHook, automationHook, whatsappHook, telegramHook } = webhooks({ runtime, tenantId, phoneHooks: options.phoneHooks, whatsappHooks: options.whatsappHooks, telegramHooks: options.telegramHooks, log: options.log });

	// --- session ---
	route("POST", "/api/login", "none", async ({ req, res }) => {
		const body = (await readJson(req)) as { token?: string; code?: string };
		const person = await options.people.byToken(String(body.token ?? ""));
		if (person === undefined) throw new HttpError(401, "Link non valido o revocato");
		if (person.totp !== undefined) {
			if (typeof body.code !== "string" || body.code.trim() === "") throw new HttpError(401, "Serve il codice dell'app di autenticazione", { twoFactor: true });
			if (!(await checkCode(person.id, body.code))) {
				await runtime.audit(tenantId).append({ type: "web.login_denied", personId: person.id, reason: "2fa" });
				throw new HttpError(401, "Codice non valido", { twoFactor: true });
			}
		}
		const session = await options.sessions.create(person.id);
		res.setHeader("set-cookie", `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 3600}${options.secureCookies ? "; Secure" : ""}`);
		await runtime.audit(tenantId).append({ type: "web.login", personId: person.id });
		return { person: publicPerson(person) };
	});
	route("POST", "/api/logout", "person", async ({ req, res }) => {
		const session = cookie(req, COOKIE);
		if (session !== undefined) await options.sessions.end(session);
		res.setHeader("set-cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
		return { ok: true };
	});
	route("GET", "/api/me", "person", async ({ person }) => ({ person: publicPerson(person) }));
	route("POST", "/api/me/2fa/setup", "person", async ({ person: p }) => {
		if (p.totp !== undefined) throw new HttpError(409, "La verifica in due passaggi è già attiva");
		const secret = await options.people.startTotp(p.id);
		return { secret, uri: otpauthUri(secret, p.name, "Owni") };
	});
	route("POST", "/api/me/2fa/enable", "person", async ({ person: p, req }) => {
		const body = (await readJson(req)) as { code?: string };
		if (!(await options.people.enableTotp(p.id, String(body.code ?? "")))) throw new HttpError(400, "Codice non valido: controlla l'ora del telefono e riprova");
		// Sessions opened with the link alone (maybe a leaked one) end; this one stays.
		await options.sessions.endAllOf(p.id, cookie(req, COOKIE));
		await runtime.audit(tenantId).append({ type: "web.2fa_enabled", personId: p.id });
		return { ok: true };
	});
	route("POST", "/api/me/2fa/disable", "person", async ({ person: p, req }) => {
		const body = (await readJson(req)) as { code?: string };
		if (p.totp === undefined) return { ok: true };
		if (!(await checkCode(p.id, String(body.code ?? "")))) throw new HttpError(400, "Codice non valido");
		await options.people.clearTotp(p.id);
		await runtime.audit(tenantId).append({ type: "web.2fa_disabled", personId: p.id });
		return { ok: true };
	});

	// --- instances ---
	/** Whether this person may write to the instance from the console. */
	const canChatWith = (r: InstanceRecord, p: Person) => options.channels.has(r.id) && (r.allowedUsers.web ?? []).includes(p.id) && r.egress.channels.includes("web");
	const describeInstance = async (r: InstanceRecord, p: Person) => ({
		id: r.id,
		name: r.name,
		canChat: canChatWith(r, p),
		isApprover: await isApprover(runtime, tenantId, r.id, approverOf(p)),
		...(r.id === options.main ? { main: true } : {}),
		...(r.persona?.tagline === undefined ? {} : { tagline: r.persona.tagline }),
	});
	/**
	 * A persona from a request body, or a 400 saying what is wrong. Given from the console, so the
	 * agente goes by its name from now on (ADR 0041). The whole persona is replaced, never merged:
	 * the console always sends all of it.
	 */
	const personaOf = (input: unknown): Persona => {
		try {
			return { ...checkPersona(input), named: true };
		} catch (error) {
			throw error instanceof PersonaError ? new HttpError(400, error.message) : error;
		}
	};
	route("GET", "/api/instances", "person", async ({ person: p }) => {
		const all = await runtime.registry.listInstances(tenantId);
		const visible = all.filter((r) => p.role === "owner" || (r.allowedUsers.web ?? []).includes(p.id));
		return { instances: await Promise.all(visible.map((r) => describeInstance(r, p))) };
	});
	const activity = runtimeActivity({ runtime, tenant: tenantId, board: options.board, channel: (id) => options.channels.get(id) });
	/**
	 * Who is doing what (ADR 0109) as one status (ADR 0125), computed only here for the Agenti page,
	 * the organigramma, the board and the agente's panel. The line says what this person already sees.
	 */
	const agentNow = async (r: InstanceRecord, p: Person) => {
		const [now, waiting] = await Promise.all([activity(r.id, { person: p.id }), waitsOn(p, r)]);
		const status = agentStatus(now, waiting);
		return { status, statusText: AGENT_STATUS[status], doing: now.doing };
	};
	// The page «Agenti» (ADR 0041): each agente with its face, its model and what it does by itself.
	route("GET", "/api/agents", "person", async ({ person: p }) => {
		const all = await runtime.registry.listInstances(tenantId);
		const visible = all.filter((r) => p.role === "owner" || (r.allowedUsers.web ?? []).includes(p.id));
		const agents = await Promise.all(
			visible.map(async (r) => {
				const [schedules, watches, now] = await Promise.all([runtime.schedules(tenantId, r.id).list(), runtime.watches(tenantId, r.id).list(), agentNow(r, p)]);
				// Like their pages: a member counts only what acts for them.
				const owner = p.role === "owner";
				return {
					...(await describeInstance(r, p)),
					model: named(r.model),
					tone: r.persona?.tone ?? "naturale",
					channels: r.egress.channels,
					...now,
					schedules: owner ? schedules.length : schedules.filter((s) => mine(s, p)).length,
					watches: owner ? watches.length : watches.filter((w) => mineWatch(w, p)).length,
					memories: runtime.memory(tenantId, r.id).list().filter((m) => m.about === SHARED || m.about === subjectOf("web", p.id)).length,
					// Which agenti may write to it (ADR 0042): the owner's to decide, so the owner's to see.
					...(owner ? { acceptsFrom: r.egress.channels.includes(AGENT_CHANNEL) ? (r.allowedUsers[AGENT_CHANNEL] ?? []) : [] } : {}),
				};
			}),
		);
		return { agents };
	});
	/** A new agente from the console, open to the owner who makes it: from the form, or in a squadra. */
	const makeAgent = async (person: Person, input: { id: string; name: string; instructions: string | undefined; persona: Persona }) => {
		if (options.createInstance === undefined) throw new HttpError(501, "Questa installazione non crea agenti dalla console");
		const { id, persona } = input;
		const name = cleanName(input.name);
		const given = input.instructions !== undefined && input.instructions.trim() !== "" ? input.instructions : undefined;
		if (given !== undefined && options.defaultInstructions !== undefined && given.length > ABOUT_MAX) throw new HttpError(400, `Istruzioni troppo lunghe: al massimo ${ABOUT_MAX} caratteri`);
		// Like «Primi passi»: the owner's words go after the defaults, so what Owni can do stays said.
		const instructions = given === undefined ? undefined : options.defaultInstructions === undefined ? given.slice(0, INSTRUCTIONS_MAX) : withAbout(options.defaultInstructions, given);
		try {
			instanceId(id);
		} catch {
			throw new HttpError(400, "ID non valido: minuscole, numeri, - e _, fino a 63 caratteri, iniziando con una lettera o un numero");
		}
		if (name === "") throw new HttpError(400, "Serve un nome");
		if (await agentExists(id)) throw new HttpError(409, "Un agente con questo ID esiste già");
		try {
			await options.createInstance({ id, name, instructions, persona, ownerId: person.id });
		} catch (error) {
			// Two creations of the same id at once: the second loses here.
			if (error instanceof Error && error.message.startsWith("Already exists")) throw new HttpError(409, "Un agente con questo ID esiste già");
			throw error;
		}
		await runtime.audit(tenantId).append({ type: "web.instance_created", instanceId: id, personId: person.id });
		const channel = options.channels.get(id);
		if (channel !== undefined) for (const attach of streamAttachers) attach(channel);
	};
	const agentExists = async (id: string) => {
		try {
			await runtime.registry.getInstance(tenantId, id);
			return true;
		} catch (error) {
			if (error instanceof NotFound) return false;
			throw error;
		}
	};
	route("POST", "/api/instances", "owner", async ({ person, req }) => {
		if (options.createInstance === undefined) throw new HttpError(501, "Questa installazione non crea agenti dalla console");
		const body = (await readJson(req)) as { id?: unknown; name?: unknown; instructions?: unknown; persona?: unknown };
		const id = typeof body.id === "string" ? body.id.trim() : "";
		await makeAgent(person, { id, name: typeof body.name === "string" ? body.name : "", instructions: typeof body.instructions === "string" ? body.instructions : undefined, persona: personaOf(body.persona) });
		return { instance: await describeInstance(await runtime.registry.getInstance(tenantId, id), person) };
	});

	// Deleting an agente (ADR 0046): the owner types its name, as it is now, to confirm.
	const deletable = (id: string) => options.deleteInstance !== undefined && id !== options.deleteInstance.main;
	route("DELETE", "/api/instances/:id", "owner", async ({ person, params, req }) => {
		const remover = options.deleteInstance;
		if (remover === undefined) throw new HttpError(501, "Questa installazione non elimina agenti dalla console");
		const id = params[0];
		const record = await knownInstance(id);
		if (id === remover.main) throw new HttpError(400, `${record.name} è l'agente principale: non si elimina`);
		const body = (await readJson(req)) as { confirm?: unknown };
		if (body.confirm !== record.name) throw new HttpError(400, `Per confermare scrivi il nome dell'agente esattamente così: «${record.name}»`);
		await remover.run(id);
		await runtime.audit(tenantId).append({ type: "web.instance_deleted", instanceId: id, personId: person.id });
		return { ok: true };
	});

	// --- the board (ADR 0050) ---
	boardRoutes(route, { runtime, tenantId, people: options.people, board: options.board, agentNow });
	capabilityRoutes(route, { runtime, tenantId, knownInstance, voice: options.voice, speech: options.speech, images: options.images, search: options.search, computer: options.computer, desktop: options.desktop, google: options.google });

	// --- the organigramma (ADR 0117): who does what, and who writes to whom ---
	/** The agenti that may write to this one (ADR 0042), as the organigramma says (ADR 0117): never itself. */
	const allowAgents = async (person: Person, id: string, asked: readonly string[]): Promise<string[]> => {
		const record = await runtime.registry.getInstance(tenantId, id);
		const known = new Set<string>((await runtime.registry.listInstances(tenantId)).map((r) => r.id));
		const from = [...new Set(asked)].filter((x) => x !== String(record.id) && known.has(x));
		await runtime.registry.setAllowedUsers(tenantId, id, AGENT_CHANNEL, from);
		await runtime.registry.setEgress(tenantId, id, (egress) => withChannel(egress, AGENT_CHANNEL, from.length > 0));
		await runtime.audit(tenantId).append({ type: "agents.allowed", instanceId: id, personId: person.id, allowed: from.length, from: from.join(",") });
		return from;
	};
	orgRoutes(route, {
		store: runtime.org(tenantId),
		agents: async () =>
			(await runtime.registry.listInstances(tenantId))
				.map((r) => ({ id: r.id, name: r.name, accepts: r.egress.channels.includes(AGENT_CHANNEL) ? (r.allowedUsers[AGENT_CHANNEL] ?? []) : [] })),
		allow: (person, id, from) => allowAgents(person, id, from),
		audit: (event) => runtime.audit(tenantId).append(event),
	});

	// --- chat ---
	runRoutes(route, { runtime, tenantId, access: instanceAccess, channel: channelOf });
	chatRoutes(route, { runtime, tenantId, models: options.models, instanceAccess, channelOf, chats, named, shown });
	// --- the conversation's browser (ADR 0044): watched and driven from the panel next to the chat ---
	browserRoutes(route, { runtime, tenantId, browser: options.browser, instanceAccess, channelOf, ownThread });
	screenRoutes(route, {
		screens: options.screens,
		thread: async (person, instanceId, threadId) => {
			const record = await ownThread(person, instanceId, threadId);
			return options.desktop !== undefined && (record.egress.connectors ?? []).includes(desktopConnector(options.desktop));
		},
	});
	// --- the console's live stream ---
	eventsRoutes(route, { runtime, tenantId, sessions: options.sessions, people: options.people, channels: options.channels, board: options.board, rooms: options.rooms, sessionOf: (req) => cookie(req, COOKIE), ownThread, shown, streamAttachers });

	// --- files, and artifacts (ADR 0112) ---
	filesRoutes(route, { runtime, tenantId, rooms: options.rooms, instanceAccess, channelOf, ownThread });

	// --- tasks programmati, automazioni (ADR 0060), brief del mattino, sentinelle (ADR 0018) ---
	scheduleRoutes(route, { runtime, tenantId, defaultTimeZone: options.defaultTimeZone, google: options.google, watchRead: options.watchRead, instanceAccess, channelOf });

	// --- what waits for a decision: tools proposti, forms, connector calls, Google writes; the inbox ---
	const waitsOn = approvalRoutes(route, { runtime, tenantId, sendWebAction: options.sendWebAction, runConnectorAction: options.runConnectorAction, google: options.google, board: options.board, log: options.log, instanceAccess, approverOf, usageSummary });

	// --- owner: an instance's computer and screen, settings, primi passi, the sites it reads ---
	settingsRoutes(route, { runtime, tenantId, computer: options.computer, desktop: options.desktop, people: options.people, defaultInstructions: options.defaultInstructions, browser: options.browser, connectedChannels: options.connectedChannels, connectors: options.connectors, search: options.search, voice: options.voice, speech: options.speech, images: options.images, knownInstance, instanceAccess, channelOf, personaOf, deletable });

	// --- owner: an instance's connectors and their secrets ---
	connectorRoutes(route, { runtime, tenantId, connectors: options.connectors, connectorStatus: options.connectorStatus, cell: options.cell, mcpOAuth: options.mcpOAuth, catalog: options.catalog });
	// --- the model (ADR 0032): any provider Owni offers, with the server's key or the owner's ---
	modelRoutes(route, { runtime, tenantId, models: options.models, chats, knownInstance });
	// --- memoria and skill: what an agente remembers and knows how to do, as each person sees it ---
	memoryRoutes(route, { runtime, tenantId, instanceAccess });

	// --- stanze (ADR 0063): one person's, with the agenti they can write to ---
	roomsRoutes(route, { runtime, tenantId, rooms: options.rooms, main: options.main, canChatWith, channelOf, shown });

	// --- each person's Google account, and the people the owner lets in ---
	peopleRoutes(route, { runtime, tenantId, people: options.people, sessions: options.sessions, google: options.google, browser: options.browser, board: options.board });

	// --- owner: Telegram, WhatsApp and phone of an instance ---
	channelRoutes(route, { runtime, tenantId, telegram: options.telegram, whatsapp: options.whatsapp, phone: options.phone, log: options.log, knownInstance });

	route("GET", "/api/usage", "person", async () => ({ usage: await usageSummary() }));
	route("GET", "/api/audit", "owner", async ({ url }) => {
		const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
		return { events: (await runtime.audit(tenantId).read(limit)).reverse() };
	});

	const server = createServer((req, res) => {
		void handle(req, res).catch((error: unknown) => {
			options.log?.(`web: ${req.method} ${new URL(req.url ?? "/", "http://owni.local").pathname}: ${error instanceof Error ? error.message : String(error)}`);
			if (!res.headersSent) send(res, 500, { error: "Errore interno" });
			else res.end();
		});
	});

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		securityHeaders(res);
		const url = new URL(req.url ?? "/", "http://owni.local");
		if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
		if (req.method === "GET" && url.pathname === "/internal/cell") return cellState(req, res);
		if (req.method === "POST" && url.pathname === "/internal/owner-link") return ownerLink(req, res);
		// A cell on a platform has a public address of its own: there it answers only what came through
		// the control plane, which checks sleep and subscription first.
		if (options.cell !== undefined && !sameSecret(String(req.headers["x-owni-proxy"] ?? ""), cellProxyToken)) return send(res, 404, { error: "Not found" });
		if (req.method === "GET" && url.pathname in STATIC) return serveStatic(req, res, STATIC[url.pathname] as string);
		if (req.method === "GET" && Object.hasOwn(OPENUI, url.pathname)) return serveOpenui(req, res, OPENUI[url.pathname] as string);
		const hook = /^\/hooks\/telegram\/([a-z0-9_-]+)$/.exec(url.pathname);
		if (req.method === "POST" && hook !== null) return telegramHook(req, res, hook[1] as string);
		const phone = /^\/hooks\/phone\/([a-z0-9_-]+)$/.exec(url.pathname);
		if (phone !== null && req.method === "POST") return phoneHook(req, res, url, phone[1] as string);
		const automation = /^\/hooks\/automazione\/([a-z0-9_-]+)\/([a-f0-9]{12})$/.exec(url.pathname);
		if (automation !== null && req.method === "POST") return automationHook(req, res, url, automation[1] as string, automation[2] as string);
		const wa = /^\/hooks\/whatsapp\/([a-z0-9_-]+)$/.exec(url.pathname);
		if (wa !== null && (req.method === "GET" || req.method === "POST")) return whatsappHook(req, res, url, wa[1] as string);
		if (req.method === "GET" && url.pathname === "/oauth/google/callback") return googleCallback(res, url);
		if (req.method === "GET" && url.pathname === "/oauth/mcp/callback") return mcpCallback(res, url);
		if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "Not found" });
		const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
		if (match === undefined) return send(res, 404, { error: "Not found" });
		// A header a cross-site form or image cannot send: every change needs it.
		if (req.method !== "GET" && req.headers["x-owni"] !== "1") return send(res, 403, { error: "Missing X-Owni header" });
		let person: Person | undefined;
		if (match.auth !== "none") {
			const personId = await options.sessions.personOf(cookie(req, COOKIE));
			person = personId === undefined ? undefined : await options.people.get(personId);
			if (person === undefined) return send(res, 401, { error: "Accesso richiesto" });
			if (match.auth === "owner" && person.role !== "owner") return send(res, 403, { error: "Solo l'owner" });
		}
		const params = (match.pattern.exec(url.pathname) ?? []).slice(1).map((p) => decodeURIComponent(p));
		try {
			const result = await match.handler({ req, res, url, params, person });
			if (result !== STREAMED) send(res, 200, result);
		} catch (error) {
			if (error instanceof HttpError) return send(res, error.status, { ...error.extra, error: error.message });
			throw error;
		}
	}

	/** Back from an MCP server's sign-in: like Google's, the console finishes with its own request. */
	function mcpCallback(res: ServerResponse, url: URL): void {
		res.writeHead(302, { location: `/#/connettore?${googleReturnQuery(url)}`, "cache-control": "no-store" });
		res.end();
	}

	/**
	 * Where Google sends the person back. The session cookie is SameSite=Strict, so it does not
	 * come with a navigation from Google: the console picks the code up from the fragment and
	 * finishes with its own request, which carries the session.
	 */
	function googleCallback(res: ServerResponse, url: URL): void {
		res.writeHead(302, { location: `/#/google?${googleReturnQuery(url)}`, "cache-control": "no-store" });
		res.end();
	}

	const cellProxyToken = options.cell === undefined ? "" : proxyToken(options.cell.secret);

	/** The control plane of Owni Cloud, with the cell's secret. */
	function fromControlPlane(req: IncomingMessage, res: ServerResponse): boolean {
		if (options.cell === undefined) {
			send(res, 404, { error: "Not found" });
			return false;
		}
		const given = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
		if (sameSecret(given, options.cell.secret)) return true;
		send(res, 401, { error: "Unauthorized" });
		return false;
	}

	async function cellState(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (!fromControlPlane(req, res)) return;
		send(res, 200, await (options.cell as NonNullable<WebAppOptions["cell"]>).state());
	}

	/**
	 * A new login link for the first owner, each time they sign in to Owni Cloud. The old link
	 * stops working; open sessions stay. With two-factor on, the link alone still does not log in.
	 */
	async function ownerLink(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (!fromControlPlane(req, res)) return;
		const owner = (await options.people.list()).find((p) => p.role === "owner");
		if (owner === undefined) return send(res, 409, { error: "No owner yet" });
		const token = await options.people.rotate(owner.id);
		await runtime.audit(tenantId).append({ type: "cell.owner_link", personId: owner.id });
		send(res, 200, { token });
	}

	async function serveStatic(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
		// Scripts and the stylesheet are checked at every visit (and the service worker with them): the files of one deploy must load together, never a mix with an older cached one.
		const cache = name === "index.html" ? "no-store" : [".js", ".css"].includes(extname(name)) ? "no-cache" : name.startsWith("fonts/") ? "public, max-age=31536000, immutable" : "public, max-age=300";
		// A font is always fetched with CORS: the OpenUI frame, with no origin of its own, may use them too.
		await sendAsset(req, res, join(options.uiDir, name), { "content-type": TYPES[extname(name)] ?? "application/octet-stream", "cache-control": cache, ...(name.startsWith("fonts/") ? { "access-control-allow-origin": "*" } : {}) });
	}

	/** A file of the OpenUI frame: the page itself sandboxed by its CSP, the bundle cached for its version. */
	async function serveOpenui(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
		if (name === "frame.html") {
			const data = await readFile(join(openuiDir, name));
			res.removeHeader("x-frame-options");
			const nonce = randomBytes(16).toString("base64");
			res.writeHead(200, { "content-type": TYPES[".html"] as string, "content-security-policy": openuiCsp(nonce, req.headers.host), "cache-control": "no-cache" });
			res.end(data.toString("utf8").replaceAll("__NONCE__", nonce));
			return;
		}
		const cache = name.startsWith("openui-") ? "public, max-age=31536000, immutable" : "no-cache";
		await sendAsset(req, res, join(openuiDir, name), { "content-type": TYPES[extname(name)] as string, "cache-control": cache });
	}

	return server;
}

function securityHeaders(res: ServerResponse): void {
	res.setHeader("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
	res.setHeader("x-content-type-options", "nosniff");
	res.setHeader("referrer-policy", "no-referrer");
	res.setHeader("x-frame-options", "DENY");
}

/**
 * The OpenUI frame (ADR 0118): an opaque origin like an artifact, but it runs only Owni's own scripts
 * (the vendored bundle and the frame script, pinned by a nonce per response), loads no pictures, and sends nothing out.
 * WebKit (Safari, the Mac app) never matches 'self' from a sandboxed frame, so scripts go by nonce, and Owni's own
 * stylesheets and fonts by the host the frame was asked from, never another one: a font from elsewhere could carry data out.
 */
function openuiCsp(nonce: string, host: string | undefined): string {
	const own = host !== undefined && /^([a-z0-9.-]+|\[[0-9a-f:]+\])(:\d+)?$/i.test(host) ? `http://${host} https://${host}` : "'none'";
	return `sandbox allow-scripts; default-src 'none'; script-src 'nonce-${nonce}'; style-src ${own} 'unsafe-inline'; img-src data: blob:; font-src ${own}; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`;
}

function cookie(req: IncomingMessage, name: string): string | undefined {
	for (const part of (req.headers.cookie ?? "").split(";")) {
		const [k, ...v] = part.trim().split("=");
		if (k === name) return v.join("=");
	}
	return undefined;
}
