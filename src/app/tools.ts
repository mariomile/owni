import type { AgentChannel } from "../channels/agents.ts";
import type { speaker, VoicePreferences } from "../channels/speech.ts";
import { type pieceTranscriber, VOICE_CONNECTOR } from "../channels/voice.ts";
import { CONNECTOR_CATALOG, type CatalogEntry } from "../connectors/catalog.ts";
import { type ConnectorStore, McpConnections, type McpConnectionsOptions } from "../connectors/mcp.ts";
import type { McpOAuth } from "../connectors/mcp-oauth.ts";
import { type runtimeActivity, viewerOf } from "../core/agent-activity.ts";
import { askedByIn } from "../core/agent-asks.ts";
import { type AgentRate, agentThreadId } from "../core/agent-messages.ts";
import type { BoardStore } from "../core/board.ts";
import type { BoardWork } from "../core/board-work.ts";
import { readOnlyInBriefs } from "../core/brief.ts";
import { type ComputerProvider, computerKey } from "../core/computer.ts";
import { desktopConnector, type DesktopProvider } from "../core/desktop.ts";
import type { AuditEvent } from "../core/audit.ts";
import type { OwniTool } from "../core/engine.ts";
import { EgressDenied, UserNotAllowed } from "../core/errors.ts";
import type { ecbRates } from "../core/exchange-rates.ts";
import type { imageGenerator } from "../core/image-generation.ts";
import type { feedNews } from "../core/news.ts";
import type { InstanceRecord } from "../core/registry.ts";
import type { OwniRuntime, ToolSet } from "../core/runtime.ts";
import type { ScreenViews } from "../core/screen-views.ts";
import { TranscriptionNotAllowed } from "../core/recordings.ts";
import { createAgentTools } from "../core/tools/agent-tools.ts";
import { createArtifactTools } from "../core/tools/artifact-tools.ts";
import { createAutomationTools } from "../core/tools/automation-tools.ts";
import { createBoardTools } from "../core/tools/board-tools.ts";
import { createChartTools } from "../core/tools/chart-tools.ts";
import { createCodeTools } from "../core/tools/code-tools.ts";
import { createComputerTools } from "../core/tools/computer-tools.ts";
import { createCustomTools } from "../core/tools/custom-tools.ts";
import { createDateTools } from "../core/tools/date-tools.ts";
import { createDesktopTools } from "../core/tools/desktop-tools.ts";
import { createDocumentTools } from "../core/tools/document-tools.ts";
import { createExchangeTools } from "../core/tools/exchange-tools.ts";
import { createImageTools } from "../core/tools/image-tools.ts";
import { createListTools } from "../core/tools/list-tools.ts";
import { createMemoryTools } from "../core/tools/memory-tools.ts";
import { createNewsTools } from "../core/tools/news-tools.ts";
import { createOpenuiTools } from "../core/tools/openui-tools.ts";
import { createRecordingTools } from "../core/tools/recording-tools.ts";
import { createResearchTools } from "../core/tools/research-tools.ts";
import { createScheduleTools } from "../core/tools/schedule-tools.ts";
import { createSkillTools } from "../core/tools/skill-tools.ts";
import { createVatTools } from "../core/tools/vat-tools.ts";
import { createVoiceTools } from "../core/tools/voice-tools.ts";
import { createWatchTools } from "../core/tools/watch-tools.ts";
import { createWeatherTools } from "../core/tools/weather-tools.ts";
import { createWebTools } from "../core/tools/web-tools.ts";
import { createWorkspaceTools } from "../core/tools/workspace-tools.ts";
import type { ToolProposal } from "../core/proposals.ts";
import type { viesClient } from "../core/vies.ts";
import type { openMeteo } from "../core/weather.ts";
import type { WebAction } from "../core/web-actions.ts";
import type { braveSearch, dailyCounter, dailyLimit } from "../core/web-search.ts";
import type { Browser, BrowseSessions } from "../core/web-session.ts";
import type { OwniConfig } from "../main/config.ts";
import { WebChannel } from "../web/channel.ts";

export type ToolsWiring = {
	readonly runtime: OwniRuntime;
	readonly config: OwniConfig;
	readonly log: (message: string) => void;
	/** Tests: which addresses the web tools may connect to. */
	readonly webAddressAllowed: ((address: string) => boolean) | undefined;
	/** Tests: one-click connectors pointing at fakes. */
	readonly connectorCatalog: readonly CatalogEntry[] | undefined;
	/** The live MCP connection of each instance, filled as its tools are assembled. */
	readonly connections: Map<string, McpConnections>;
	readonly mcpOAuth: () => McpOAuth;
	readonly connectorStore: (instance: string) => ConnectorStore;
	readonly proposeConnectorAction: (instance: string, input: Parameters<NonNullable<McpConnectionsOptions["actions"]>["propose"]>[0]) => Promise<string>;
	readonly policyOf: (record: InstanceRecord) => () => Promise<InstanceRecord["egress"]>;
	readonly segreteriaId: string | undefined;
	readonly board: BoardStore;
	readonly boardWork: BoardWork;
	readonly webChannels: ReadonlyMap<string, WebChannel>;
	readonly agentChannels: ReadonlyMap<string, AgentChannel>;
	readonly agentRatesOf: (id: string) => { readonly rate: AgentRate; readonly total: AgentRate };
	readonly company: (self: InstanceRecord) => Promise<{ accepts: boolean; colleague: { id: string; name: string; tagline?: string; place?: string } }[]>;
	readonly liveActivity: (tenantId: string) => ReturnType<typeof runtimeActivity>;
	readonly googleTools: (record: InstanceRecord) => readonly OwniTool[];
	readonly watchReader: (instance: string) => (url: string) => Promise<{ title: string; text: string }>;
	readonly notifyWebAction: (instance: string, action: WebAction) => Promise<void>;
	readonly notifyApprovers: (instance: string, proposal: ToolProposal) => Promise<void>;
	readonly chromium: () => Promise<Browser | undefined>;
	readonly browseSessions: BrowseSessions;
	readonly computer: ComputerProvider | undefined;
	readonly desktop: DesktopProvider | undefined;
	readonly screens: ScreenViews;
	// The services the operator turned on, and their daily counts.
	readonly transcribePiece: ReturnType<typeof pieceTranscriber> | undefined;
	readonly recordingSeconds: ReturnType<typeof dailyCounter>;
	readonly speak: ReturnType<typeof speaker> | undefined;
	readonly voicePrefsOf: (instance: string) => VoicePreferences;
	readonly speaksNow: (instance: string) => Promise<boolean>;
	readonly search: ReturnType<typeof braveSearch> | undefined;
	readonly searchesLeft: ReturnType<typeof dailyLimit>;
	readonly weather: ReturnType<typeof openMeteo> | undefined;
	readonly weatherLeft: ReturnType<typeof dailyCounter>;
	readonly weatherTries: ReturnType<typeof dailyLimit>;
	readonly exchangeRates: ReturnType<typeof ecbRates> | undefined;
	readonly news: ReturnType<typeof feedNews> | undefined;
	readonly vies: ReturnType<typeof viesClient> | undefined;
	readonly vatChecksLeft: ReturnType<typeof dailyLimit>;
	readonly generateImage: ReturnType<typeof imageGenerator> | undefined;
	readonly imagesLeft: ReturnType<typeof dailyCounter>;
};

/** The tools of one agente: its workspace, the services this server has, the connectors it is signed in to. */
export async function assembleTools(w: ToolsWiring, record: InstanceRecord): Promise<ToolSet> {
	const { runtime, config, log } = w;
	// What every tool of this agente shares.
	const workspace = runtime.workspace(record.tenantId, record.id);
	const policy = w.policyOf(record);
	const whoIs = (thread: { channel: string; threadId: string }) => runtime.participant(record.tenantId, record.id, thread);
	const sendFile = (f: Parameters<OwniRuntime["sendFile"]>[2]) => runtime.sendFile(record.tenantId, record.id, f);
	/** An audit line of this agente for what a tool did, with the tool's own `source` when it has one. */
	const audit =
		<E extends AuditEvent>(source?: string) =>
		async (event: E): Promise<void> => {
			await runtime.audit(record.tenantId).append({ ...event, instanceId: record.id, ...(source === undefined ? {} : { source }) });
		};
	/** The search service as this agente's tools use it: the tenant's daily count, an audit line per search. */
	const searchFor = () => ({
		run: w.search as NonNullable<typeof w.search>,
		record: async (results: number) => {
			await runtime.audit(record.tenantId).append({ type: "web_search.ran", instanceId: record.id, results });
		},
		allow: () => w.searchesLeft(record.tenantId),
		today: () => new Date().toLocaleString("it-IT", { timeZone: config.timeZone, dateStyle: "full", timeStyle: "short" }),
	});
	const mcp = new McpConnections({
		instanceId: record.id,
		secrets: runtime.secrets(record.tenantId),
		policy,
		audit: runtime.audit(record.tenantId),
		log,
		noStdio: w.config.cell.secret !== undefined,
		oauth: w.mcpOAuth(),
		payments: (w.connectorCatalog ?? CONNECTOR_CATALOG).filter((e) => e.category === "pagamenti").map((e) => e.url),
		actions: { propose: (input) => w.proposeConnectorAction(record.id, input) },
	});
	w.connections.set(record.id, mcp);
	// The brief's thread: read-only tools only, and vat_check on paper (its numbers would come from mail).
	const briefs = runtime.schedules(record.tenantId, record.id);
	const isBriefThread = async (thread: { channel: string; threadId: string }) => thread.channel === "web" && (await briefs.list()).some((s) => s.kind === "brief" && s.threadId === thread.threadId);
	const tools = [
		...createWorkspaceTools({ workspace, sendFile }),
		...createDocumentTools({ workspace }),
		...createChartTools({ workspace, sendFile }),
		...createArtifactTools({
			artifacts: () => {
				const channel = w.webChannels.get(record.id);
				return channel === undefined
					? undefined
					: {
							create: (threadId, input) => channel.artifacts.create(threadId, input),
							update: (threadId, id, input) => channel.artifacts.update(threadId, id, input),
							show: (threadId, artifact, key) => channel.sendArtifact(threadId, artifact, key),
						};
			},
		}),
		...createOpenuiTools(),
		...createCodeTools({ workspace }),
		...createDateTools({ timeZone: config.timeZone }),
		...(w.transcribePiece === undefined || config.transcription === undefined
			? []
			: createRecordingTools({
					workspace,
					transcribe: async (piece, opts) => {
						if (!((await runtime.registry.getInstance(record.tenantId, record.id)).egress.connectors ?? []).includes(VOICE_CONNECTOR)) throw new TranscriptionNotAllowed();
						return (w.transcribePiece as NonNullable<typeof w.transcribePiece>)(piece, opts);
					},
					abilities: { timestamps: config.transcription.timestamps !== "none", speakers: config.transcription.speakers },
					maxMinutes: config.transcription.maxMinutes,
					budget: { left: () => w.recordingSeconds.left(record.tenantId), spend: (seconds) => w.recordingSeconds.spend(record.tenantId, seconds) },
					record: audit(),
				})),
		...createScheduleTools({ store: runtime.schedules(record.tenantId, record.id), defaultTimeZone: config.timeZone }),
		...createAutomationTools({
			store: runtime.automations(record.tenantId, record.id),
			instance: record.id,
			whoIs,
			...(config.web.publicUrl === undefined ? {} : { baseUrl: config.web.publicUrl }),
			tell: (thread, text, key) => runtime.sendMessage(record.tenantId, record.id, { ...thread, text, key, secret: true }),
			record: audit("owni"),
		}),
		...createWatchTools({
			store: runtime.watches(record.tenantId, record.id),
			read: w.watchReader(record.id),
			record: audit(),
		}),
		...(w.speak === undefined
			? []
			: createVoiceTools({
					get: (key) => w.voicePrefsOf(record.id).get(key),
					set: (key, mode) => w.voicePrefsOf(record.id).set(key, mode),
					whoIs,
					on: () => w.speaksNow(record.id),
				})),
		...createListTools({
			store: runtime.lists(record.tenantId, record.id),
			whoIs,
			record: audit("owni"),
		}),
		...createBoardTools({
			self: record.id,
			store: w.board,
			work: w.boardWork,
			agents: async () => (await runtime.registry.listInstances(record.tenantId)).filter((r) => r.id !== w.segreteriaId).map((r) => ({ id: r.id, name: r.name })),
			personOf: (thread) => (thread.channel === "web" ? WebChannel.ownerOf(thread.threadId) : undefined),
		}),
		...createAgentTools({
			self: record.id,
			...w.agentRatesOf(record.id),
			activity: (agent, thread) => w.liveActivity(record.tenantId)(agent, viewerOf(record.id, thread, WebChannel.ownerOf)),
			colleagues: async () => (await w.company(record)).filter((c) => c.accepts).map((c) => c.colleague),
			company: async () => (await w.company(record)).filter((c) => !c.accepts && c.colleague.place !== undefined).map((c) => c.colleague),
			post: async ({ to, origin, text, key }) => {
				const channel = w.agentChannels.get(to);
				if (channel === undefined) throw new Error("non è attivo");
				const me = await runtime.registry.getInstance(record.tenantId, record.id);
				// Who asked and in which words, by this message's id: the card of a step that needs a yes shows it (ADR 0108).
				// Kept before the message goes (its turn may need it at once), taken back if it is not taken.
				const asks = runtime.agentAsks(record.tenantId, to);
				asks.record(agentThreadId(me.id, origin), key, { id: me.id, name: me.name }, text);
				await channel.ask({ from: { id: me.id, name: me.name }, origin, text, messageId: key }).catch((error: unknown) => {
					asks.forget(key);
					// Its owner took the permission back since agent_list: say it plainly, the audit has the details.
					throw error instanceof UserNotAllowed || error instanceof EgressDenied ? new Error("non accetta più messaggi da te") : error;
				});
			},
			record: audit(),
		}),
		...createMemoryTools({
			store: runtime.memory(record.tenantId, record.id),
			whoIs,
			record: audit("owni"),
		}),
		...createSkillTools({
			store: runtime.skills(record.tenantId, record.id),
			workspace,
			whoIs,
			record: audit("owni"),
		}),
		...w.googleTools(record),
		...createWebTools({
			desktop: w.desktop !== undefined && (record.egress.connectors ?? []).includes(desktopConnector(w.desktop)),
			policy,
			workspace,
			chromium: w.chromium,
			sessions: w.browseSessions,
			scope: `${record.tenantId}/${record.id}`,
			...(w.webAddressAllowed === undefined ? {} : { addressAllowed: w.webAddressAllowed }),
			...(w.search === undefined ? {} : { search: searchFor() }),
			recordDownload: async (file) => {
				await runtime.audit(record.tenantId).append({ type: "web.download", instanceId: record.id, path: file.path, bytes: file.bytes });
			},
			actions: {
				store: runtime.webActions(record.tenantId, record.id),
				requester: whoIs,
				askedBy: (thread, inputs) => askedByIn(runtime.agentAsks(record.tenantId, record.id), thread, inputs),
				onProposed: (action) => w.notifyWebAction(record.id, action),
			},
		}),
		...(w.search === undefined
			? []
			: createResearchTools({
					policy,
					workspace,
					search: searchFor(),
					sendFile,
					record: audit(),
					...(w.webAddressAllowed === undefined ? {} : { addressAllowed: w.webAddressAllowed }),
				})),
		...(w.weather === undefined
			? []
			: createWeatherTools({
					weather: w.weather,
					left: () => w.weatherLeft.left(record.tenantId),
					attempt: () => w.weatherTries(record.tenantId),
					spend: () => w.weatherLeft.spend(record.tenantId, 1),
					record: async (days) => {
						await runtime.audit(record.tenantId).append({ type: "weather.ran", instanceId: record.id, days });
					},
				})),
		...(w.exchangeRates === undefined ? [] : createExchangeTools({ rates: w.exchangeRates })),
		...(w.news === undefined ? [] : createNewsTools({ news: w.news, timeZone: config.timeZone })),
		// Always offered: without the VIES it checks on paper, which needs nothing from outside.
		...createVatTools({ ...(w.vies === undefined ? {} : { vies: w.vies }), tenant: record.tenantId, allow: () => w.vatChecksLeft(record.tenantId), offlineIn: isBriefThread, timeZone: config.timeZone }),
		...(w.generateImage === undefined
			? []
			: createImageTools({
					policy,
					workspace,
					generate: w.generateImage,
					left: () => w.imagesLeft.left(record.tenantId),
					spend: (n) => w.imagesLeft.spend(record.tenantId, n),
					sendFile,
					record: audit(),
				})),
		...(w.computer === undefined
			? []
			: createComputerTools({
					computer: w.computer,
					key: computerKey(record.tenantId, record.id),
					policy,
					workspace,
					record: audit(),
					log,
				})),
		// Offered only where the owner turned the screen on (the switch reopens the agente).
		...(w.desktop === undefined || !(record.egress.connectors ?? []).includes(desktopConnector(w.desktop))
			? []
			: createDesktopTools({
					desktop: w.desktop,
					key: computerKey(record.tenantId, record.id),
					policy,
					// Only the console's conversations: nobody watches the others there.
					seen: (thread, png, action, askedAt) => {
						if (thread.channel === "web") w.screens.set(record.id, thread, png, action, askedAt);
					},
					record: audit(),
					log,
				})),
		...(await createCustomTools({
			store: runtime.proposals(record.tenantId, record.id),
			toolsDir: runtime.customToolsDir(record.tenantId, record.id),
			policy,
			onProposed: (proposal) => w.notifyApprovers(record.id, proposal),
		})),
		// Connector tools reach the model only once it loads them with tool_search (ADR 0122).
		// The not-connected placeholder stays in sight, so the model can say a sign-in is needed.
		...(await mcp.connect(await w.connectorStore(record.id).list())).map((tool): OwniTool => (tool.name.endsWith("__non_collegato") ? tool : { ...tool, deferred: true })),
	];
	return { tools: readOnlyInBriefs(tools, isBriefThread), close: () => mcp.close() };
}
