import type { ScreenViews } from "../core/screen-views.ts";
import type { Person } from "./auth.ts";
import { type AddRoute, HttpError, STREAMED } from "./http.ts";

export type ScreenRoutesDeps = {
	readonly screens: ScreenViews | undefined;
	/**
	 * Refuses unless the person may see this conversation of the agente: theirs, with an agente they
	 * can open. Says whether the agente has the screen now.
	 */
	readonly thread: (person: Person, instanceId: string, threadId: string) => Promise<boolean>;
};

/**
 * The agente's screen, live next to the chat (ADR 0067): the last picture it took of its screen in
 * this conversation. Only read: the person watches, the agente works.
 */
export function screenRoutes(route: AddRoute, { screens, thread }: ScreenRoutesDeps): void {
	const view = async (person: Person, instanceId: string, threadId: string) => {
		const on = await thread(person, instanceId, threadId);
		return { on, seen: screens?.get(instanceId, "web", threadId) };
	};
	route("GET", "/api/instances/:id/threads/:thread/screen", "person", async ({ person, params }) => {
		const { on, seen } = await view(person, params[0], params[1]);
		// `on`: whether the agente has the screen now; without it the console stops asking.
		return { on, screen: seen === undefined ? null : { version: seen.version, at: seen.at, ...(seen.action === undefined ? {} : { action: seen.action }) } };
	});
	route("GET", "/api/instances/:id/threads/:thread/screen.png", "person", async ({ person, params, res }) => {
		const { seen } = await view(person, params[0], params[1]);
		if (seen === undefined) throw new HttpError(404, "Lo schermo non è ancora stato usato in questa conversazione");
		res.writeHead(200, { "content-type": "image/png", "content-length": seen.png.length, "x-content-type-options": "nosniff", "cache-control": "no-store" });
		res.end(seen.png);
		return STREAMED;
	});
}
