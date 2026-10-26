import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { attachmentNote } from "../core/attachment-note.ts";
import { documentKind, documentLabel } from "../core/documents.ts";
import { recordingLabel } from "../core/recordings.ts";
import type { InstanceRecord } from "../core/registry.ts";
import type { OwniRuntime } from "../core/runtime.ts";
import { WorkspaceError } from "../core/workspace.ts";
import { imageType } from "../core/images.ts";
import type { Person } from "./auth.ts";
import type { WebChannel, WebThread } from "./channel.ts";
import { type AddRoute, HttpError, readBody, STREAMED } from "./http.ts";
import type { Room } from "./rooms.ts";
import type { WebAppOptions } from "./server.ts";

const MAX_UPLOAD = 20 * 1024 * 1024;

export type FilesRoutesDeps = Pick<WebAppOptions, "rooms"> & {
	readonly runtime: OwniRuntime;
	readonly tenantId: string;
	readonly instanceAccess: (person: Person, instanceId: string) => Promise<{ readonly record: InstanceRecord; readonly member: boolean }>;
	readonly channelOf: (instanceId: string) => WebChannel;
	readonly ownThread: (person: Person, instanceId: string, threadId: string) => Promise<InstanceRecord>;
};

/** An agente's files, and its HTML pages (artifacts) to the person of the conversation. */
export function filesRoutes(route: AddRoute, options: FilesRoutesDeps): void {
	const { runtime, tenantId, instanceAccess, channelOf, ownThread } = options;
	// --- files ---
	route("GET", "/api/instances/:id/files", "person", async ({ person, params }) => {
		await instanceAccess(person, params[0]);
		return { files: await runtime.workspace(tenantId, params[0]).list() };
	});
	route("GET", "/api/instances/:id/files/raw", "person", async ({ person, params, url, res }) => {
		await instanceAccess(person, params[0]);
		const path = url.searchParams.get("path") ?? "";
		const data = await workspaceCall(() => runtime.workspace(tenantId, params[0]).read(path));
		const name = path.split("/").at(-1) ?? "file";
		// A picture can be shown in the page (thumbnails in the chat): only one whose bytes are a JPEG, PNG, GIF or WebP, never SVG.
		const picture = url.searchParams.get("inline") === "1" ? imageType(data) : undefined;
		// An HTML file can be opened in the page, sandboxed like an artifact (ADR 0112).
		if (url.searchParams.get("view") === "1" && /\.html?$/i.test(name)) return sandboxedHtml(res, data);
		if (picture !== undefined) {
			res.writeHead(200, { "content-type": picture, "content-length": data.length, "content-disposition": "inline", "x-content-type-options": "nosniff", "cache-control": "no-store" });
			res.end(data);
			return STREAMED;
		}
		res.writeHead(200, {
			"content-type": "application/octet-stream",
			"content-length": data.length,
			"content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
			"cache-control": "no-store",
		});
		res.end(data);
		return STREAMED;
	});
	// --- artifacts (ADR 0112): an agente's HTML pages, only to the person of the conversation ---
	// The person's pages made by one agente, newest first, with where each was made (ADR 0114).
	route("GET", "/api/instances/:id/artifacts", "person", async ({ person: p, params }) => {
		const instanceId = params[0];
		await instanceAccess(p, instanceId);
		const channel = channelOf(instanceId);
		const rooms = new Map<string, Promise<Room | undefined>>();
		const room = (roomId: string) => {
			if (!rooms.has(roomId)) rooms.set(roomId, options.rooms?.get(p.id, roomId) ?? Promise.resolve(undefined));
			return rooms.get(roomId) as Promise<Room | undefined>;
		};
		const where = async (thread: WebThread) => {
			if (thread.dm === true) return { kind: "dm" };
			if (thread.room === undefined) return { kind: thread.parent === undefined ? "chat" : "thread", title: thread.title };
			const seat = await room(thread.room);
			const top = seat?.parent === undefined ? seat : await room(seat.parent.roomId);
			return { kind: "channel", ...(top === undefined ? {} : { roomId: top.id, title: top.title }), ...(seat?.parent === undefined ? {} : { inThread: true }) };
		};
		const perThread = await Promise.all((await channel.threads(p.id, { seats: true })).map(async (thread) => {
			const metas = await channel.artifacts.all(thread.id);
			if (metas.length === 0) return [];
			const made = await where(thread);
			return metas.flatMap((meta) => {
				const last = meta.versions[meta.versions.length - 1];
				return last === undefined ? [] : [{ id: meta.id, threadId: thread.id, createdAt: meta.createdAt, title: last.title, version: last.version, at: last.at, where: made }];
			});
		}));
		return { artifacts: perThread.flat().sort((a, b) => b.at.localeCompare(a.at)) };
	});
	route("GET", "/api/instances/:id/artifacts/:thread/:artifact", "person", async ({ person, params }) => {
		await ownThread(person, params[0], params[1]);
		const meta = await channelOf(params[0]).artifacts.meta(params[1], params[2]);
		if (meta === undefined) throw new HttpError(404, "No such artifact");
		return { artifact: { id: meta.id, createdAt: meta.createdAt, versions: meta.versions.map(({ key: _key, ...v }) => v) } };
	});
	route("GET", "/api/instances/:id/artifacts/:thread/:artifact/:version", "person", async ({ person, params, url, res }) => {
		await ownThread(person, params[0], params[1]);
		const store = channelOf(params[0]).artifacts;
		const version = Number(params[3]);
		const data = /^[1-9]\d{0,3}$/.test(params[3]) ? await store.read(params[1], params[2], version) : undefined;
		if (data === undefined) throw new HttpError(404, "No such artifact");
		if (url.searchParams.get("download") !== "1") return sandboxedHtml(res, data);
		const title = (await store.meta(params[1], params[2]))?.versions.find((v) => v.version === version)?.title ?? "artifact";
		return sandboxedHtml(res, data, `${title.replace(/[\\/:*?"<>|]+/g, "_")}.html`);
	});
	route("PUT", "/api/instances/:id/files/raw", "person", async ({ person, params, url, req }) => {
		const { member } = await instanceAccess(person, params[0]);
		if (!member && person.role !== "owner") throw new HttpError(403, "Forbidden");
		const name = (url.searchParams.get("name") ?? "file").replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";
		const data = await readBody(req, MAX_UPLOAD);
		const workspace = runtime.workspace(tenantId, params[0]);
		// Never over an earlier upload: messages point at their photos by path (phones call them all image.jpg).
		const taken = (await workspaceCall(() => workspace.stat(`uploads/${name}`))) !== undefined;
		const unique = taken ? name.replace(/(\.[^.]*)?$/, (ext) => `-${randomUUID().slice(0, 8)}${ext}`) : name;
		const file = await workspaceCall(() => workspace.write(`uploads/${unique}`, data));
		await runtime.audit(tenantId).append({ type: "web.upload", instanceId: params[0], personId: person.id, path: file.path, bytes: file.size });
		// The note the console puts in the message: the same words Telegram and WhatsApp files get.
		const kind = documentKind(unique, data);
		const recording = kind === undefined ? recordingLabel(data) : undefined;
		return { file, note: attachmentNote(file.path, data), ...(kind === undefined ? {} : { document: documentLabel(kind) }), ...(recording === undefined ? {} : { recording }) };
	});
	route("DELETE", "/api/instances/:id/files", "person", async ({ person, params, url }) => {
		await instanceAccess(person, params[0]);
		if (person.role !== "owner") throw new HttpError(403, "Solo l'owner può eliminare file da qui");
		await workspaceCall(() => runtime.workspace(tenantId, params[0]).remove(url.searchParams.get("path") ?? ""));
		return { ok: true };
	});
}

/**
 * An HTML page the console shows in a frame (ADR 0112): sandboxed by its own CSP, so it runs with
 * an opaque origin (no session cookie, no calls to Owni), loads nothing but a few CDNs, sends
 * nothing out (no requests, forms or pictures from elsewhere), and is framed only by the console. `download`: sent as a file with this name instead.
 */
const ARTIFACT_CSP =
	"sandbox allow-scripts allow-modals; default-src 'none'; " +
	"script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com; " +
	"style-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://fonts.googleapis.com; " +
	"font-src https://fonts.gstatic.com data:; img-src data: blob: https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com; media-src data: blob:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'";

function sandboxedHtml(res: ServerResponse, data: Buffer, download?: string): typeof STREAMED {
	res.removeHeader("x-frame-options");
	res.writeHead(200, {
		"content-type": "text/html; charset=utf-8",
		"content-length": data.length,
		"content-security-policy": ARTIFACT_CSP,
		"x-content-type-options": "nosniff",
		"cache-control": "private, no-store",
		...(download === undefined ? {} : { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(download)}` }),
	});
	res.end(data);
	return STREAMED;
}

export async function workspaceCall<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof WorkspaceError) throw new HttpError(error.message.startsWith("File not found") ? 404 : 400, error.message);
		throw error;
	}
}

