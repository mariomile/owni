import { GoogleConsentError, type GoogleOAuth } from "../connectors/google.ts";
import { ConnectorHttpError } from "../connectors/http.ts";
import type { OwniRuntime } from "../core/runtime.ts";
import { publicPerson } from "./auth.ts";
import { type AddRoute, HttpError, readJson } from "./http.ts";
import type { WebAppOptions } from "./server.ts";

export type PeopleRoutesDeps = Pick<WebAppOptions, "people" | "sessions" | "google" | "browser" | "board"> & {
	readonly runtime: OwniRuntime;
	readonly tenantId: string;
};

/** Each person's own Google account, and the people the owner lets in. */
export function peopleRoutes(route: AddRoute, options: PeopleRoutesDeps): void {
	const { runtime, tenantId } = options;
	// --- Google: each person connects their own account; the refresh token never comes back ---
	const googleOf = () => {
		if (options.google === undefined) throw new HttpError(501, "Google non è configurato su questo server");
		return options.google;
	};
	route("GET", "/api/google", "person", async ({ person: p }) => {
		const account = options.google?.accounts.get(p.id);
		return {
			available: options.google !== undefined,
			services: options.google?.services ?? [],
			write: options.google?.write === true,
			account: account === undefined ? null : { ...account, canWrite: options.google?.canWrite?.(p.id) ?? false },
		};
	});
	route("POST", "/api/google/start", "person", async ({ person }) => ({ url: googleOf().oauth.start(person.id) }));
	route("POST", "/api/google/finish", "person", async ({ person: p, req }) => {
		const google = googleOf();
		const body = (await readJson(req)) as { state?: unknown; code?: unknown };
		if (typeof body.state !== "string" || typeof body.code !== "string") throw new HttpError(400, "Collegamento incompleto: riprova");
		let connected: Awaited<ReturnType<GoogleOAuth["finish"]>>;
		try {
			connected = await google.oauth.finish(p.id, body.state, body.code);
		} catch (error) {
			if (error instanceof GoogleConsentError) throw new HttpError(400, error.message);
			if (error instanceof ConnectorHttpError || error instanceof TypeError) throw new HttpError(502, "Google non è raggiungibile da questo server: riprova più tardi.");
			throw error;
		}
		// A previous token of the same person is not revoked: with Google that would end the new grant too.
		await google.accounts.connect(p.id, connected.account, connected.refreshToken);
		google.forget(p.id);
		await runtime.audit(tenantId).append({ type: "google.connected", personId: p.id });
		return { account: connected.account };
	});
	route("DELETE", "/api/google", "person", async ({ person: p }) => {
		const google = googleOf();
		const account = google.accounts.get(p.id);
		const token = await google.accounts.disconnect(p.id);
		google.forget(p.id);
		// Revoking ends the grant for the whole Google account: not while someone else here uses it.
		if (token !== undefined && (account === undefined || !google.accounts.sharedWithOthers(p.id, account.email))) await google.oauth.revoke(token);
		await runtime.audit(tenantId).append({ type: "google.disconnected", personId: p.id });
		return { ok: true };
	});

	// --- people: the owner lets them in, gives a new link, removes them ---
	route("GET", "/api/people", "owner", async () => ({ people: (await options.people.list()).map(publicPerson) }));
	route("POST", "/api/people", "owner", async ({ req, url }) => {
		const body = (await readJson(req)) as { name?: string; role?: string };
		try {
			const { person, token } = await options.people.add(String(body.name ?? ""), body.role === "owner" ? "owner" : "member");
			await runtime.audit(tenantId).append({ type: "person.created", personId: person.id, role: person.role });
			return { person: publicPerson(person), link: loginLink(url, token) };
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
	});
	route("POST", "/api/people/:pid/2fa/reset", "owner", async ({ params }) => {
		await options.people.clearTotp(params[0]).catch(() => {
			throw new HttpError(404, "No such person");
		});
		// Whoever holds the link must log in again, now with the link alone.
		await options.sessions.endAllOf(params[0]);
		await runtime.audit(tenantId).append({ type: "web.2fa_reset", personId: params[0] });
		return { ok: true };
	});
	route("POST", "/api/people/:pid/link", "owner", async ({ params, url }) => {
		const token = await options.people.rotate(params[0]).catch(() => {
			throw new HttpError(404, "No such person");
		});
		await options.sessions.endAllOf(params[0]);
		await runtime.audit(tenantId).append({ type: "person.link_rotated", personId: params[0] });
		return { link: loginLink(url, token) };
	});
	route("DELETE", "/api/people/:pid", "owner", async ({ params, person }) => {
		if (params[0] === person.id) throw new HttpError(400, "Non puoi eliminare te stesso");
		const removed = await options.people.remove(params[0]);
		await options.sessions.endAllOf(params[0]);
		for (const record of await runtime.registry.listInstances(tenantId)) await options.browser?.clearProfile(record.id, params[0]);
		// What they set to come back on the board stops: nobody would work it with them (ADR 0069).
		options.board?.routines?.pausePerson(params[0]);
		await runtime.audit(tenantId).append({ type: "person.removed", personId: params[0] });
		return { removed };
	});
}

/** Relative: the console prefixes its own origin (Owni may sit behind a proxy). */
function loginLink(_url: URL, token: string): string {
	return `/login#${token}`;
}
