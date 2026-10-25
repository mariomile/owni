import type { ModelSelection } from "./registry.ts";

export type ModelRoles = {
	readonly extract: ModelSelection;
	readonly draft: ModelSelection;
	readonly classify?: ModelSelection;
	readonly fallback?: ModelSelection;
};

export const DEFAULT_MODEL_ROLES: ModelRoles = {
	extract: { provider: "anthropic", modelId: "claude-haiku-5-5" },
	draft: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
	classify: { provider: "anthropic", modelId: "claude-haiku-5-5" },
	fallback: { provider: "openai", modelId: "gpt-5-mini" },
};

/** Test / offline roles use the local faux model. */
export const FAUX_MODEL_ROLES: ModelRoles = {
	extract: { provider: "faux", modelId: "owni-dev" },
	draft: { provider: "faux", modelId: "owni-dev" },
	classify: { provider: "faux", modelId: "owni-dev" },
};

export function roleModel(roles: ModelRoles, role: keyof ModelRoles): ModelSelection {
	return roles[role] ?? roles.extract;
}
