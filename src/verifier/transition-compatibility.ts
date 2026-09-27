import type { AnyEventEnvelope, CoreState, EventEnvelopeV2, Outcome } from "../core/types"
import { stateHashOf } from "../core/canonical"
import type { FactEvolverV2, ResolvedRulesetV2, RulesetResolverV2 } from "../core/verify"
import { stateFromJson, stateToJson } from "../record/codec"
import type {
  RetainedExecutionResolverV2,
  RetainedExecutionV2,
} from "./ruleset-resolver"

/**
 * One closed historical transition seam.
 *
 * Staging fact 133187 was admitted and proved by the ruleset named in its signed cause, but the
 * writer that made the fact evolved it with the immediately succeeding retained artifact. Four
 * externally witnessed staging states and the rehearsal Forge token descend from that lived
 * state. The owner chose to preserve those testnet commitments instead of retiring them.
 *
 * This is deliberately data, not configuration. It cannot be widened with an environment
 * variable, manifest field, database row, command-line flag, or caller-provided profile. The
 * complete record/event tuple and all three state cuts must agree before the alternate transition
 * can affect a fold. Admission and decision verification always remain with `causeRulesetHash`.
 */
export const STAGING_SMELT_133187_COMPATIBILITY = Object.freeze({
  profile: "systema.transition-compatibility.staging-smelt-133187.v1",
  recordGenesisHash: "8e6464aee7a9f9a0219618e41ac1f95574fe65657d50f3d9aca6d4672787f3c7",
  eventSeq: 133187,
  eventHash: "71574f27d27cfc3c77ae7d1ceb9d098367b414a21b4f81e9f5ec8244f76b2577",
  eventKind: "SMELT",
  claimTo: "0xc812c958308c262db7e3a6480f44bf78d3299a7a",
  causeRulesetHash: "378acbbfde1cea6b86d79fc51252238f33b350cef2f2bd0361b0fe8e7643b767",
  transitionRulesetHash: "294fc9996caa6413b7b0ccbf851fb84203fa62958a143b8b0ca9b518aacad782",
  preStateHash: "329329dd125b8874f474daa73edbf08b2b4e7650df5c07ae170c04c991f65f36",
  strictPostStateHash: "034fa236edc619b62c0f674914eb3e73b9f031e50c673daa405f2e7fb125d6b9",
  livedPostStateHash: "d1be186196dd840f178b6a14147fb3c8a2404486781d6234f8e748ce90897eef",
} as const)

export type TransitionCompatibility = typeof STAGING_SMELT_133187_COMPATIBILITY

/** Stable checkpoint/output name for the complete retained-transition policy. */
export const RETAINED_TRANSITION_SEMANTICS =
  "systema.retained-transition.cause-plus-closed-compatibility.v1" as const

const PROFILE = STAGING_SMELT_133187_COMPATIBILITY

const isV2 = (event: AnyEventEnvelope): event is EventEnvelopeV2 =>
  "protocol" in event && event.protocol === 2

/** Exact public tuple selection. State hashes are checked while applying the selected profile. */
export function isStagingSmelt133187(
  recordGenesisHash: string,
  event: AnyEventEnvelope,
): event is EventEnvelopeV2 {
  return recordGenesisHash === PROFILE.recordGenesisHash &&
    isV2(event) &&
    event.seq === PROFILE.eventSeq &&
    event.hash === PROFILE.eventHash &&
    event.kind === PROFILE.eventKind &&
    event.cause.rulesetHash === PROFILE.causeRulesetHash &&
    event.payload.claimTo === PROFILE.claimTo
}

/** Profiles actually selected by one supplied record, suitable for receipts and public reports. */
export function transitionCompatibilitiesForRecord(
  events: readonly AnyEventEnvelope[],
): TransitionCompatibility[] {
  const genesisHash = events[0]?.hash
  if (genesisHash !== PROFILE.recordGenesisHash) return []
  return events.some(event => isStagingSmelt133187(genesisHash, event)) ? [PROFILE] : []
}

export interface TransitionCompatibilityHashes {
  preStateHash: string
  strictPostStateHash: string
  livedPostStateHash: string
}

/** Pure exhaustive-test seam for the three fail-closed state commitments. */
export function transitionCompatibilityHashError(
  hashes: TransitionCompatibilityHashes,
): string | null {
  if (hashes.preStateHash !== PROFILE.preStateHash) {
    return `transition compatibility ${PROFILE.profile} pre-state hash mismatch: ` +
      `expected ${PROFILE.preStateHash}, got ${hashes.preStateHash}`
  }
  if (hashes.strictPostStateHash !== PROFILE.strictPostStateHash) {
    return `transition compatibility ${PROFILE.profile} strict post-state hash mismatch: ` +
      `expected ${PROFILE.strictPostStateHash}, got ${hashes.strictPostStateHash}`
  }
  if (hashes.livedPostStateHash !== PROFILE.livedPostStateHash) {
    return `transition compatibility ${PROFILE.profile} lived post-state hash mismatch: ` +
      `expected ${PROFILE.livedPostStateHash}, got ${hashes.livedPostStateHash}`
  }
  return null
}

function assertAcceptedTransition(
  label: "strict" | "lived",
  state: CoreState,
  event: EventEnvelopeV2,
  outcome: Outcome,
): void {
  if (!outcome?.accepted) {
    throw new Error(
      `transition compatibility ${PROFILE.profile} ${label} transition refused fact` +
      `${outcome?.reason ? `: ${outcome.reason}` : ""}`,
    )
  }
  if (state.seq !== event.seq || state.ts !== event.ts) {
    throw new Error(
      `transition compatibility ${PROFILE.profile} ${label} transition ended at ` +
      `${state.seq}/${state.ts}; fact requires ${event.seq}/${event.ts}`,
    )
  }
}

/**
 * Keep the cause artifact's transition everywhere except the one exact historical fact. For that
 * fact, prove what strict cause-addressed evolution would have produced before reproducing the
 * lived transition. Both artifacts have already passed the ordinary retained-loader integrity
 * checks before this wrapper is constructed.
 */
function closedCompatibilityEvolver(
  recordGenesisHash: string,
  causeEvolver: FactEvolverV2,
  livedEvolver: FactEvolverV2,
): FactEvolverV2 {
  return (state, event) => {
    if (!isStagingSmelt133187(recordGenesisHash, event)) return causeEvolver(state, event)

    const preStateHash = stateHashOf(state)
    if (preStateHash !== PROFILE.preStateHash) {
      throw new Error(transitionCompatibilityHashError({
        preStateHash,
        strictPostStateHash: PROFILE.strictPostStateHash,
        livedPostStateHash: PROFILE.livedPostStateHash,
      })!)
    }

    const strictState = stateFromJson(stateToJson(state))
    const strictOutcome = causeEvolver(strictState, event)
    assertAcceptedTransition("strict", strictState, event, strictOutcome)
    const strictPostStateHash = stateHashOf(strictState)
    if (strictPostStateHash !== PROFILE.strictPostStateHash) {
      throw new Error(transitionCompatibilityHashError({
        preStateHash,
        strictPostStateHash,
        livedPostStateHash: PROFILE.livedPostStateHash,
      })!)
    }

    const livedOutcome = livedEvolver(state, event)
    assertAcceptedTransition("lived", state, event, livedOutcome)
    const livedPostStateHash = stateHashOf(state)
    const error = transitionCompatibilityHashError({
      preStateHash,
      strictPostStateHash,
      livedPostStateHash,
    })
    if (error) throw new Error(error)
    return livedOutcome
  }
}

function memoizedResolver<T>(resolve: (hash: string) => T | null | Promise<T | null>) {
  const cache = new Map<string, Promise<T | null>>()
  return (hash: string): Promise<T | null> => {
    const prior = cache.get(hash)
    if (prior) return prior
    const loading = Promise.resolve(resolve(hash))
    cache.set(hash, loading)
    return loading
  }
}

/** Bind the constitutional verifier's resolver to the closed historical transition seam. */
export function withTransitionCompatibility(
  resolveRuleset: RulesetResolverV2,
  events: readonly AnyEventEnvelope[],
): RulesetResolverV2 {
  const recordGenesisHash = events[0]?.hash ?? ""
  const selected = transitionCompatibilitiesForRecord(events).length === 1
  const resolve = memoizedResolver(resolveRuleset)
  const wrapped: RulesetResolverV2 = async rulesetHash => {
    const cause = await resolve(rulesetHash)
    if (!cause || !selected || recordGenesisHash !== PROFILE.recordGenesisHash ||
        rulesetHash !== PROFILE.causeRulesetHash) return cause
    const lived = await resolve(PROFILE.transitionRulesetHash)
    if (!lived) {
      throw new Error(
        `transition compatibility ${PROFILE.profile} requires retained ruleset ` +
        PROFILE.transitionRulesetHash,
      )
    }
    return {
      // The signed cause still owns admission and verification. Only factual evolution is adapted.
      verifyDecisionV2: cause.verifyDecisionV2,
      evolveFactV2: closedCompatibilityEvolver(
        recordGenesisHash,
        cause.evolveFactV2,
        lived.evolveFactV2,
      ),
    } satisfies ResolvedRulesetV2
  }
  return wrapped
}

/** Bind durable decision-receipt recovery to the same closed historical transition seam. */
export function withExecutionTransitionCompatibility(
  resolveExecution: RetainedExecutionResolverV2,
  events: readonly AnyEventEnvelope[],
): RetainedExecutionResolverV2 {
  const recordGenesisHash = events[0]?.hash ?? ""
  const selected = transitionCompatibilitiesForRecord(events).length === 1
  const resolve = memoizedResolver(resolveExecution)
  const wrapped: RetainedExecutionResolverV2 = async rulesetHash => {
    const cause = await resolve(rulesetHash)
    if (!cause || !selected || recordGenesisHash !== PROFILE.recordGenesisHash ||
        rulesetHash !== PROFILE.causeRulesetHash) return cause
    const lived = await resolve(PROFILE.transitionRulesetHash)
    if (!lived) {
      throw new Error(
        `transition compatibility ${PROFILE.profile} requires retained ruleset ` +
        PROFILE.transitionRulesetHash,
      )
    }
    return {
      // Recovery re-runs the cause artifact's decision; it never admits through the lived artifact.
      decideV2: cause.decideV2,
      evolveFactV2: closedCompatibilityEvolver(
        recordGenesisHash,
        cause.evolveFactV2,
        lived.evolveFactV2,
      ),
    } satisfies RetainedExecutionV2
  }
  return wrapped
}
