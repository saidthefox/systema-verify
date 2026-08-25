import { createPublicKey, verify as edVerify } from "crypto"
import type {
  AnyEventEnvelope, Candidate, CommandEnvelopeV2, CoreState, EventEnvelope, EventEnvelopeV2,
} from "./types"
import { canonical, hashOf, keyFingerprint, ZERO64 } from "./canonical"
import { sigPayload } from "./sequencer"
import { applyEvent, evolveV1, factualEvent, initState } from "./reducer"
import { dialNum } from "./dials"
import { commandIdentityV2, commandSignaturePayloadV2, verifyEnvelopeChain } from "./protocol"
import type { DecisionProofV2 } from "./protocol-v2"

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

export type RulesetResolverV2 = (rulesetHash: string) => DecisionVerifierV2 | null | Promise<DecisionVerifierV2 | null>

export interface VerifyMixedLogOptions extends VerifyLogOptions {
  resolveRuleset: RulesetResolverV2
  verifyCommand?: (command: CommandEnvelopeV2, stateBefore: CoreState) => boolean
}

export interface MixedLogVerdict extends LogVerdict {
  mode: "constitutional-mixed"
  rulesets: string[]
}

const isV2 = (event: AnyEventEnvelope): event is EventEnvelopeV2 =>
  "protocol" in event && event.protocol === 2

/**
 * Audit one continuous v1→v2 record. V1 admission is re-run through the frozen compatibility
 * path. Each contiguous v2 decision group is checked by the exact retained rulebook named in its
 * cause, then its facts are evolved independently under the current state schema.
 */
export async function verifyMixedConstitutionalLog(
  events: AnyEventEnvelope[],
  opts: VerifyMixedLogOptions,
): Promise<MixedLogVerdict> {
  const mode = "constitutional-mixed" as const
  const rulesets = new Set<string>()
  const fail = (event: AnyEventEnvelope | undefined, reason: string): MixedLogVerdict => ({
    valid: false,
    ...(event ? { failedAt: event.seq } : {}),
    reason,
    events: events.length,
    mode,
    rulesets: [...rulesets],
  })

  const wire = verifyEnvelopeChain(events)
  if (!wire.valid) return {
    valid: false, failedAt: wire.failedAt, reason: wire.reason, events: events.length, mode, rulesets: [],
  }
  if (!events.length || isV2(events[0])) return fail(events[0], "a mixed record needs the frozen v1 genesis")

  let state: CoreState
  try {
    state = initState(events[0], opts.snapshot)
  } catch (err) {
    return fail(events[0], err instanceof Error ? err.message : String(err))
  }

  let crossed = false
  for (let position = 1; position < events.length;) {
    const event = events[position]
    if (!isV2(event)) {
      if (crossed) return fail(event, "protocol v1 event appears after the v2 boundary")
      const sigsRequiredHere = dialNum(state.dials, "SIGS_FROM_SEQ") > 0
        && event.seq >= dialNum(state.dials, "SIGS_FROM_SEQ")
      if (opts.sigs || sigsRequiredHere) {
        const pub = keyFor(state, event)
        if (!pub) return fail(event, `no verifiable key for actor ${event.actor}`)
        if (!ed25519Verify(pub, sigPayload(event), event.sig)) return fail(event, "signature verification failed")
      }
      try {
        applyEvent(state, event)
      } catch (err) {
        return fail(event, `reducer refused: ${err instanceof Error ? err.message : String(err)}`)
      }
      position++
      continue
    }

    crossed = true
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
    const verifyCommand = opts.verifyCommand ?? ((command, stateBefore) => verifyCommandV2(stateBefore, command))
    if (!verifyCommand(group[0].cause.command, state)) return fail(group[0], "v2 command signature verification failed")

    const verifier = await opts.resolveRuleset(rulesetHash)
    if (!verifier) return fail(group[0], `ruleset artifact unavailable: ${rulesetHash}`)
    rulesets.add(rulesetHash)
    const proof = await verifier(state, group)
    if (!proof.valid) return fail(group[0], `ruleset ${rulesetHash} refused its decision proof: ${proof.reason}`)

    for (const fact of group) {
      try {
        evolveV1(state, factualEvent(fact))
      } catch (err) {
        return fail(fact, `state replay failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  return { valid: true, events: events.length, mode, rulesets: [...rulesets] }
}

/** @deprecated Compatibility name: historically `verifyLog` meant constitutional v1 replay. */
export function verifyLog(events: EventEnvelope[], opts: VerifyLogOptions = {}): LogVerdict {
  return verifyConstitutionalLog(events, opts)
}
