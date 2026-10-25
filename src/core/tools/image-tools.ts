import type { OwniTool } from "../engine.ts";
import { IMAGE_CONNECTOR, IMAGE_QUALITIES, IMAGE_SHAPES, type GenerateImage, ImageGenerationError, type ImageQuality, type ImageShape } from "../image-generation.ts";
import { imageProblem, imageType } from "../images.ts";
import type { EgressPolicy } from "../policy.ts";
import { type Workspace, WorkspaceError } from "../workspace.ts";
import { slugify } from "./research-tools.ts";

export type ImageToolsOptions = {
	readonly policy: () => Promise<EgressPolicy>;
	readonly workspace: Workspace;
	readonly generate: GenerateImage;
	/** Pictures the account may still have today; spent only for pictures made. */
	readonly left: () => number;
	readonly spend: (n: number) => void;
	/** Send a workspace file to a thread (through the outbox). */
	readonly sendFile: (file: { channel: string; threadId: string; path: string; caption?: string; key: string }) => Promise<void>;
	/** One line in the audit: how many pictures, whether a picture was changed; never the request. */
	readonly record: (event: { type: "image.generated"; changed: boolean; count: number }) => Promise<void>;
};

const EXTENSION: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/**
 * Pictures on request (ADR 0023): new ones from a description, or a picture of the workspace
 * changed (a photo someone sent). They are saved in `immagini/` and sent to the conversation;
 * the model is told where they are, not shown them.
 */
export function createImageTools(options: ImageToolsOptions): OwniTool[] {
	return [
		{
			name: "image_generate",
			description:
				"Make a picture from a description (an illustration, a logo, a poster, a photo-like scene) or retouch a picture of your workspace (from: a photo someone sent, in uploads/, or a picture you made). " +
				"The picture is saved in your workspace and sent to the person with caption; do not describe it afterwards. " +
				"Write the prompt in English, detailed: subject, style, colors, light, composition; any text to show goes in quotes exactly as the person wrote it, in their language. " +
				"When the person asks to change a picture you made (\"più blu\", \"togli la scritta\"), use from with its path and say only what changes. " +
				"Not for pictures of real people who did not ask for it, or to fake documents.",
			parameters: {
				type: "object",
				properties: {
					prompt: { type: "string", minLength: 3, maxLength: 4000 },
					from: { type: "string", minLength: 1, maxLength: 300, description: "To retouch a picture: its path in the workspace (JPEG, PNG or WebP)" },
					shape: { type: "string", enum: [...IMAGE_SHAPES], description: "square, portrait (tall) or landscape (wide). Leave it out to retouch a picture keeping its proportions; square for a new one" },
					count: { type: "integer", minimum: 1, maximum: 4, description: "Variations to choose from, when the person asks for some (each counts in the day's pictures)" },
					transparent: { type: "boolean", description: "No background (a PNG): for logos, icons, stickers" },
					quality: { type: "string", enum: [...IMAGE_QUALITIES], description: "low for a quick draft; high for something to print. Leave it out otherwise" },
					caption: { type: "string", maxLength: 200, description: "One short line sent with the picture, in the person's language" },
				},
				required: ["prompt"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				const policy = await options.policy();
				if (!(policy.connectors ?? []).includes(IMAGE_CONNECTOR)) return "Errore: la generazione di immagini non è attiva per questa istanza. La accende l'owner in Impostazioni, «Immagini».";
				const prompt = String(args.prompt).trim();
				const count = typeof args.count === "number" ? Math.min(4, Math.max(1, Math.floor(args.count))) : 1;
				let from: { data: Uint8Array; name: string } | undefined;
				if (typeof args.from === "string") {
					try {
						const data = await options.workspace.read(args.from);
						const problem = imageProblem(data);
						if (problem !== undefined) return `Errore: ${args.from} ${problem}.`;
						if (EXTENSION[imageType(data) ?? ""] === undefined) return `Errore: ${args.from} è una GIF: si possono ritoccare solo JPEG, PNG e WebP.`;
						from = { data, name: args.from.split("/").at(-1) ?? "immagine" };
					} catch (error) {
						if (error instanceof WorkspaceError) return `Errore: ${error.message}`;
						throw error;
					}
				}
				// Made and saved in one step: a rerun after the step is stored finds the pictures, not new ones.
				// A crash while the service works asks again (at-least-once, ADR 0023).
				const made = await ctx.step("generate", async (): Promise<{ paths: string[] } | { error: string }> => {
					const left = options.left();
					if (left < count) return { error: left === 0 ? "per oggi le immagini di questo account sono finite. Dillo alla persona: si può riprovare domani." : `per oggi restano ${left} immagini a questo account: chiedine al massimo ${left}.` };
					try {
						const pictures = await options.generate(prompt, {
							...(IMAGE_SHAPES.includes(args.shape as ImageShape) ? { shape: args.shape as ImageShape } : {}),
							...(from === undefined ? {} : { from }),
							count,
							...(args.transparent === true ? { transparent: true } : {}),
							...(IMAGE_QUALITIES.includes(args.quality as ImageQuality) ? { quality: args.quality as ImageQuality } : {}),
							signal: ctx.signal,
						});
						// Only pictures made count in the day's pictures; a refusal or a timeout does not.
						options.spend(pictures.length);
						const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
						const name = slugify(prompt).slice(0, 40).replace(/-+$/, "") || "immagine";
						const paths: string[] = [];
						for (const [i, data] of pictures.entries()) {
							const path = `immagini/${name}-${stamp}${pictures.length > 1 ? `-${i + 1}` : ""}.${EXTENSION[imageType(data) ?? ""] ?? "png"}`;
							await options.workspace.write(path, data);
							paths.push(path);
						}
						await options.record({ type: "image.generated", changed: from !== undefined, count: pictures.length });
						return { paths };
					} catch (error) {
						if (error instanceof ImageGenerationError || error instanceof WorkspaceError) return { error: error.message };
						throw error;
					}
				});
				if ("error" in made) return `Errore: ${made.error}`;
				const where = made.paths.join(", ");
				const thread = ctx.thread;
				if (thread === undefined) return `${made.paths.length === 1 ? "Immagine creata" : "Immagini create"}: ${where}. Nessuna conversazione a cui inviarle: si mandano con file_send.`;
				const caption = typeof args.caption === "string" && args.caption.trim() !== "" ? args.caption.trim() : undefined;
				try {
					for (const [i, path] of made.paths.entries()) {
						await ctx.step(`send-${i}`, async () => {
							const label = made.paths.length > 1 ? `${i + 1}/${made.paths.length}` : undefined;
							const text = [caption, label].filter(Boolean).join(" ");
							await options.sendFile({ channel: thread.channel, threadId: thread.threadId, path, ...(text === "" ? {} : { caption: text }), key: `${ctx.callId}:${i}` });
							return true;
						});
					}
				} catch (error) {
					return `Creata in ${where}, ma non sono riuscita a inviarla (${error instanceof Error ? error.message : String(error)}). Dillo alla persona: su WhatsApp, dopo 24 ore di silenzio, deve scriverti prima; nella console la trova tra i file.`;
				}
				return `${made.paths.length === 1 ? "Immagine creata e inviata" : `${made.paths.length} immagini create e inviate`} in questa conversazione: ${where}. ${caption === undefined ? "Rispondi con una riga al massimo." : "Non serve altro testo."} Per ritoccarla usa from con il suo percorso; per controllarla, image_view.`;
			},
		},
	];
}
