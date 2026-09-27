import { createHash } from "node:crypto"
import { hashOf } from "../core/canonical"
import type { CoreState } from "../core/types"
import { stateFromJson } from "../record/codec"

export interface BedrockGenesisBinding {
  snapshot: CoreState | null
  failures: string[]
}

type GenesisSnapshotCommitment = {
  ts: string
  bytes: number
  sha256: string
  stateHash: string
}

const isCommitment = (value: unknown): value is GenesisSnapshotCommitment => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const source = value as Record<string, unknown>
  return typeof source.ts === "string" &&
    Number.isSafeInteger(source.bytes) && (source.bytes as number) >= 0 &&
    typeof source.sha256 === "string" &&
    typeof source.stateHash === "string"
}

/**
 * Bind the exact supplied sidecar to the genesis commitment inside the bedrock manifest.
 *
 * The manifest itself is committed by a governance ATTESTATION. Checking only the actors and
 * lot totals against whichever sidecar happened to be supplied left that attestation detached
 * from its source bytes. This check closes the chain in both representations: byte length and
 * SHA-256 bind the file, while `hashOf` binds the decoded state as it existed at the genesis cut.
 */
export function verifyBedrockGenesisBinding(
  commitment: unknown,
  snapshotBytes: Buffer,
): BedrockGenesisBinding {
  if (!isCommitment(commitment)) {
    return { snapshot: null, failures: ["bedrock manifest has an invalid genesis snapshot commitment"] }
  }

  const failures: string[] = []
  const actualSha256 = createHash("sha256").update(snapshotBytes).digest("hex")
  if (snapshotBytes.length !== commitment.bytes) {
    failures.push(`bedrock genesis byte length differs (manifest ${commitment.bytes}, supplied ${snapshotBytes.length})`)
  }
  if (actualSha256 !== commitment.sha256) {
    failures.push(`bedrock genesis SHA-256 differs (manifest ${commitment.sha256}, supplied ${actualSha256})`)
  }

  let snapshot: CoreState
  try {
    snapshot = stateFromJson(snapshotBytes.toString("utf8"))
  } catch (error) {
    failures.push(`bedrock genesis snapshot is not a valid CoreState (${error instanceof Error ? error.message : String(error)})`)
    return { snapshot: null, failures }
  }

  const actualStateHash = hashOf(snapshot)
  if (actualStateHash !== commitment.stateHash) {
    failures.push(`bedrock genesis state hash differs (manifest ${commitment.stateHash}, supplied ${actualStateHash})`)
  }
  if (snapshot.ts !== commitment.ts) {
    failures.push(`bedrock genesis timestamp differs (manifest ${commitment.ts}, supplied ${snapshot.ts})`)
  }
  return { snapshot, failures }
}
