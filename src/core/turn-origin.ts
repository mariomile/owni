/**
 * Where a turn comes from (ADR 0088): a person's own message (`person`), a notice from the
 * instance's own work (`notice`: an action's outcome), something that fires by itself
 * (`scheduled`: a task programmato, a sentinella, an automazione, the board), or another agente
 * (`agent`: agent_message, a stanza where an agente called it). Given at admission, stored with
 * the turn's input in the durable engine (a rerun or a recovery keeps it), and read by the tools
 * as `ctx.origin`.
 */
export const TURN_ORIGINS = ["person", "notice", "scheduled", "agent"] as const;
export type TurnOrigin = (typeof TURN_ORIGINS)[number];

export const isTurnOrigin = (v: unknown): v is TurnOrigin => typeof v === "string" && (TURN_ORIGINS as readonly string[]).includes(v);
