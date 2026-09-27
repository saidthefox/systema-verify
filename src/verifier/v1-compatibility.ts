import type { AnyEventEnvelope } from "../core/types"
import type {
  ExecutionResolverV1,
  ResolvedExecutionV1,
  V1ExecutionCommitment,
} from "../core/verify"
import {
  createRetainedExecutionResolverV1,
  type RetainedExecutionResolverV1,
} from "./ruleset-resolver"

/**
 * Protocol v1 did not put a ruleset hash in each event. These profiles make the narrower claim
 * we can actually prove: one immutable executor reproduces an exact, genesis-rooted v1 prefix
 * to an independently recorded handoff-state commitment. They are not retroactive evidence that
 * this was the unrecorded source originally running at every v1 sequence.
 */
export const RETAINED_V1_EXECUTOR_HASH =
  "b4345092bce3a3e1294acfa73ee2e4d7637f80b6e92af7d2f9fa8faf563462e7"

export const PROD_V1_COMPATIBILITY: V1ExecutionCommitment = Object.freeze({
  profile: "systema.protocol-v1.prod-retained-reproduction.v1",
  claim: "compatibility-reproduction",
  rulesetHash: RETAINED_V1_EXECUTOR_HASH,
  recordGenesisHash: "1a5bbf1d05ba66b8852ef746654a907428f6ad29a7ad8ccb018bd7df17b52a0b",
  through: Object.freeze({
    seq: 3285,
    hash: "47b4362aed112b5ebf377ab312d523d419e35dc7bf5ceef2adaf496ca8eeef29",
    stateHashV: 2,
    stateHash: "a6b42005cb27b2defe730385d5dee1c3587c36ac5633ae8c2b46d6e541815d2a",
  }),
})

export const STAGING_V1_COMPATIBILITY: V1ExecutionCommitment = Object.freeze({
  profile: "systema.protocol-v1.staging-retained-reproduction.v1",
  claim: "compatibility-reproduction",
  rulesetHash: RETAINED_V1_EXECUTOR_HASH,
  recordGenesisHash: "8e6464aee7a9f9a0219618e41ac1f95574fe65657d50f3d9aca6d4672787f3c7",
  through: Object.freeze({
    seq: 80938,
    hash: "67af2f06582d57862925b1a1f9f0a8f99cde118b8d4e21836508bc51d4a61a44",
    stateHashV: 2,
    stateHash: "5f9e79586f144477fcfc608691b718a0272a985a56e3bec0756e572d696a0f72",
  }),
})

export const RETAINED_V1_COMPATIBILITIES: readonly V1ExecutionCommitment[] = Object.freeze([
  PROD_V1_COMPATIBILITY,
  STAGING_V1_COMPATIBILITY,
])

const SHA256 = /^[0-9a-f]{64}$/

function copyCommitment(commitment: V1ExecutionCommitment): V1ExecutionCommitment {
  return { ...commitment, through: { ...commitment.through } }
}

function assertCommitmentShape(commitment: V1ExecutionCommitment): void {
  if (!commitment.profile || commitment.profile.trim() !== commitment.profile ||
      !["compatibility-reproduction", "explicit-bootstrap"].includes(commitment.claim) ||
      !SHA256.test(commitment.rulesetHash) || !SHA256.test(commitment.recordGenesisHash) ||
      !Number.isSafeInteger(commitment.through?.seq) || commitment.through.seq < 0 ||
      !SHA256.test(commitment.through?.hash) || commitment.through.stateHashV !== 2 ||
      !SHA256.test(commitment.through?.stateHash)) {
    throw new Error(`invalid protocol-v1 execution commitment: ${commitment.profile || "unnamed"}`)
  }
}

function exactV1Head(events: readonly AnyEventEnvelope[]): AnyEventEnvelope | undefined {
  const firstV2 = events.findIndex(event => "protocol" in event && event.protocol === 2)
  return events[(firstV2 < 0 ? events.length : firstV2) - 1]
}

/**
 * Build the record-level selector around an artifact-level resolver. Known Systema genesis
 * hashes fail closed on a shortened, extended, or different v1 handoff. An unknown genesis is
 * accepted only when the caller explicitly supplied a complete bootstrap commitment for it.
 */
export function createV1CompatibilityResolver(
  resolveArtifact: RetainedExecutionResolverV1,
  additionalCommitments: readonly V1ExecutionCommitment[] = [],
): ExecutionResolverV1 {
  const commitments = [
    ...RETAINED_V1_COMPATIBILITIES.map(copyCommitment),
    ...additionalCommitments.map(copyCommitment),
  ]
  for (const commitment of commitments) assertCommitmentShape(commitment)
  const genesisRoster = new Set<string>()
  for (const commitment of commitments) {
    if (genesisRoster.has(commitment.recordGenesisHash)) {
      throw new Error(`multiple protocol-v1 commitments select genesis ${commitment.recordGenesisHash}`)
    }
    genesisRoster.add(commitment.recordGenesisHash)
  }

  return async events => {
    const genesis = events[0]
    if (!genesis) return null
    const commitment = commitments.find(candidate => candidate.recordGenesisHash === genesis.hash)
    if (!commitment) return null
    const head = exactV1Head(events)
    if (!head || head.seq !== commitment.through.seq || head.hash !== commitment.through.hash) {
      throw new Error(
        `record ${commitment.recordGenesisHash} does not reach its exact committed v1 handoff ` +
        `${commitment.through.seq}:${commitment.through.hash}`,
      )
    }
    const retained = await resolveArtifact(commitment.rulesetHash)
    if (!retained) throw new Error(`protocol-v1 ruleset artifact unavailable: ${commitment.rulesetHash}`)
    return {
      commitment: copyCommitment(commitment),
      initState: retained.initState,
      admitFactV1: retained.admitFactV1,
      evolveFactV1: retained.evolveFactV1,
    } satisfies ResolvedExecutionV1
  }
}

export function createRetainedV1CompatibilityResolver(
  rulesetRoot: string,
  additionalCommitments: readonly V1ExecutionCommitment[] = [],
): ExecutionResolverV1 {
  return createV1CompatibilityResolver(
    createRetainedExecutionResolverV1(rulesetRoot),
    additionalCommitments,
  )
}

const BOOTSTRAP_ENV = {
  rulesetHash: "SYSTEMA_V1_BOOTSTRAP_RULESET_HASH",
  genesisHash: "SYSTEMA_V1_BOOTSTRAP_GENESIS_HASH",
  throughSeq: "SYSTEMA_V1_BOOTSTRAP_THROUGH_SEQ",
  throughHash: "SYSTEMA_V1_BOOTSTRAP_THROUGH_HASH",
  stateHash: "SYSTEMA_V1_BOOTSTRAP_STATE_HASH",
} as const

/**
 * Read an all-or-nothing, operator-supplied binding for a new realm. The executor is still loaded
 * from a content-addressed artifact; these values only bind that code to the new record's exact
 * v1 handoff. Nothing silently selects mutable current source.
 */
export function v1BootstrapCommitmentFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): V1ExecutionCommitment | null {
  const values = Object.values(BOOTSTRAP_ENV).map(key => env[key])
  if (values.every(value => value === undefined || value === "")) return null
  if (values.some(value => value === undefined || value === "")) {
    throw new Error(`protocol-v1 bootstrap binding is incomplete; set all of ${Object.values(BOOTSTRAP_ENV).join(", ")}`)
  }
  const [rulesetHash, recordGenesisHash, seqText, hash, stateHash] = values as string[]
  if (!/^(?:0|[1-9][0-9]*)$/.test(seqText) || !Number.isSafeInteger(Number(seqText))) {
    throw new Error(`${BOOTSTRAP_ENV.throughSeq} must be a non-negative safe integer`)
  }
  const commitment: V1ExecutionCommitment = {
    profile: "systema.protocol-v1.explicit-bootstrap.v1",
    claim: "explicit-bootstrap",
    rulesetHash,
    recordGenesisHash,
    through: { seq: Number(seqText), hash, stateHashV: 2, stateHash },
  }
  assertCommitmentShape(commitment)
  if (RETAINED_V1_COMPATIBILITIES.some(profile => profile.recordGenesisHash === recordGenesisHash)) {
    throw new Error("an explicit bootstrap binding cannot override a retained Systema compatibility profile")
  }
  return commitment
}
