/**
 * systema-core — the pure kernel (DECOSTUME Phase 1).
 *
 * Everything here is deterministic: no I/O, no env, no wall clock, no randomness.
 * The reducer is the rules; the log is the truth; projections are downstream.
 */
export * from "./types"
export { canonical, hashOf, sha256, ZERO64 } from "./canonical"
export { GENESIS_DIALS, dialBig, dialBool, dialNum } from "./dials"
export { quorumMinJudges, activeJudges, quorumCrossing, settleVotes, settleStakes, acceptanceRepMilli, coinRewardBase } from "./math"
export { initState, validate, applyEvent, evolveV1, fold, foldFacts, activatePending } from "./reducer"
export { LogSim, sigPayload } from "./sequencer"
export { INVARIANTS, checkInvariants } from "./invariants"
export { fingerprintOf, ed25519Verify, realVerifier, verifyLog, verifyStateReplay, verifyConstitutionalLog } from "./verify"
export {
  LEGACY_PROTOCOL_VERSION, NEXT_PROTOCOL_VERSION, protocolVersionOf, legacyEventDraft, decideV1,
  commandSignaturePayloadV2, commandIdentityV2, commandEnvelopeV2Error, eventEnvelopeV2Error,
  sealEventV2, eventHashOf, verifyEnvelopeChain,
} from "./protocol"
