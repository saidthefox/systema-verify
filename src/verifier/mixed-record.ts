import { join } from "node:path"
import type {
  AnyEventEnvelope,
  CommandEnvelopeV2,
  CoreState,
  Outcome,
} from "../core/types"
import {
  applyRetainedFactV1,
  applyRetainedFactV2,
  assertRetainedV1Cut,
  assertRetainedV1Handoff,
  verifyMixedConstitutionalLog,
  type ExecutionResolverV1,
  type MixedLogVerdict,
  type ResolvedExecutionV1,
  type ResolvedRulesetV2,
  type RulesetResolverV2,
} from "../core/verify"
import { stateFromJson, stateToJson } from "../record/codec"
import { createRetainedRulesetResolver } from "./ruleset-resolver"
import { createRetainedV1CompatibilityResolver } from "./v1-compatibility"
import {
  transitionCompatibilitiesForRecord,
  withTransitionCompatibility,
  type TransitionCompatibility,
} from "./transition-compatibility"

/**
 * The one non-core boundary for consumers of an already-written mixed record.
 *
 * Constitutional verification and factual evolution are one retained execution pair: each v2
 * decision is interpreted by the content-addressed ruleset named in the fact's cause and factual
 * evolution normally comes from that same artifact. One immutable staging tuple uses the closed,
 * reported transition compatibility in `transition-compatibility.ts`. Current TypeScript types
 * carry historical state in memory, but today's reducer must never reinterpret an already-recorded
 * v2 transition.
 *
 * A visitor cannot run until the complete selected record cut has passed preflight. This is
 * important for projectors and repair tools: discovering a missing historical ruleset after
 * committing the prefix would leave an authoritative-looking partial result.
 */

export interface MixedRecordPreflightOptions {
  snapshot?: CoreState
  /** Inclusive record cut. Infinity/omission selects the complete supplied record. */
  maxSeq?: number
  /** Defaults to the checkout/deployment's content-addressed `rulesets` directory. */
  rulesetRoot?: string
  /** Test/embedding seam. Production callers normally provide `rulesetRoot` instead. */
  resolveRuleset?: RulesetResolverV2
  /** Explicit test/new-realm seam. Production selects a closed retained-v1 profile by default. */
  resolveV1Execution?: ExecutionResolverV1
  sigs?: boolean
  verifyCommand?: (command: CommandEnvelopeV2, stateBefore: CoreState) => boolean
}

export interface VerifiedMixedRecord {
  events: AnyEventEnvelope[]
  verdict: MixedLogVerdict
  /** Closed, hash-bound historical transition seams actually selected by this record cut. */
  transitionCompatibilities: TransitionCompatibility[]
}

export interface MixedReplayStep {
  event: AnyEventEnvelope
  outcome: Outcome
  /** Mutable fold immediately after `event`; inspect it during the callback, do not retain it. */
  state: CoreState
}

export interface MixedRecordReplayOptions extends MixedRecordPreflightOptions {
  /** Runs after the complete preflight and after genesis has been initialized. */
  onGenesis?: (state: CoreState) => void | Promise<void>
  /** Runs sequentially after each admitted fact has evolved. */
  onFact?: (step: MixedReplayStep) => void | Promise<void>
}

export interface MixedRecordReplay {
  events: AnyEventEnvelope[]
  verdict: MixedLogVerdict
  state: CoreState
  /** Closed, hash-bound historical transition seams actually selected by this record cut. */
  transitionCompatibilities: TransitionCompatibility[]
}

/** Structured refusal for callers that must distinguish a stale verifier from a bad record. */
export class MixedRecordPreflightError extends Error {
  readonly verdict: MixedLogVerdict
  readonly transitionCompatibilities: TransitionCompatibility[]

  constructor(verdict: MixedLogVerdict, transitionCompatibilities: TransitionCompatibility[] = []) {
    super(
      `retained-ruleset replay preflight failed` +
      `${verdict.failedAt === undefined ? "" : ` at seq ${verdict.failedAt}`}: ${verdict.reason ?? "unknown verification failure"}`,
    )
    this.name = "MixedRecordPreflightError"
    this.verdict = verdict
    this.transitionCompatibilities = transitionCompatibilities
  }
}

const freshSnapshot = (snapshot: CoreState | undefined): CoreState | undefined =>
  snapshot ? stateFromJson(stateToJson(snapshot)) : undefined

const isV2 = (event: AnyEventEnvelope): event is Extract<AnyEventEnvelope, { protocol: 2 }> =>
  "protocol" in event && event.protocol === 2

/** Keep verification and replay on the same integrity-checked retained execution instance. */
function memoizedRulesetResolver(resolve: RulesetResolverV2): RulesetResolverV2 {
  const cache = new Map<string, Promise<ResolvedRulesetV2 | null>>()
  return rulesetHash => {
    const prior = cache.get(rulesetHash)
    if (prior) return prior
    const loading = Promise.resolve(resolve(rulesetHash))
    cache.set(rulesetHash, loading)
    return loading
  }
}

/** Keep constitutional preflight and factual replay on one selected retained v1 execution. */
function memoizedV1ExecutionResolver(
  resolve: ExecutionResolverV1,
  selectionEvents: readonly AnyEventEnvelope[],
): ExecutionResolverV1 {
  let selected: Promise<ResolvedExecutionV1 | null> | undefined
  return () => selected ??= Promise.resolve(resolve(selectionEvents))
}

/** Select a genesis-rooted inclusive cut without accepting an ambiguous or lossy sequence. */
export function mixedRecordCut(
  events: readonly AnyEventEnvelope[],
  maxSeq = Number.POSITIVE_INFINITY,
): AnyEventEnvelope[] {
  if (maxSeq !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(maxSeq) || maxSeq < 0)) {
    throw new Error(`record cut must be a non-negative safe integer or Infinity, got ${maxSeq}`)
  }
  if (maxSeq !== Number.POSITIVE_INFINITY && events.length <= maxSeq) {
    throw new Error(`record cut ${maxSeq} is unavailable; supplied record ends before that position`)
  }
  // Sequence is an envelope property to be proved, not trusted while selecting the prefix.
  // Since a canonical record is zero-based, the cut has exactly maxSeq + 1 positions; the
  // subsequent envelope proof rejects a forged/misordered seq at any of those positions.
  const length = maxSeq === Number.POSITIVE_INFINITY ? events.length : maxSeq + 1
  return events.slice(0, length)
}

async function preflightBoundedRecord(
  bounded: AnyEventEnvelope[],
  options: MixedRecordPreflightOptions,
  resolveRuleset: RulesetResolverV2,
  resolveV1Execution: ExecutionResolverV1,
): Promise<VerifiedMixedRecord> {
  const transitionCompatibilities = transitionCompatibilitiesForRecord(bounded)
  const verdict = await verifyMixedConstitutionalLog(bounded, {
    snapshot: freshSnapshot(options.snapshot),
    resolveRuleset,
    resolveV1Execution,
    ...(options.sigs === undefined ? {} : { sigs: options.sigs }),
    ...(options.verifyCommand ? { verifyCommand: options.verifyCommand } : {}),
  })
  if (!verdict.valid) throw new MixedRecordPreflightError(verdict, transitionCompatibilities)
  return {
    events: bounded,
    verdict,
    transitionCompatibilities,
  }
}

/**
 * Prove the complete selected cut under its recorded constitutional history.
 * Returns owned array structure, but intentionally does not rewrite event objects or bytes.
 */
export async function preflightMixedRecord(
  events: readonly AnyEventEnvelope[],
  options: MixedRecordPreflightOptions = {},
): Promise<VerifiedMixedRecord> {
  const bounded = mixedRecordCut(events, options.maxSeq)
  const baseResolver = options.resolveRuleset ?? createRetainedRulesetResolver(
    options.rulesetRoot ?? join(process.cwd(), "rulesets"),
  )
  const resolveRuleset = memoizedRulesetResolver(withTransitionCompatibility(
    baseResolver,
    bounded,
  ))
  const resolveV1Execution = memoizedV1ExecutionResolver(
    options.resolveV1Execution ?? createRetainedV1CompatibilityResolver(
      options.rulesetRoot ?? join(process.cwd(), "rulesets"),
    ),
    events,
  )
  return preflightBoundedRecord(bounded, options, resolveRuleset, resolveV1Execution)
}

/**
 * Verify first, then evolve exactly the facts that were proved. No callback—and therefore no
 * caller-controlled write—can happen while ruleset availability or decision legality is unknown.
 */
export async function replayMixedRecord(
  events: readonly AnyEventEnvelope[],
  options: MixedRecordReplayOptions = {},
): Promise<MixedRecordReplay> {
  const bounded = mixedRecordCut(events, options.maxSeq)
  const baseResolver = options.resolveRuleset ?? createRetainedRulesetResolver(
    options.rulesetRoot ?? join(process.cwd(), "rulesets"),
  )
  const resolveRuleset = memoizedRulesetResolver(withTransitionCompatibility(
    baseResolver,
    bounded,
  ))
  const resolveV1Execution = memoizedV1ExecutionResolver(
    options.resolveV1Execution ?? createRetainedV1CompatibilityResolver(
      options.rulesetRoot ?? join(process.cwd(), "rulesets"),
    ),
    events,
  )
  const checked = await preflightBoundedRecord(
    bounded,
    options,
    resolveRuleset,
    resolveV1Execution,
  )
  if (!checked.events.length) throw new Error("cannot replay an empty record")

  const v1Execution = await resolveV1Execution(checked.events)
  if (!v1Execution) throw new Error("retained protocol-v1 execution disappeared after preflight")
  const genesis = checked.events[0]
  if (isV2(genesis)) {
    throw new Error("a mixed record needs the frozen v1 genesis")
  }
  const state = v1Execution.initState(genesis, freshSnapshot(options.snapshot))
  let handoffObserved = false
  const proveHandoff = (): void => {
    assertRetainedV1Handoff(checked.events, state, v1Execution)
    handoffObserved = true
  }
  if (state.seq === v1Execution.commitment.through.seq) proveHandoff()
  await options.onGenesis?.(state)
  for (const event of checked.events.slice(1)) {
    let outcome: Outcome
    if (isV2(event)) {
      if (!handoffObserved) {
        throw new Error("protocol-v2 replay reached its boundary before the retained-v1 handoff was proved")
      }
      const retained = await resolveRuleset(event.cause.rulesetHash)
      if (!retained) {
        // Preflight resolved this same memoized promise, so reaching this branch would mean an
        // internal invariant failed rather than an ordinary missing-artifact condition.
        throw new Error(`retained ruleset disappeared after preflight: ${event.cause.rulesetHash}`)
      }
      outcome = applyRetainedFactV2(state, event, retained.evolveFactV2)
    } else {
      outcome = applyRetainedFactV1(state, event, v1Execution.evolveFactV1)
      if (state.seq === v1Execution.commitment.through.seq) proveHandoff()
    }
    await options.onFact?.({ event, outcome, state })
  }
  if (!handoffObserved) assertRetainedV1Cut(checked.events, state, v1Execution)
  return { ...checked, state }
}
