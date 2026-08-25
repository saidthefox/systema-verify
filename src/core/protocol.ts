import type { EventEnvelope, EventDraft, LegacyCommandEnvelope } from "./types"

/** Existing records omit `protocol`; omission is permanently defined as protocol v1. */
export const LEGACY_PROTOCOL_VERSION = 1 as const
export const NEXT_PROTOCOL_VERSION = 2 as const

type PossiblyVersioned = Pick<EventEnvelope, "kind"> & { protocol?: unknown }

export function protocolVersionOf(record: PossiblyVersioned): number {
  return typeof record.protocol === "number" ? record.protocol : LEGACY_PROTOCOL_VERSION
}

/**
 * The historical v1 identity rule: an accepted command becomes the same kind, payload and
 * actor-supplied signature. V2 must not use this helper; its decision maps intent to facts.
 */
export function legacyEventDraft(command: LegacyCommandEnvelope): EventDraft {
  return {
    kind: command.kind,
    v: command.v,
    actor: command.actor,
    payload: command.payload,
    sig: command.sig,
  }
}
