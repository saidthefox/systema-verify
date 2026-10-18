import { createPublicKey, verify as edVerify } from "crypto"
import type {
  AnyEventEnvelope, Candidate, CommandEnvelopeV2, CoreState, EventEnvelope, EventEnvelopeV2, Outcome,
} from "./types"
import { canonical, hashOf, keyFingerprint, STATE_HASH_V, stateHashOf, ZERO64 } from "./canonical"
import { sigPayload } from "./sequencer"
import { applyEvent, evolveV1, initState } from "./reducer"
import { dialNum } from "./dials"
import {
  COMMAND_AUTH_V2_PROFILE, commandIdentityV2, commandSignaturePayloadV2, verifyEnvelopeChain,
} from "./protocol"
import type { DecisionProofV2 } from "./protocol-v2"
import { protocolAtSeq } from "./activation"
import {
  LEGACY_PROTOCOL_V2_RULESET_HASH,
  PROTOCOL_V2_RULESET_AUTHORIZATION_PROFILE,
  isProtocolV2RulesetFact,
  protocolV2RulesetFactError,
  protocolV2RulesetSelection,
  protocolV2RulesetTarget,
  type ProtocolV2RulesetAuthorizationEvidence,
} from "./ruleset-policy"

/**
 * The verification layer — the sequencer's door and the stranger's replay (D10).
 *
 * Same crypto discipline as systema-chain: ed25519 over DER/spki, fingerprint =
 * sha256(raw DER bytes). The reducer itself never touches signatures; the sequencer
 * verifies at the door, and verifyLog re-proves the whole record — hash chain, per-entity
 * puddles, and (optionally) every signature under the keys the log itself registered.
 */

export const fingerprintOf = keyFingerprint

export function ed25519Verify(publicKeyB64: string, payload: string, sigB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" })
    return edVerify(null, Buffer.from(payload), key, Buffer.from(sigB64, "base64"))
  } catch {
    return false
  }
}

/** Resolve the public key a candidate must verify under: a registered actor's key, or —
 *  for self-registering identity events and outside ATTESTATIONs — the key carried in the
 *  payload, bound by fingerprint. The reducer still decides which kinds may use an unknown
 *  actor; signature verification grants no standing by itself. */
function keyFor(state: CoreState, c: Pick<Candidate, "actor" | "payload">): string | null {
  const registered = state.actors[c.actor]?.publicKey
  if (registered) return registered
  const carried = c.payload.publicKey
  if (typeof carried === "string" && fingerprintOf(carried) === c.actor) return carried
  return null
}

/** The real sequencer-door verifier: pass to LogSim in place of the test stub. */
export function realVerifier(stateRef: () => CoreState) {
  return (c: Candidate): boolean => {
    const pub = keyFor(stateRef(), c)
    if (!pub) return false
    return ed25519Verify(pub, sigPayload(c), c.sig)
  }
}

/** Verify a v2 intent under the key roster in force immediately before its decision. */
export function verifyCommandV2(stateBefore: CoreState, command: CommandEnvelopeV2): boolean {
  const pub = keyFor(stateBefore, command)
  return pub !== null && ed25519Verify(pub, commandSignaturePayloadV2(command), command.sig)
}

export interface LogVerdict {
  valid: boolean
  failedAt?: number
  reason?: string
  events: number
  mode: LogVerificationMode
}

export type LogVerificationMode = "state-replay" | "constitutional-v1" | "constitutional-mixed"

export interface VerifyLogOptions {
  sigs?: boolean
  snapshot?: CoreState
}

/**
 * Re-prove a log end to end: seq gaps, hash chain, per-entity puddle links, recomputed
 * envelope hashes, reducer validity of every fold — and, with { sigs: true }, every
 * signature under the keys the log itself registered (system keys must arrive via the
 * GENESIS `systemKeys` roster or self-registering events; an unverifiable signer fails
 * the log, never skips it).
 */
function verifyInMode(events: EventEnvelope[], opts: VerifyLogOptions, mode: LogVerificationMode): LogVerdict {
  if (!events.length) return { valid: false, reason: "empty log", events: 0, mode }
  const fail = (e: EventEnvelope, reason: string): LogVerdict => ({ valid: false, failedAt: e.seq, reason, events: events.length, mode })

  let state: CoreState
  try {
    // A snapshot-genesis log cannot be folded without its sidecar, and the whole point of this
    // function is that a STRANGER can run it: they will have the log and genesis-state.json,
    // which is exactly what the replicas carry. Without this parameter the verifier refused the
    // very shape it was built to check (found 2026-08-18 running it against a replica).
    state = initState(events[0], opts.snapshot)
  } catch (err) {
    return { valid: false, failedAt: 0, reason: String(err instanceof Error ? err.message : err), events: events.length, mode }
  }

  let prev = ZERO64
  const entityHeads = new Map<string, string>()
  for (const e of events) {
    if (e.prev !== prev) return fail(e, "broken prev_hash link")
    const expectedEntityPrev = entityHeads.get(e.actor) ?? null
    if (e.entityPrev !== expectedEntityPrev) return fail(e, "broken entity chain link (the puddle)")
    const recomputed = hashOf({ seq: e.seq, ts: e.ts, kind: e.kind, v: e.v, actor: e.actor, payload: e.payload, sig: e.sig, prev: e.prev, entityPrev: e.entityPrev })
    if (recomputed !== e.hash) return fail(e, "hash mismatch")
    // A STRANGER ENFORCES WHAT THE DOOR ENFORCED. `opts.sigs` checks everything, which is what
    // an auditor wants; but from SIGS_FROM_SEQ onward the LAW requires it, so the verifier
    // demands it whether or not the caller asked — otherwise a replay could call a log valid
    // that the kingdom's own door would have refused. Below that seq the custodial era stands
    // as it was lived: signatures were not required, and re-judging history under a later rule
    // would refuse the record for obeying the rule in force at the time.
    const sigsRequiredHere = dialNum(state.dials, "SIGS_FROM_SEQ") > 0
      && e.seq >= dialNum(state.dials, "SIGS_FROM_SEQ")
    if ((opts.sigs || sigsRequiredHere) && e.kind !== "GENESIS") {
      const pub = keyFor(state, e)
      if (!pub) return fail(e, `no verifiable key for actor ${e.actor}`)
      if (!ed25519Verify(pub, sigPayload(e), e.sig)) return fail(e, "signature verification failed")
    }
    if (e.seq > 0) {
      try {
        if (mode === "constitutional-v1") applyEvent(state, e)
        else evolveV1(state, e)
      } catch (err) {
        const label = mode === "constitutional-v1" ? "reducer refused" : "state replay failed"
        return fail(e, `${label}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    prev = e.hash
    entityHeads.set(e.actor, e.hash)
  }
  return { valid: true, events: events.length, mode }
}

/**
 * Prove the record envelope, signature era and ability to evolve every recorded fact. This does
 * not claim that the command behind each v1 fact was admissible; that is a separate proof.
 */
export function verifyStateReplay(events: EventEnvelope[], opts: VerifyLogOptions = {}): LogVerdict {
  return verifyInMode(events, opts, "state-replay")
}

/** Re-run the frozen protocol-v1 admission law as well as the ordinary record proof. */
export function verifyConstitutionalLog(events: EventEnvelope[], opts: VerifyLogOptions = {}): LogVerdict {
  return verifyInMode(events, opts, "constitutional-v1")
}

export type DecisionVerifierV2 = (
  stateBefore: CoreState,
  events: EventEnvelopeV2[],
) => DecisionProofV2 | Promise<DecisionProofV2>

export type FactEvolverV2 = (stateBefore: CoreState, event: EventEnvelopeV2) => Outcome

export type StateInitializerV1 = (genesis: EventEnvelope, snapshot?: CoreState) => CoreState
export type FactEvolverV1 = (stateBefore: CoreState, event: EventEnvelope) => Outcome

/**
 * The exact executable and record commitment used to reproduce one protocol-v1 prefix.
 *
 * V1 facts predate per-event ruleset addresses.  This is therefore compatibility evidence: it
 * proves that named, content-addressed bytes reproduce an exact genesis-rooted handoff state. It
 * does not pretend those bytes were recorded as the source that originally admitted each fact.
 */
export interface V1ExecutionCommitment {
  profile: string
  claim: "compatibility-reproduction" | "explicit-bootstrap"
  rulesetHash: string
  recordGenesisHash: string
  through: {
    seq: number
    hash: string
    stateHashV: typeof STATE_HASH_V
    stateHash: string
  }
}

export interface ResolvedExecutionV1 {
  commitment: V1ExecutionCommitment
  initState: StateInitializerV1
  /** Re-run the retained v1 admission rule during constitutional preflight. */
  admitFactV1: FactEvolverV1
  /** Apply a fact already admitted by preflight during replay/recovery. */
  evolveFactV1: FactEvolverV1
}

export type ExecutionResolverV1 = (
  events: readonly AnyEventEnvelope[],
) => ResolvedExecutionV1 | null | Promise<ResolvedExecutionV1 | null>

/** Apply one v1 fact through a selected retained executor and require a real head advance. */
export function applyRetainedFactV1(
  state: CoreState,
  event: EventEnvelope,
  evolve: FactEvolverV1,
): Outcome {
  const outcome = evolve(state, event)
  if (!outcome || outcome.accepted !== true) {
    throw new Error(`retained v1 transition refused fact${outcome?.reason ? `: ${outcome.reason}` : ""}`)
  }
  if (state.seq !== event.seq) {
    throw new Error(`retained v1 transition ended at seq ${state.seq}; fact requires ${event.seq}`)
  }
  if (state.ts !== event.ts) {
    throw new Error(`retained v1 transition ended at ts ${state.ts}; fact requires ${event.ts}`)
  }
  return outcome
}

function v1CommitmentError(
  events: readonly AnyEventEnvelope[],
  commitment: V1ExecutionCommitment,
): string | null {
  if (!commitment.profile || commitment.profile.trim() !== commitment.profile) {
    return "protocol-v1 execution has an invalid profile"
  }
  if (!/^[0-9a-f]{64}$/.test(commitment.rulesetHash)) {
    return "protocol-v1 execution has an invalid ruleset address"
  }
  if (!/^[0-9a-f]{64}$/.test(commitment.recordGenesisHash) ||
      !/^[0-9a-f]{64}$/.test(commitment.through?.hash) ||
      !/^[0-9a-f]{64}$/.test(commitment.through?.stateHash)) {
    return "protocol-v1 execution has an invalid record or state commitment"
  }
  if (!Number.isSafeInteger(commitment.through.seq) || commitment.through.seq < 0 ||
      commitment.through.stateHashV !== STATE_HASH_V) {
    return "protocol-v1 execution has an unsupported handoff commitment"
  }
  if (events[0]?.hash !== commitment.recordGenesisHash) {
    return "protocol-v1 execution does not bind this record genesis"
  }
  const firstV2 = events.findIndex(isV2)
  const terminal = events[(firstV2 < 0 ? events.length : firstV2) - 1]
  if (!terminal || terminal.seq > commitment.through.seq ||
      (terminal.seq === commitment.through.seq && terminal.hash !== commitment.through.hash)) {
    return "protocol-v1 execution does not bind this v1 record cut"
  }
  return null
}

/** Verify an executor's complete shape and exact genesis/handoff selection before using it. */
export function assertRetainedV1Record(
  events: readonly AnyEventEnvelope[],
  execution: ResolvedExecutionV1,
): void {
  const error = v1CommitmentError(events, execution.commitment)
  if (error) throw new Error(error)
  if (typeof execution.initState !== "function" || typeof execution.admitFactV1 !== "function" ||
      typeof execution.evolveFactV1 !== "function") {
    throw new Error("protocol-v1 retained execution is incomplete")
  }
}

/** Verify the retained execution's committed post-state at the exact v1 handoff. */
export function assertRetainedV1Handoff(
  events: readonly AnyEventEnvelope[],
  state: CoreState,
  execution: ResolvedExecutionV1,
): void {
  assertRetainedV1Record(events, execution)
  const firstV2 = events.findIndex(isV2)
  const terminal = events[(firstV2 < 0 ? events.length : firstV2) - 1]
  if (!terminal || terminal.seq !== execution.commitment.through.seq ||
      terminal.hash !== execution.commitment.through.hash) {
    throw new Error("protocol-v1 execution does not bind this exact v1 handoff head")
  }
  if (state.seq !== execution.commitment.through.seq) {
    throw new Error(
      `protocol-v1 handoff state ended at seq ${state.seq}; commitment requires ${execution.commitment.through.seq}`,
    )
  }
  const actual = stateHashOf(state)
  if (actual !== execution.commitment.through.stateHash) {
    throw new Error(
      `protocol-v1 handoff state hash ${actual} does not match committed ${execution.commitment.through.stateHash}`,
    )
  }
}

/** Prove an earlier genesis-rooted cut without misdescribing it as the committed handoff. */
export function assertRetainedV1Cut(
  events: readonly AnyEventEnvelope[],
  state: CoreState,
  execution: ResolvedExecutionV1,
): void {
  assertRetainedV1Record(events, execution)
  const firstV2 = events.findIndex(isV2)
  const terminal = events[(firstV2 < 0 ? events.length : firstV2) - 1]
  if (!terminal || state.seq !== terminal.seq || state.ts !== terminal.ts) {
    throw new Error("protocol-v1 retained execution state does not name the selected record cut")
  }
  if (terminal.seq === execution.commitment.through.seq) {
    assertRetainedV1Handoff(events, state, execution)
  }
}

export interface ResolvedRulesetV2 {
  verifyDecisionV2: DecisionVerifierV2
  /** Exact factual state transition retained in the content-addressed ruleset named by the fact. */
  evolveFactV2: FactEvolverV2
}

/**
 * Apply one retained transition and prove its minimum factual contract.  A transition that
 * returns a refusal, or merely returns success without advancing the canonical head, must never
 * lend a replay a green verdict.  Consumers use this same guard outside preflight so a mutable or
 * nondeterministic loader cannot pass verification once and evolve different state afterward.
 */
export function applyRetainedFactV2(
  state: CoreState,
  event: EventEnvelopeV2,
  evolve: FactEvolverV2,
): Outcome {
  const outcome = evolve(state, event)
  if (!outcome || outcome.accepted !== true) {
    throw new Error(`retained transition refused fact${outcome?.reason ? `: ${outcome.reason}` : ""}`)
  }
  if (state.seq !== event.seq) {
    throw new Error(`retained transition ended at seq ${state.seq}; fact requires ${event.seq}`)
  }
  if (state.ts !== event.ts) {
    throw new Error(`retained transition ended at ts ${state.ts}; fact requires ${event.ts}`)
  }
  return outcome
}

export type RulesetResolverV2 = (
  rulesetHash: string,
) => ResolvedRulesetV2 | null | Promise<ResolvedRulesetV2 | null>

export interface VerifyMixedLogOptions extends VerifyLogOptions {
  resolveRuleset: RulesetResolverV2
  /** Required, explicit v1 compatibility/bootstrap executor; there is no current-source fallback. */
  resolveV1Execution: ExecutionResolverV1
  /** Test/embedding seam; implementations must preserve the named protocol-v2 auth profile. */
  verifyCommand?: (command: CommandEnvelopeV2, stateBefore: CoreState) => boolean
}

export interface MixedLogVerdict extends LogVerdict {
  mode: "constitutional-mixed"
  commandAuthProfile: typeof COMMAND_AUTH_V2_PROFILE
  rulesets: string[]
  v1Execution: V1ExecutionCommitment | null
  rulesetAuthorization: ProtocolV2RulesetAuthorizationEvidence
}

const isV2 = (event: AnyEventEnvelope): event is EventEnvelopeV2 =>
  "protocol" in event && event.protocol === 2

/**
 * Audit one continuous v1→v2 record. V1 admission is re-run through the frozen compatibility
 * path. Each contiguous v2 decision group is checked by the exact retained rulebook named in its
 * cause, then every fact is evolved by that same retained artifact. Current TypeScript types are
 * only the in-memory carrier; they do not replace a historical transition with today's reducer.
 */
export async function verifyMixedConstitutionalLog(
  events: AnyEventEnvelope[],
  opts: VerifyMixedLogOptions,
): Promise<MixedLogVerdict> {
  const mode = "constitutional-mixed" as const
  const rulesets = new Set<string>()
  let v1Execution: ResolvedExecutionV1 | null = null
  let activeRuleset = protocolV2RulesetSelection({ dials: {} })
  let legacyUnboundDecisions = 0
  let firstPolicySeq: number | null = null
  const rulesetAuthorization = (): ProtocolV2RulesetAuthorizationEvidence => ({
    profile: PROTOCOL_V2_RULESET_AUTHORIZATION_PROFILE,
    legacyFallback: LEGACY_PROTOCOL_V2_RULESET_HASH,
    legacyUnboundDecisions,
    firstPolicySeq,
    active: { ...activeRuleset },
  })
  const fail = (event: AnyEventEnvelope | undefined, reason: string): MixedLogVerdict => ({
    valid: false,
    ...(event ? { failedAt: event.seq } : {}),
    reason,
    events: events.length,
    mode,
    commandAuthProfile: COMMAND_AUTH_V2_PROFILE,
    rulesets: [...rulesets],
    v1Execution: v1Execution?.commitment ?? null,
    rulesetAuthorization: rulesetAuthorization(),
  })

  const wire = verifyEnvelopeChain(events)
  if (!wire.valid) return {
    valid: false, failedAt: wire.failedAt, reason: wire.reason, events: events.length, mode,
    commandAuthProfile: COMMAND_AUTH_V2_PROFILE, rulesets: [],
    v1Execution: null,
    rulesetAuthorization: rulesetAuthorization(),
  }
  if (!events.length || isV2(events[0])) return fail(events[0], "a mixed record needs the frozen v1 genesis")

  try {
    v1Execution = await opts.resolveV1Execution(events)
  } catch (err) {
    return fail(events[0], `protocol-v1 retained execution unavailable: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!v1Execution) return fail(events[0], "protocol-v1 retained execution unavailable for this record")
  const commitmentError = v1CommitmentError(events, v1Execution.commitment)
  if (commitmentError) return fail(events[0], commitmentError)
  if (typeof v1Execution.initState !== "function" || typeof v1Execution.admitFactV1 !== "function" ||
      typeof v1Execution.evolveFactV1 !== "function") {
    return fail(events[0], "protocol-v1 retained execution is incomplete")
  }

  let state: CoreState
  try {
    state = v1Execution.initState(events[0], opts.snapshot)
    activeRuleset = protocolV2RulesetSelection(state)
  } catch (err) {
    return fail(events[0], err instanceof Error ? err.message : String(err))
  }

  let crossed = false
  for (let position = 1; position < events.length;) {
    const event = events[position]
    if (!isV2(event)) {
      if (crossed) return fail(event, "protocol v1 event appears after the v2 boundary")
      if (protocolAtSeq(state, event.seq) !== 1) return fail(event, "protocol v1 event appears at or after recorded v2 activation")
      const sigsRequiredHere = dialNum(state.dials, "SIGS_FROM_SEQ") > 0
        && event.seq >= dialNum(state.dials, "SIGS_FROM_SEQ")
      if (opts.sigs || sigsRequiredHere) {
        const pub = keyFor(state, event)
        if (!pub) return fail(event, `no verifiable key for actor ${event.actor}`)
        if (!ed25519Verify(pub, sigPayload(event), event.sig)) return fail(event, "signature verification failed")
      }
      try {
        applyRetainedFactV1(state, event, v1Execution.admitFactV1)
      } catch (err) {
        return fail(event, `reducer refused: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (isProtocolV2RulesetFact(event)) {
        const target = protocolV2RulesetSelection(state)
        if (!await opts.resolveRuleset(target.rulesetHash)) {
          return fail(event, `recorded active ruleset ${target.rulesetHash} is unavailable`)
        }
        firstPolicySeq ??= event.seq
      }
      activeRuleset = protocolV2RulesetSelection(state)
      position++
      continue
    }

    if (!crossed) {
      try {
        assertRetainedV1Handoff(events, state, v1Execution)
      } catch (err) {
        return fail(event, err instanceof Error ? err.message : String(err))
      }
      crossed = true
    }
    if (protocolAtSeq(state, event.seq) !== 2) return fail(event, "protocol v2 event appears before recorded activation")
    const identity = commandIdentityV2(event.cause.command)
    const commandBytes = canonical(event.cause.command)
    const group: EventEnvelopeV2[] = []
    while (position < events.length) {
      const candidate = events[position]
      if (!isV2(candidate) || commandIdentityV2(candidate.cause.command) !== identity) break
      if (canonical(candidate.cause.command) !== commandBytes) return fail(candidate, "v2 decision group changes signed command bytes")
      group.push(candidate)
      position++
    }

    const rulesetHash = group[0].cause.rulesetHash
    if (group.some(fact => fact.cause.rulesetHash !== rulesetHash)) {
      return fail(group[0], "one v2 decision group names multiple rulesets")
    }
    const authorizationBefore = protocolV2RulesetSelection(state)
    activeRuleset = authorizationBefore
    const policyFacts = group.filter(isProtocolV2RulesetFact)
    if (policyFacts.length > 1) return fail(group[0], "one v2 decision may not change the active ruleset more than once")
    for (const fact of group) {
      const policyError = protocolV2RulesetFactError(state, fact, group[0].cause.command.actor)
      if (policyError) return fail(fact, policyError)
    }
    if (authorizationBefore.source === "recorded-dial" || policyFacts.length) {
      if (rulesetHash !== authorizationBefore.rulesetHash) {
        return fail(
          group[0],
          `v2 decision names ruleset ${rulesetHash}; recorded policy requires ${authorizationBefore.rulesetHash}`,
        )
      }
    } else {
      // Existing kingdoms changed application-selected rulesets before this policy existed.  That
      // history remains explicit compatibility evidence, never retroactive authorization.
      legacyUnboundDecisions++
    }
    const verifyCommand = opts.verifyCommand ?? ((command, stateBefore) => verifyCommandV2(stateBefore, command))
    if (!verifyCommand(group[0].cause.command, state)) return fail(group[0], "v2 command signature verification failed")

    const ruleset = await opts.resolveRuleset(rulesetHash)
    if (!ruleset) return fail(group[0], `ruleset artifact unavailable: ${rulesetHash}`)
    rulesets.add(rulesetHash)
    const proof = await ruleset.verifyDecisionV2(state, group)
    if (!proof.valid) return fail(group[0], `ruleset ${rulesetHash} refused its decision proof: ${proof.reason}`)

    const targetRulesetHash = policyFacts.length ? protocolV2RulesetTarget(policyFacts[0]) : null
    if (targetRulesetHash) {
      const target = await opts.resolveRuleset(targetRulesetHash)
      if (!target) {
        return fail(policyFacts[0], `recorded active ruleset ${targetRulesetHash} is unavailable`)
      }
    }

    for (const fact of group) {
      try {
        applyRetainedFactV2(state, fact, ruleset.evolveFactV2)
      } catch (err) {
        return fail(fact, `retained state transition ${rulesetHash} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    let selectedAfter: ReturnType<typeof protocolV2RulesetSelection>
    try {
      selectedAfter = protocolV2RulesetSelection(state)
    } catch (err) {
      return fail(group[0], `retained transition corrupted active-ruleset policy: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (targetRulesetHash) {
      const selected = selectedAfter
      if (selected.source !== "recorded-dial" || selected.rulesetHash !== targetRulesetHash) {
        return fail(policyFacts[0], "retained transition did not apply its active-ruleset policy fact")
      }
      firstPolicySeq ??= policyFacts[0].seq
    } else if (
      selectedAfter.source !== authorizationBefore.source ||
      selectedAfter.rulesetHash !== authorizationBefore.rulesetHash
    ) {
      return fail(group[0], "retained transition changed active-ruleset policy without its DIAL_SET fact")
    }
    activeRuleset = selectedAfter
  }

  if (!crossed) {
    try {
      assertRetainedV1Cut(events, state, v1Execution)
    } catch (err) {
      return fail(events.at(-1), err instanceof Error ? err.message : String(err))
    }
  }

  return {
    valid: true, events: events.length, mode,
    commandAuthProfile: COMMAND_AUTH_V2_PROFILE, rulesets: [...rulesets],
    v1Execution: v1Execution.commitment,
    rulesetAuthorization: rulesetAuthorization(),
  }
}

/** @deprecated Compatibility name: historically `verifyLog` meant constitutional v1 replay. */
export function verifyLog(events: EventEnvelope[], opts: VerifyLogOptions = {}): LogVerdict {
  return verifyConstitutionalLog(events, opts)
}
