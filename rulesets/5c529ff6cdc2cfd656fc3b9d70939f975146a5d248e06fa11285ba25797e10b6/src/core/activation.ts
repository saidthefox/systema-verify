import type { CoreState } from "./types"

export const PROTOCOL_V2_FROM_SEQ = "PROTOCOL_V2_FROM_SEQ"

/** Absent means the historical v1 era. Never add this scalar to GENESIS_DIALS: backfilling a
 * zero into old states would change every pre-activation state hash. */
export function protocolV2FromSeq(state: Pick<CoreState, "dials">): number {
  const raw = state.dials[PROTOCOL_V2_FROM_SEQ]
  if (raw === undefined) return 0
  if (!Number.isSafeInteger(raw) || (raw as number) < 1) {
    throw new Error(`dial ${PROTOCOL_V2_FROM_SEQ} must be absent or a positive safe integer`)
  }
  return raw as number
}

export function protocolAtSeq(stateBefore: Pick<CoreState, "dials">, seq: number): 1 | 2 {
  const from = protocolV2FromSeq(stateBefore)
  return from > 0 && seq >= from ? 2 : 1
}

export function protocolForNextCommand(state: Pick<CoreState, "seq" | "dials">): 1 | 2 {
  return protocolAtSeq(state, state.seq + 1)
}

/** The activation boundary is scheduled once, by governance, strictly after its own v1 fact. */
export function protocolActivationDialError(
  state: Pick<CoreState, "seq" | "dials" | "keys">,
  actor: string,
  value: unknown,
): string | null {
  if (actor !== state.keys.governance) return `${PROTOCOL_V2_FROM_SEQ} requires the governance key`
  if (!Number.isSafeInteger(value) || (value as number) < 1) return `${PROTOCOL_V2_FROM_SEQ} must be a positive safe integer`
  const existing = protocolV2FromSeq(state)
  if (existing) return `${PROTOCOL_V2_FROM_SEQ} is already fixed at seq ${existing}`
  if ((value as number) <= state.seq + 1) {
    return `${PROTOCOL_V2_FROM_SEQ} must be after the DIAL_SET event that schedules it`
  }
  return null
}
