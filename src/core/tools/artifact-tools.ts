import { ARTIFACT_LIMITS, ArtifactError, type ArtifactRef } from "../artifacts.ts";
import type { OwniTool, ToolContext } from "../engine.ts";

/** The pages of the console conversations of one agente. */
export type ArtifactPages = {
	readonly create: (threadId: string, input: { title: string; html: string; key: string }) => Promise<ArtifactRef>;
	readonly update: (threadId: string, id: string, input: { title?: string; html: string; key: string }) => Promise<ArtifactRef>;
	/** Show the version in the conversation, once per key. */
	readonly show: (threadId: string, artifact: ArtifactRef, key: string) => Promise<void>;
};

export type ArtifactToolsOptions = {
	/** undefined when the agente has no console. */
	readonly artifacts: () => ArtifactPages | undefined;
};

const WHEN =
	"An artifact is a self-contained HTML page shown live next to the console conversation, like a document the person keeps open: use it for substantial standalone visual or interactive content (a dashboard, a calculator, a report laid out as a page, a small game, a diagram, a form to try out). " +
	"Not for short answers, explanations, lists or tables that read fine in the chat: write those. " +
	"Write one complete HTML document with its CSS and JavaScript inline. It runs sandboxed: it cannot call Owni or any server (no fetch, no forms, no new windows), and localStorage, sessionStorage and cookies throw; scripts, styles and pictures may come only from cdn.jsdelivr.net, unpkg.com or cdnjs.cloudflare.com, fonts from Google Fonts, otherwise inline or data: URLs. " +
	`At most ${ARTIFACT_LIMITS.maxBytes / 1024} KB. Only in the console: elsewhere make a file with file_write and send it with file_send.`;

/**
 * Artifacts (ADR 0112): an HTML page the agente makes in a console conversation, shown there as a
 * card and opened rendered in a side panel. Each change is the whole page again, a new version.
 */
export function createArtifactTools(options: ArtifactToolsOptions): OwniTool[] {
	/** Save, then show, each once per call also when the call reruns after a crash. */
	const run = async (ctx: ToolContext, save: (store: ArtifactPages, threadId: string) => Promise<ArtifactRef>): Promise<string> => {
		const thread = ctx.thread;
		const store = options.artifacts();
		if (thread === undefined || thread.channel !== "web" || store === undefined) return "Errore: gli artifact si vedono solo nella console. Qui scrivi il file HTML con file_write e mandalo con file_send.";
		const saved = await ctx.step("save", async (): Promise<ArtifactRef | { error: string }> => {
			try {
				return await save(store, thread.threadId);
			} catch (error) {
				if (error instanceof ArtifactError) return { error: error.message };
				throw error;
			}
		});
		if ("error" in saved) return `Errore: non ho salvato l'artifact, ${saved.error}.`;
		await ctx.step("send", async () => {
			await store.show(thread.threadId, saved, ctx.callId);
			return true;
		});
		return `Artifact «${saved.title}» (id ${saved.id}) alla versione ${saved.version}: la persona lo vede accanto alla conversazione. Per cambiarlo usa artifact_update con questo id e la pagina intera. Rispondi con una riga al massimo, senza ripetere il contenuto.`;
	};
	const html = { type: "string", minLength: 1, description: "The whole page: one HTML document with its CSS and JavaScript inline" };
	return [
		{
			name: "artifact_create",
			description: `Make an artifact in this conversation. ${WHEN}`,
			parameters: {
				type: "object",
				properties: { title: { type: "string", minLength: 1, maxLength: ARTIFACT_LIMITS.maxTitle, description: "Short, what the page is, in the person's language" }, html },
				required: ["title", "html"],
				additionalProperties: false,
			},
			replaySafe: true,
			execute: (args, ctx) => run(ctx, (store, threadId) => store.create(threadId, { title: String(args.title), html: String(args.html), key: ctx.callId })),
		},
		{
			name: "artifact_update",
			description: `Change an artifact of this conversation: give its id and the whole new page (not the changed part), which becomes its next version; the earlier ones stay. ${WHEN}`,
			parameters: {
				type: "object",
				properties: { id: { type: "string", pattern: "^a_[0-9a-f]{12}$" }, html, title: { type: "string", minLength: 1, maxLength: ARTIFACT_LIMITS.maxTitle, description: "Only to rename it" } },
				required: ["id", "html"],
				additionalProperties: false,
			},
			replaySafe: true,
			execute: (args, ctx) => run(ctx, (store, threadId) => store.update(threadId, String(args.id), { ...(typeof args.title === "string" ? { title: args.title } : {}), html: String(args.html), key: ctx.callId })),
		},
	];
}
