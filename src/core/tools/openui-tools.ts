import { Type } from "@earendil-works/pi-ai";
import { defineOwniTool, type OwniTool } from "../engine.ts";
import { OPENUI_GUIDE } from "../openui-guide.ts";

/**
 * Interactive answers (ADR 0118): in a console conversation a reply may carry one ```openui-lang
 * block, drawn there as a live interface. The language is long, so the agente reads it when it needs it.
 */
export function createOpenuiTools(): OwniTool[] {
	return [
		defineOwniTool({
			name: "openui_guide",
			description:
				"Read before answering with an interactive interface in a console conversation: a ```openui-lang block in your reply, drawn there as cards, a table, a chart, buttons to choose or a short form whose submit writes the person's next message in their box. " +
				"Use it when figures, a choice or a request to fill in read better as an interface than as text; never for plain answers. Not for a standalone page to keep open: that is an artifact. Only in the console: elsewhere the block would show as code.",
			parameters: Type.Object({}, { additionalProperties: false }),
			replaySafe: true,
			execute: async (_args, ctx) =>
				ctx.thread?.channel !== "web" ? "Errore: le risposte interattive si vedono solo nella console. Qui rispondi con il testo." : OPENUI_GUIDE,
		}),
	];
}
