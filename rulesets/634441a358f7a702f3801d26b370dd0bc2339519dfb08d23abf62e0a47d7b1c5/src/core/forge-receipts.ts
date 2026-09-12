import { COIN_SCALE, type EventEnvelope, type IngotForgeReceipt, type IngotMeltReceipt, type CoreState } from "./types"
import { dialBool } from "./dials"

export const FORGE_RECEIPTS_OPEN = "FORGE_RECEIPTS_OPEN"
/** One-way activation: future SMELTs must commit the lowercase nonzero EVM recipient that V3
 * verifiers place in the claim leaf. Absent is the historical V2 behavior. */
export const FORGE_PROOF_V3 = "FORGE_PROOF_V3"
export const FORGE_CHAIN_ID = "FORGE_CHAIN_ID"
export const FORGE_INGOT_CONTRACT = "FORGE_INGOT_CONTRACT"
export const FORGE_MOLT_CONTRACT = "FORGE_MOLT_CONTRACT"

const HEX32 = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const UINT = /^(0|[1-9][0-9]*)$/
const MAX_PROJECTED_TOKEN_ID = 2_147_483_647n // V2: Prisma/Postgres `serial` is a signed Int

const text = (p: Record<string, unknown>, key: string): string | null =>
  typeof p[key] === "string" && (p[key] as string).length > 0 ? p[key] as string : null

const uint = (p: Record<string, unknown>, key: string, allowZero = false): bigint | null => {
  const value = text(p, key)
  if (!value || !UINT.test(value)) return null
  const parsed = BigInt(value)
  return allowZero || parsed > 0n ? parsed : null
}

const exactKeys = (p: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(p).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, i) => key === expected[i])
}

const FORGED_KEYS = [
  "ingotId", "chainId", "contract", "txHash", "blockNumber", "blockHash", "logIndex",
  "tokenId", "to", "sourceEventSeq", "sourceEventHash", "manifestHash", "rulesetHash",
  "consumedBase", "yieldBase", "drossBase", "pinSeq", "pinDigest", "sourceId",
] as const

const MELTED_KEYS = [
  "ingotId", "chainId", "contract", "moltContract", "txHash", "blockNumber", "blockHash",
  "ingotLogIndex", "moltLogIndex", "tokenId", "by", "sourceId", "yieldBase",
  "manifestHash", "moltAmount",
] as const

function configuredRealm(state: CoreState): { chainId: string; ingot: string; molt: string } | string {
  if (!dialBool(state.dials, FORGE_RECEIPTS_OPEN)) return "external forge receipts are not open (dial)"
  const chain = state.dials[FORGE_CHAIN_ID]
  const ingot = state.dials[FORGE_INGOT_CONTRACT]
  const molt = state.dials[FORGE_MOLT_CONTRACT]
  if (typeof chain !== "number" || !Number.isSafeInteger(chain) || chain <= 0) return `${FORGE_CHAIN_ID} is not configured`
  if (typeof ingot !== "string" || !ADDRESS.test(ingot)) return `${FORGE_INGOT_CONTRACT} is not configured as a lowercase address`
  if (typeof molt !== "string" || !ADDRESS.test(molt)) return `${FORGE_MOLT_CONTRACT} is not configured as a lowercase address`
  return { chainId: String(chain), ingot, molt }
}

function duplicateReceipt(state: CoreState, txHash: string, logIndexes: string[]): boolean {
  for (const ingot of Object.values(state.ingots)) {
    if (ingot.forge?.txHash === txHash && logIndexes.includes(ingot.forge.logIndex)) return true
    if (ingot.melt?.txHash === txHash &&
      (logIndexes.includes(ingot.melt.ingotLogIndex) || logIndexes.includes(ingot.melt.moltLogIndex))) return true
  }
  return false
}

export function ingotStatus(ingot: CoreState["ingots"][string]): "SMELTED" | "FORGED" | "MELTED" {
  return ingot.melt ? "MELTED" : ingot.forge ? "FORGED" : "SMELTED"
}

export function validateIngotForged(state: CoreState, event: Pick<EventEnvelope, "actor" | "payload">): string | null {
  if (event.actor !== state.keys.court) return "INGOT_FORGED requires the court receipt key"
  const realm = configuredRealm(state)
  if (typeof realm === "string") return realm
  const p = event.payload
  if (!exactKeys(p, FORGED_KEYS)) return "INGOT_FORGED payload has missing or unknown fields"

  const ingotId = text(p, "ingotId")
  const sourceSeq = uint(p, "sourceEventSeq")
  const pinSeq = uint(p, "pinSeq")
  const tokenId = uint(p, "tokenId")
  const consumed = uint(p, "consumedBase")
  const yieldBase = uint(p, "yieldBase")
  const drossBase = uint(p, "drossBase")
  const logIndex = uint(p, "logIndex", true)
  if (!ingotId || !sourceSeq || !pinSeq || !tokenId || !consumed || !yieldBase || !drossBase || logIndex === null) {
    return "INGOT_FORGED requires canonical positive decimal quantities (logIndex may be zero)"
  }
  if (ingotId !== `ingot:${sourceSeq}`) return "ingotId must name the source SMELT sequence"
  const proofV3 = dialBool(state.dials, FORGE_PROOF_V3)
  if (proofV3 && tokenId !== sourceSeq) return "V3 tokenId must equal the canonical source SMELT sequence"
  if (!proofV3 && tokenId > MAX_PROJECTED_TOKEN_ID) return "tokenId exceeds the projected serial boundary"
  if (text(p, "chainId") !== realm.chainId || text(p, "contract") !== realm.ingot) return "receipt belongs to a different configured chain or Ingot contract"
  for (const key of ["txHash", "blockHash", "sourceEventHash", "manifestHash", "rulesetHash", "pinDigest", "sourceId"] as const) {
    if (!HEX32.test(text(p, key) ?? "")) return `${key} must be lowercase 0x-prefixed bytes32`
  }
  if (!ADDRESS.test(text(p, "to") ?? "")) return "to must be a lowercase address"
  if (uint(p, "blockNumber") === null) return "blockNumber must be a positive decimal string"
  if (pinSeq < sourceSeq) return "checkpoint does not cover the source SMELT"
  if (consumed !== yieldBase + drossBase) return "receipt amounts do not conserve"

  const ingot = state.ingots[ingotId]
  if (!ingot) return "source SMELT is not in the record"
  if (ingotStatus(ingot) !== "SMELTED") return `ingot is already ${ingotStatus(ingot)}`
  if (ingot.claimTo && text(p, "to") !== ingot.claimTo) return "receipt recipient disagrees with the source SMELT"
  if (yieldBase !== BigInt(ingot.yieldWhole) * COIN_SCALE || drossBase !== BigInt(ingot.drossWhole) * COIN_SCALE) {
    return "receipt amounts disagree with the source SMELT"
  }
  const txHash = text(p, "txHash")!
  if (duplicateReceipt(state, txHash, [String(logIndex)])) return "that chain log was already admitted"
  for (const other of Object.values(state.ingots)) {
    if (other.forge?.chainId === realm.chainId && other.forge.contract === realm.ingot && other.forge.tokenId === String(tokenId)) {
      return "that chain token is already bound to another ingot"
    }
    if (other.forge?.sourceId === text(p, "sourceId")) return "that on-chain sourceId is already admitted"
  }
  return null
}

export function validateIngotMelted(state: CoreState, event: Pick<EventEnvelope, "actor" | "payload">): string | null {
  if (event.actor !== state.keys.court) return "INGOT_MELTED requires the court receipt key"
  const realm = configuredRealm(state)
  if (typeof realm === "string") return realm
  const p = event.payload
  if (!exactKeys(p, MELTED_KEYS)) return "INGOT_MELTED payload has missing or unknown fields"
  const ingotId = text(p, "ingotId")
  const tokenId = uint(p, "tokenId")
  const yieldBase = uint(p, "yieldBase")
  const moltAmount = uint(p, "moltAmount")
  const ingotLogIndex = uint(p, "ingotLogIndex", true)
  const moltLogIndex = uint(p, "moltLogIndex", true)
  if (!ingotId || !tokenId || !yieldBase || !moltAmount || ingotLogIndex === null || moltLogIndex === null) {
    return "INGOT_MELTED requires canonical positive decimal quantities (log indexes may be zero)"
  }
  if (ingotLogIndex === moltLogIndex) return "melt and pour must be distinct logs"
  if (text(p, "chainId") !== realm.chainId || text(p, "contract") !== realm.ingot || text(p, "moltContract") !== realm.molt) {
    return "receipt belongs to a different configured chain or contract pair"
  }
  for (const key of ["txHash", "blockHash", "sourceId", "manifestHash"] as const) {
    if (!HEX32.test(text(p, key) ?? "")) return `${key} must be lowercase 0x-prefixed bytes32`
  }
  if (!ADDRESS.test(text(p, "by") ?? "")) return "by must be a lowercase address"
  if (uint(p, "blockNumber") === null) return "blockNumber must be a positive decimal string"
  const ingot = state.ingots[ingotId]
  if (!ingot) return "source ingot is not in the record"
  if (ingotStatus(ingot) !== "FORGED" || !ingot.forge) return `ingot is ${ingotStatus(ingot)}, not FORGED`
  if (String(tokenId) !== ingot.forge.tokenId || text(p, "sourceId") !== ingot.forge.sourceId ||
    text(p, "manifestHash") !== ingot.forge.manifestHash || String(yieldBase) !== ingot.forge.yieldBase) {
    return "melt receipt disagrees with the admitted forge receipt"
  }
  if (moltAmount !== yieldBase * 10_000_000_000n) return "MOLT amount does not exactly scale the ingot yield"
  const txHash = text(p, "txHash")!
  if (duplicateReceipt(state, txHash, [String(ingotLogIndex), String(moltLogIndex)])) return "that chain log was already admitted"
  return null
}

export function applyIngotForged(state: CoreState, payload: Record<string, unknown>) {
  const ingot = state.ingots[text(payload, "ingotId")!]
  const { ingotId, ...receipt } = payload as unknown as IngotForgeReceipt & { ingotId: string }
  if (ingotId !== ingot.id) throw new Error("validated forge receipt lost its ingot binding")
  ingot.forge = receipt
}

export function applyIngotMelted(state: CoreState, payload: Record<string, unknown>) {
  const ingot = state.ingots[text(payload, "ingotId")!]
  const { ingotId, ...receipt } = payload as unknown as IngotMeltReceipt & { ingotId: string }
  if (ingotId !== ingot.id) throw new Error("validated melt receipt lost its ingot binding")
  ingot.melt = receipt
}
