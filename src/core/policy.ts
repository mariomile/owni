import { EgressDenied, UserNotAllowed } from "./errors.ts";

/**
 * What an instance may talk to. Default deny: an empty list allows nothing.
 * `modelProviders` are pi-ai provider IDs ("anthropic", "openai", ...; "faux" is the
 * local deterministic model). `channels` are channel adapter names ("telegram", ...).
 * `connectors` are external systems the instance's tools reach ("google", ...);
 * missing means none, so policies written before week 4 still deny them.
 */
export type EgressPolicy = {
	readonly modelProviders: readonly string[];
	readonly channels: readonly string[];
	readonly connectors?: readonly string[];
	/**
	 * Sites the instance may read with its web tools: "example.com" (and its subdomains), or "*"
	 * for any public site. Missing or empty: none.
	 */
	readonly web?: readonly string[];
};

export const DENY_ALL: EgressPolicy = { modelProviders: [], channels: [] };

/** The policy with one connector on or off: the same object when it already is. */
export function withConnector(policy: EgressPolicy, connector: string, on: boolean): EgressPolicy {
	const connectors = policy.connectors ?? [];
	if (connectors.includes(connector) === on) return policy;
	return { ...policy, connectors: on ? [...connectors, connector] : connectors.filter((c) => c !== connector) };
}

/** The policy with one channel on or off: the same object when it already is. */
export function withChannel(policy: EgressPolicy, channel: string, on: boolean): EgressPolicy {
	if (policy.channels.includes(channel) === on) return policy;
	return { ...policy, channels: on ? [...policy.channels, channel] : policy.channels.filter((c) => c !== channel) };
}

/**
 * Who may talk to an instance: channel name → channel-native user IDs. Default deny: a
 * channel without an entry, or with an empty list, accepts nobody.
 */
export type AllowedUsers = Readonly<Record<string, readonly string[]>>;

export const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function assertModelProviderAllowed(policy: EgressPolicy, provider: string): void {
	if (!policy.modelProviders.includes(provider)) throw new EgressDenied("model_provider", provider);
}

export function assertChannelAllowed(policy: EgressPolicy, channel: string): void {
	if (!policy.channels.includes(channel)) throw new EgressDenied("channel", channel);
}

export function assertConnectorAllowed(policy: EgressPolicy, connector: string): void {
	if (!(policy.connectors ?? []).includes(connector)) throw new EgressDenied("connector", connector);
}

export function assertUserAllowed(allowed: AllowedUsers, message: { channel: string; userId: string; threadId: string }): void {
	const list = allowed[message.channel];
	if (list === undefined || list.length === 0) throw new UserNotAllowed(message.channel, message.userId, message.threadId, "no_users_allowed_on_channel");
	if (!list.includes(message.userId)) throw new UserNotAllowed(message.channel, message.userId, message.threadId, "user_not_in_allowlist");
}

/** A web host pattern: a domain name ("example.com", subdomains included) or "*". */
export const WEB_HOST_PATTERN = /^(\*|(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/;

export function webHostAllowed(policy: EgressPolicy, host: string): boolean {
	const name = host.toLowerCase().replace(/\.$/, "");
	return (policy.web ?? []).some((pattern) => pattern === "*" || name === pattern || name.endsWith(`.${pattern}`));
}
