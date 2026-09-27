import type {
  AnyEventEnvelope, CommandEnvelopeV2, CoreState, Decision, EventEnvelope, EventEnvelopeV2,
  EventDraft, FactDraftV2, LegacyCommandEnvelope,
} from "./types"
import { activatePending, validate } from "./reducer"
import { canonical, hashOf, sha256, ZERO64 } from "./canonical"

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

/**
 * The frozen v1 admission decision. Activation mutates the live state exactly as the original
 * sequencer did, including before a rejected candidate; changing that is a separate migration.
 */
export function decideV1(state: CoreState, command: LegacyCommandEnvelope, ts: string): Decision {
  activatePending(state, state.seq + 1)
  const reason = validate(state, {
    kind: command.kind,
    v: command.v,
    actor: command.actor,
    payload: command.payload,
    ts,
  })
  return reason
    ? { accepted: false, reason, events: [] }
    : { accepted: true, events: [legacyEventDraft(command)] }
}

type SignableCommandV2 = Omit<CommandEnvelopeV2, "sig"> | CommandEnvelopeV2

/** Domain-separated bytes signed by a v2 command author. */
export function commandSignaturePayloadV2(command: SignableCommandV2): string {
  return `systema.command.v2|${sha256(canonical({
    protocol: NEXT_PROTOCOL_VERSION,
    id: command.id,
    command: command.command,
    v: command.v,
    actor: command.actor,
    payload: command.payload,
  }))}`
}

/** Actor-scoped idempotency identity. Different actors may safely choose the same client id. */
export function commandIdentityV2(command: Pick<CommandEnvelopeV2, "actor" | "id">): string {
  return sha256(canonical({ protocol: NEXT_PROTOCOL_VERSION, actor: command.actor, id: command.id }))
}

const plainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

export function commandEnvelopeV2Error(command: CommandEnvelopeV2): string | null {
  if (command.protocol !== NEXT_PROTOCOL_VERSION) return "v2 command needs protocol: 2"
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(command.id)) return "v2 command id must be 1-128 safe ASCII characters"
  if (!/^[A-Z][A-Za-z0-9]{0,79}$/.test(command.command)) return "v2 command name must be PascalCase and at most 80 characters"
  if (!Number.isSafeInteger(command.v) || command.v < 1) return "v2 command schema version must be a positive safe integer"
  if (!command.actor || command.actor.length > 256) return "v2 command actor is required and bounded at 256 characters"
  if (!plainRecord(command.payload)) return "v2 command payload must be an object"
  if (!command.sig) return "v2 command signature is required"
  return null
}

export interface SealEventV2Input {
  seq: number
  ts: string
  fact: FactDraftV2
  command: CommandEnvelopeV2
  eventIndex: number
  rulesetHash: string
  prev: string
  entityPrev: string | null
}

export function eventEnvelopeV2Error(event: Omit<EventEnvelopeV2, "hash"> | EventEnvelopeV2): string | null {
  if (event.protocol !== NEXT_PROTOCOL_VERSION) return "v2 event needs protocol: 2"
  if (!Number.isSafeInteger(event.seq) || event.seq < 1) return "v2 event seq must be a positive safe integer"
  if (!event.ts || Number.isNaN(Date.parse(event.ts))) return "v2 event needs an ISO timestamp"
  if (!event.kind) return "v2 event kind is required"
  if (!Number.isSafeInteger(event.v) || event.v < 1) return "v2 event schema version must be a positive safe integer"
  if (!event.actor || event.actor.length > 256) return "v2 event actor is required and bounded at 256 characters"
  if (!plainRecord(event.payload)) return "v2 event payload must be an object"
  const commandError = commandEnvelopeV2Error(event.cause.command)
  if (commandError) return commandError
  if (!Number.isSafeInteger(event.cause.eventIndex) || event.cause.eventIndex < 0) return "v2 eventIndex must be a non-negative safe integer"
  if (!/^[0-9a-f]{64}$/.test(event.cause.rulesetHash)) return "v2 event needs a lowercase sha256 rulesetHash"
  if (!/^[0-9a-f]{64}$/.test(event.prev)) return "v2 event prev must be a lowercase sha256"
  if (event.entityPrev !== null && !/^[0-9a-f]{64}$/.test(event.entityPrev)) return "v2 event entityPrev must be null or a lowercase sha256"
  return null
}

/** Seal one v2 fact. Ordering and entity-head lookup remain the sequencer's responsibility. */
export function sealEventV2(input: SealEventV2Input): EventEnvelopeV2 {
  const unsealed: Omit<EventEnvelopeV2, "hash"> = {
    protocol: NEXT_PROTOCOL_VERSION,
    seq: input.seq,
    ts: input.ts,
    kind: input.fact.kind,
    v: input.fact.v,
    actor: input.fact.actor,
    payload: input.fact.payload,
    cause: {
      command: input.command,
      eventIndex: input.eventIndex,
      rulesetHash: input.rulesetHash,
    },
    prev: input.prev,
    entityPrev: input.entityPrev,
  }
  const error = eventEnvelopeV2Error(unsealed)
  if (error) throw new Error(error)
  return { ...unsealed, hash: hashOf(unsealed) }
}

const isEventEnvelopeV2 = (record: AnyEventEnvelope): record is EventEnvelopeV2 =>
  "protocol" in record && record.protocol === NEXT_PROTOCOL_VERSION

export function eventHashOf(record: AnyEventEnvelope): string {
  if (isEventEnvelopeV2(record)) {
    return hashOf({
      protocol: record.protocol,
      seq: record.seq,
      ts: record.ts,
      kind: record.kind,
      v: record.v,
      actor: record.actor,
      payload: record.payload,
      cause: record.cause,
      prev: record.prev,
      entityPrev: record.entityPrev,
    })
  }
  return hashOf({
    seq: record.seq,
    ts: record.ts,
    kind: record.kind,
    v: record.v,
    actor: record.actor,
    payload: record.payload,
    sig: record.sig,
    prev: record.prev,
    entityPrev: record.entityPrev,
  })
}

export interface EnvelopeChainVerdict {
  valid: boolean
  events: number
  failedAt?: number
  reason?: string
}

export interface EnvelopeChainOptions {
  verifyCommand?: (command: CommandEnvelopeV2) => boolean
  hasRuleset?: (rulesetHash: string) => boolean
}

/**
 * Prove only the mixed-protocol wire record: ordering, both hash chains, envelope hashes, v2
 * command signatures (when supplied), ruleset availability (when supplied), and command/event
 * idempotency. It deliberately does not claim the referenced ruleset produced each fact.
 */
export function verifyEnvelopeChain(
  events: AnyEventEnvelope[],
  opts: EnvelopeChainOptions = {},
): EnvelopeChainVerdict {
  if (!events.length) return { valid: false, events: 0, reason: "empty log" }
  const fail = (event: AnyEventEnvelope, reason: string): EnvelopeChainVerdict => ({
    valid: false, events: events.length, failedAt: event.seq, reason,
  })

  let prev = ZERO64
  let previousTs = ""
  const entityHeads = new Map<string, string>()
  const commands = new Map<string, { canonical: string; lastIndex: number; lastSeq: number }>()

  for (let position = 0; position < events.length; position++) {
    const event = events[position]
    if (event.seq !== position) return fail(event, `gap in log: expected seq ${position}, got ${event.seq}`)
    if (previousTs && Date.parse(event.ts) < Date.parse(previousTs)) return fail(event, "sequencer time went backwards")
    if (event.prev !== prev) return fail(event, "broken prev_hash link")
    if (event.entityPrev !== (entityHeads.get(event.actor) ?? null)) return fail(event, "broken entity chain link (the puddle)")

    const v2 = isEventEnvelopeV2(event)
    if (!v2 && Object.prototype.hasOwnProperty.call(event, "protocol")) {
      return fail(event, "protocol v1 is represented by an absent protocol field, never an explicit marker")
    }
    if (position === 0 && v2) return fail(event, "the existing chain begins with the frozen v1 genesis")
    if (v2) {
      const shape = eventEnvelopeV2Error(event)
      if (shape) return fail(event, shape)
      if (opts.verifyCommand && !opts.verifyCommand(event.cause.command)) return fail(event, "v2 command signature verification failed")
      if (opts.hasRuleset && !opts.hasRuleset(event.cause.rulesetHash)) return fail(event, `ruleset artifact not retained: ${event.cause.rulesetHash}`)

      const identity = commandIdentityV2(event.cause.command)
      const commandBytes = canonical(event.cause.command)
      const prior = commands.get(identity)
      if (!prior) {
        if (event.cause.eventIndex !== 0) return fail(event, "a v2 command's first fact must have eventIndex 0")
        commands.set(identity, { canonical: commandBytes, lastIndex: 0, lastSeq: event.seq })
      } else {
        if (prior.canonical !== commandBytes) return fail(event, "v2 idempotency identity reused for different signed command bytes")
        if (event.seq !== prior.lastSeq + 1) return fail(event, "facts from one v2 command must be contiguous")
        if (event.cause.eventIndex !== prior.lastIndex + 1) return fail(event, "duplicate or skipped v2 eventIndex")
        prior.lastIndex = event.cause.eventIndex
        prior.lastSeq = event.seq
      }
    }

    if (eventHashOf(event) !== event.hash) return fail(event, "hash mismatch")
    prev = event.hash
    previousTs = event.ts
    entityHeads.set(event.actor, event.hash)
  }
  return { valid: true, events: events.length }
}
