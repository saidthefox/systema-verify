import { createHash } from "node:crypto"
import { canonical } from "./canonical"
import type { CoinAssayState } from "./coin-lots"
import type { AnyEventEnvelope, CoreState } from "./types"

export const INGOT_MANIFEST_SCHEMA = "systema.ingot-manifest.v2" as const

/**
 * Build the exact public provenance document for one canonical SMELT.
 *
 * This is deliberately pure over the record fold plus its deterministic coin-lot assay. The
 * database projector and the mechanical witness call the same named rule; neither may fill a
 * missing field from mutable database state or operator input.
 */
export function buildIngotManifest(
  state: CoreState,
  event: AnyEventEnvelope,
  coinAssay: CoinAssayState,
): { manifest: Record<string, unknown>; manifestJson: string; manifestHash: string } {
  if (event.kind !== "SMELT") throw new Error(`seq ${event.seq} is not a SMELT`)
  const cast = state.ingots[`ingot:${event.seq}`]
  if (!cast) throw new Error(`SMELT ingot:${event.seq} is absent from the folded state`)
  const assay = coinAssay.smelts[cast.id]
  if (!assay) throw new Error(`SMELT ${cast.id} has no exact deterministic coin-lot assay`)
  if (assay.entityFp !== cast.entityFp || assay.eventHash !== event.hash || assay.seq !== event.seq) {
    throw new Error(`SMELT ${cast.id} assay does not name the canonical cast`)
  }
  if (assay.consumedBase !== BigInt(cast.yieldWhole + cast.drossWhole) * 100_000_000n) {
    throw new Error(`SMELT ${cast.id} assay does not conserve its folded amount`)
  }

  const entityLabel = state.actors[cast.entityFp]?.label ?? cast.entityFp.slice(0, 12)
  const house = state.houses[cast.houseId]
  const houseFp = house?.keyFp ?? cast.houseId
  const houseLabel = house?.label ?? cast.houseId
  const smelted = cast.yieldWhole + cast.drossWhole
  const rulesetHash = "protocol" in event && event.protocol === 2
    ? event.cause.rulesetHash
    : "protocol-v1-retained-core"
  const manifest = {
    schema: INGOT_MANIFEST_SCHEMA,
    coins: cast.yieldWhole,
    smelted,
    dross: { coins: cast.drossWhole, law: "35c — one in ten, minimum one, burned to no one" },
    minedBy: { fingerprint: cast.entityFp, label: entityLabel },
    house: { fingerprint: houseFp, label: houseLabel },
    vintage: cast.ts,
    logAtSmelt: { seq: event.seq, eventHash: event.hash, rulesetHash },
    lotAccounting: {
      schema: coinAssay.schema,
      consumption: "LIFO",
      bedrockManifestHash: coinAssay.bedrockManifestHash,
      consumedBase: assay.consumedBase.toString(),
      fragments: assay.fragments.map(fragment => ({
        lotId: fragment.lotId,
        amountBase: fragment.amountBase.toString(),
        origin: fragment.origin,
      })),
    },
    burn: `SMELT at seq ${event.seq}`,
  }
  const manifestJson = canonical(manifest)
  return {
    manifest,
    manifestJson,
    manifestHash: createHash("sha256").update(manifestJson).digest("hex"),
  }
}
