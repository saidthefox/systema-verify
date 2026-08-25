import type {
  AnyEventEnvelope, CommandEnvelopeV2, CoreState, DecisionV2, EventEnvelope, EventEnvelopeV2,
  FactDraftV2,
} from "./types"
import { canonical } from "./canonical"
import { activatePending, evolveV1, validate } from "./reducer"
import {
  commandEnvelopeV2Error, commandIdentityV2, sealEventV2, verifyEnvelopeChain,
} from "./protocol"

const COMMAND_TO_FACT = {
  RatifyAmendment: "AMENDMENT_RATIFIED",
  AnchorLaw: "LAW_ANCHORED",
  Attest: "ATTESTATION",
  RotateKey: "KEY_EVENT",
  Compensate: "COMPENSATION",
  Tick: "TICK",
  SetDial: "DIAL_SET",
  RevokeAlias: "ALIAS_REVOKED",
  RegisterEntity: "ENTITY_REGISTERED",
  FoundHouse: "HOUSE_FOUNDED",
  AddHouseAlias: "HOUSE_ALIAS_ADDED",
  MintAgent: "AGENT_MINTED",
  CharterLineage: "LINEAGE_CHARTERED",
  CharterLineageAgent: "LINEAGE_AGENT_CHARTERED",
  AdmitLineageAgent: "LINEAGE_AGENT_ADMITTED",
  FileAct: "ACT_FILED",
  CastVote: "VOTE_CAST",
  FileContest: "CONTEST_FILED",
  CommitVote: "VOTE_COMMIT",
  RevealVote: "VOTE_REVEAL",
  PlaceStake: "STAKE_PLACED",
  FileFlag: "FLAG_FILED",
  PlaceNudge: "NUDGE_PLACED",
  SubmitGalleryVerdict: "GALLERY_VERDICT",
  Smelt: "SMELT",
  RuleCourt: "COURT_RULING",
} as const

export type CommandKindV2 = keyof typeof COMMAND_TO_FACT

/** Pending activation changes only these two fields; clone them so decision stays pure. */
function stateAtNextSeq(state: CoreState): CoreState {
  const view: CoreState = {
    ...state,
    dials: { ...state.dials },
    pendingActivations: state.pendingActivations.map(a => ({ ...a, dials: { ...a.dials } })),
  }
  activatePending(view, state.seq + 1)
  return view
}

function chargedRefusal(command: CommandEnvelopeV2, reason: string): FactDraftV2 | null {
  if (command.command !== "FileAct") return null
  const actKind = command.payload.actKind
  if (typeof actKind !== "string") return null
  const charged =
    (actKind === "EDGE" && /already exists|already derivable/.test(reason)) ||
    (actKind === "ENTRY" && /already held|pass a sense/.test(reason)) ||
    (actKind === "LABEL" && /already holds|word already held/.test(reason))
  return charged ? {
    kind: "FILING_REFUSED",
    v: 1,
    actor: command.actor,
    payload: { actKind, reason },
  } : null
}

/** Pure v2 admission: imperative intent maps to a fact, then the current rule validates it. */
export function decideV2(state: CoreState, command: CommandEnvelopeV2, ts: string): DecisionV2 {
  const shape = commandEnvelopeV2Error(command)
  if (shape) return { accepted: false, reason: shape, facts: [] }
  if (command.v !== 1) return { accepted: false, reason: `unsupported ${command.command} command version: ${command.v}`, facts: [] }
  const kind = COMMAND_TO_FACT[command.command as CommandKindV2]
  if (!kind) return { accepted: false, reason: `unknown v2 command: ${command.command}`, facts: [] }

  const view = stateAtNextSeq(state)
  const fact: FactDraftV2 = { kind, v: 1, actor: command.actor, payload: command.payload }
  const reason = validate(view, { ...fact, ts })
  if (!reason) return { accepted: true, facts: [fact] }

  const refusal = chargedRefusal(command, reason)
  if (!refusal) return { accepted: false, reason, facts: [] }
  const refusalError = validate(view, { ...refusal, ts })
  if (refusalError) return { accepted: false, reason: `${reason}; charged refusal could not be recorded: ${refusalError}`, facts: [] }
  return { accepted: false, reason, facts: [refusal], charged: true }
}

export interface V2SubmitResult extends DecisionV2 {
  events: EventEnvelopeV2[]
  replayed: boolean
}

interface CachedSubmission {
  commandBytes: string
  result: V2SubmitResult
}

/**
 * Closed in-memory harness for proving sequencing and retry behavior. It is intentionally not
 * durable and therefore cannot be connected to a route or production writer.
 */
export class ClosedV2Harness {
  readonly events: EventEnvelopeV2[] = []
  readonly state: CoreState
  private head: string
  private readonly entityHeads = new Map<string, string>()
  private readonly submissions = new Map<string, CachedSubmission>()

  constructor(
    state: CoreState,
    prior: AnyEventEnvelope[],
    private readonly rulesetHash: string,
    private readonly verifyCommand: (command: CommandEnvelopeV2) => boolean,
  ) {
    const chain = verifyEnvelopeChain(prior)
    if (!chain.valid) throw new Error(`invalid prior chain at seq ${chain.failedAt}: ${chain.reason}`)
    if (!prior.length) throw new Error("v2 harness needs the existing chain head")
    this.state = state
    this.head = prior[prior.length - 1].hash
    for (const event of prior) this.entityHeads.set(event.actor, event.hash)
  }

  submit(command: CommandEnvelopeV2, ts: string): V2SubmitResult {
    const identity = commandIdentityV2(command)
    const commandBytes = canonical(command)
    const cached = this.submissions.get(identity)
    if (cached) {
      if (cached.commandBytes !== commandBytes) {
        return { accepted: false, reason: "idempotency key already used for different signed command bytes", facts: [], events: [], replayed: true }
      }
      return { ...cached.result, events: [...cached.result.events], facts: [...cached.result.facts], replayed: true }
    }
    if (!this.verifyCommand(command)) {
      const result: V2SubmitResult = { accepted: false, reason: "v2 command signature verification failed", facts: [], events: [], replayed: false }
      this.submissions.set(identity, { commandBytes, result })
      return result
    }

    const decision = decideV2(this.state, command, ts)
    const sealed: EventEnvelopeV2[] = []
    for (let eventIndex = 0; eventIndex < decision.facts.length; eventIndex++) {
      const fact = decision.facts[eventIndex]
      const event = sealEventV2({
        seq: this.state.seq + 1,
        ts,
        fact,
        command,
        eventIndex,
        rulesetHash: this.rulesetHash,
        prev: this.head,
        entityPrev: this.entityHeads.get(fact.actor) ?? null,
      })
      // The v1 factual reducer is the current event-schema implementation. It ignores sig/hash.
      const adapter: EventEnvelope = { ...event, sig: command.sig }
      evolveV1(this.state, adapter)
      sealed.push(event)
      this.events.push(event)
      this.head = event.hash
      this.entityHeads.set(event.actor, event.hash)
    }
    const result: V2SubmitResult = { ...decision, events: sealed, replayed: false }
    this.submissions.set(identity, { commandBytes, result })
    return result
  }
}

export interface DecisionProofV2 {
  valid: boolean
  reason?: string
}

/** Re-run one recorded command decision and compare every resulting fact byte-for-byte. */
export function verifyDecisionV2(stateBefore: CoreState, events: EventEnvelopeV2[]): DecisionProofV2 {
  if (!events.length) return { valid: false, reason: "a recorded v2 decision needs at least one fact" }
  const command = events[0].cause.command
  const ts = events[0].ts
  const expected = decideV2(stateBefore, command, ts)
  if (expected.facts.length !== events.length) return { valid: false, reason: `decision produced ${expected.facts.length} facts, record carries ${events.length}` }
  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (event.ts !== ts || canonical(event.cause.command) !== canonical(command)) return { valid: false, reason: "one decision group must carry one command and timestamp" }
    if (event.cause.eventIndex !== i) return { valid: false, reason: "decision eventIndex does not match fact order" }
    const actual = { kind: event.kind, v: event.v, actor: event.actor, payload: event.payload }
    if (canonical(actual) !== canonical(expected.facts[i])) return { valid: false, reason: `fact ${i} does not match decideV2` }
  }
  return { valid: true }
}
