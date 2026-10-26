import type { IncomingMessage, ServerResponse } from "node:http";
import type { Person } from "./auth.ts";

/** An answer other than 200: its status, its message, and fields the console reads. */
export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly extra: Record<string, unknown> = {},
	) {
		super(message);
	}
}

export type Auth = "none" | "person" | "owner";

/** One string per `:name` of a path: "/a/:id/b/:cid" gives [string, string]. */
export type Params<P extends string> = string extends P
	? string[]
	: P extends `${string}:${string}/${infer Rest}`
		? [string, ...Params<Rest>]
		: P extends `${string}:${string}`
			? [string]
			: [];

/** What a handler is given; the person is there for every route that asks for one. */
export type Ctx<A extends Auth = Auth, P extends string = string> = {
	readonly req: IncomingMessage;
	readonly res: ServerResponse;
	readonly url: URL;
	readonly params: Params<P>;
	readonly person: A extends "none" ? Person | undefined : Person;
};

export type Handler = (ctx: Ctx) => Promise<unknown>;
export type Route = { method: string; pattern: RegExp; auth: Auth; handler: Handler };
/** How a group of routes is added to the console's server. */
export type AddRoute = <A extends Auth, P extends string>(method: string, path: P, auth: A, handler: (ctx: Ctx<A, P>) => Promise<unknown>) => void;

export const MAX_JSON = 1024 * 1024;

/** What a handler gives back when it wrote the answer itself (a picture, a stream). */
export const STREAMED = Symbol("streamed");

/** The pattern of a path: each `:name` is one segment. */
export const pathPattern = (path: string): RegExp => new RegExp(`^${path.replace(/:[a-z]+/g, "([^/]+)")}$`);

export function send(res: ServerResponse, status: number, body: unknown): void {
	const data = Buffer.from(JSON.stringify(body));
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": data.length, "cache-control": "no-store" });
	res.end(data);
}

export async function readBody(req: IncomingMessage, max: number, tooBig = `Troppo grande: oltre ${max} byte`): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > max) throw new HttpError(413, tooBig);
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

export async function readJson(req: IncomingMessage, max = MAX_JSON, tooBig?: string): Promise<Record<string, unknown>> {
	const data = await readBody(req, max, tooBig);
	if (data.length === 0) return {};
	try {
		const value: unknown = JSON.parse(data.toString("utf8"));
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
		return value as Record<string, unknown>;
	} catch {
		throw new HttpError(400, "JSON non valido");
	}
}
