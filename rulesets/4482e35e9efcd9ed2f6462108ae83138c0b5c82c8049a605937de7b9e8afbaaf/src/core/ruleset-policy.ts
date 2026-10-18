import type { CoreState, FactDraftV2 } from "./types"

/**
 * The historical application-selected rulebook.  It remains the only fallback before a kingdom
 * records an explicit policy; changing application source must never move this seam.
 */
export const LEGACY_PROTOCOL_V2_RULESET_HASH =
  "63f749598c2b074b7987bf1e3a510ee8af1346b5e4f2bca6430f2213c6c01c26" as const

/** Absent at genesis by design.  Governance records it with DIAL_SET. */
export const PROTOCOL_V2_ACTIVE_RULESET = "PROTOCOL_V2_ACTIVE_RULESET" as const

/** The verifier/writer contract for prospective ruleset selection. */
export const PROTOCOL_V2_RULESET_AUTHORIZATION_PROFILE =
  "systema.protocol-v2-ruleset-authorization.v1" as const

export type ProtocolV2RulesetSelection = {
  rulesetHash: string
  source: "legacy-fallback" | "recorded-dial"
}

export interface ProtocolV2RulesetAuthorizationEvidence {
  profile: typeof PROTOCOL_V2_RULESET_AUTHORIZATION_PROFILE
  legacyFallback: typeof LEGACY_PROTOCOL_V2_RULESET_HASH
  /** Historical decisions before the first policy event named code but were not selected by law. */
  legacyUnboundDecisions: number
  firstPolicySeq: number | null
  active: ProtocolV2RulesetSelection
}

const HASH = /^[0-9a-f]{64}$/
const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)

export function protocolV2RulesetSelection(
  state: Pick<CoreState, "dials">,
): ProtocolV2RulesetSelection {
  const recorded = state.dials[PROTOCOL_V2_ACTIVE_RULESET]
  if (recorded === undefined) {
    return { rulesetHash: LEGACY_PROTOCOL_V2_RULESET_HASH, source: "legacy-fallback" }
  }
  if (typeof recorded !== "string" || !HASH.test(recorded)) {
    throw new Error(`dial ${PROTOCOL_V2_ACTIVE_RULESET} must be a lowercase sha256 ruleset hash`)
  }
  return { rulesetHash: recorded, source: "recorded-dial" }
}

/** The policy must be a governance fact, may not point at malformed bytes, and must actually move. */
export function protocolV2RulesetDialError(
  state: Pick<CoreState, "dials" | "keys">,
  actor: string,
  value: unknown,
): string | null {
  if (actor !== state.keys.governance) return `${PROTOCOL_V2_ACTIVE_RULESET} requires the governance key`
  if (typeof value !== "string" || !HASH.test(value)) {
    return `${PROTOCOL_V2_ACTIVE_RULESET} must be a lowercase sha256 ruleset hash`
  }
  const active = protocolV2RulesetSelection(state)
  if (value === active.rulesetHash) {
    return `${PROTOCOL_V2_ACTIVE_RULESET} already selects ${value}`
  }
  return null
}

/**
 * Scheduled amendment activation and source selection are deliberately separate mechanisms.  An
 * amendment's activation sequence would otherwise make it ambiguous which artifact decides the
 * activation-sequence command.  Ruleset changes take effect immediately after their own DIAL_SET.
 */
export function protocolV2RulesetAmendmentError(dials: unknown): string | null {
  if (!dials || typeof dials !== "object" || Array.isArray(dials)) return null
  return hasOwn(dials, PROTOCOL_V2_ACTIVE_RULESET)
    ? `${PROTOCOL_V2_ACTIVE_RULESET} may be changed only by its own DIAL_SET event`
    : null
}

/** No genesis or migration snapshot may silently confer the authority reserved to a policy fact. */
export function assertNoGenesisProtocolV2Ruleset(dials: unknown): void {
  if (!dials || typeof dials !== "object" || Array.isArray(dials)) return
  if (hasOwn(dials, PROTOCOL_V2_ACTIVE_RULESET)) {
    throw new Error(`${PROTOCOL_V2_ACTIVE_RULESET} must be recorded by DIAL_SET, not GENESIS`)
  }
}

export function isProtocolV2RulesetFact(
  fact: Pick<FactDraftV2, "kind" | "payload">,
): boolean {
  return fact.kind === "DIAL_SET" && fact.payload.key === PROTOCOL_V2_ACTIVE_RULESET
}

/**
 * Outer protocol guard for facts decided by pre-policy retained code, which could not yet know the
 * reserved key.  Current and future retained reducers enforce the same rule internally.
 */
export function protocolV2RulesetFactError(
  state: Pick<CoreState, "dials" | "keys">,
  fact: Pick<FactDraftV2, "kind" | "actor" | "payload">,
  commandActor?: string,
): string | null {
  if (fact.kind === "AMENDMENT_RATIFIED") {
    return protocolV2RulesetAmendmentError(fact.payload.dials)
  }
  if (!isProtocolV2RulesetFact(fact)) return null
  if (commandActor !== undefined && commandActor !== state.keys.governance) {
    return `${PROTOCOL_V2_ACTIVE_RULESET} command requires the governance key`
  }
  return protocolV2RulesetDialError(state, fact.actor, fact.payload.value)
}

export function protocolV2RulesetTarget(
  fact: Pick<FactDraftV2, "kind" | "payload">,
): string | null {
  return isProtocolV2RulesetFact(fact) && typeof fact.payload.value === "string"
    ? fact.payload.value
    : null
}
