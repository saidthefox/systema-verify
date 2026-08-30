/**
 * Deterministic coin-lot accounting.
 *
 * This is a pure projection over the constitutional record. It deliberately does not live in
 * CoreState: adding thousands of derived lots to that struct would rewrite historical state
 * hashes even though no historical fact changed. The assay can always be rebuilt from the
 * committed bedrock manifest plus the event stream.
 */

export const BEDROCK_SCHEMA = "systema.bedrock-provenance.v1" as const
export const BEDROCK_ATTESTATION_ID = "systema-bedrock-provenance-v1" as const
export const COIN_LOT_SCHEMA = "systema.coin-lots.v1" as const
export const LEGACY_BASE_UNIT_HEIGHT = 503

export interface ArchiveBlock {
  idx: number
  ts: string
  block_type: string
  act_type: string
  act_id: string
  act_hash: string
  fingerprint: string
  amount: number
  prev_hash: string
  hash: string
  entity_prev_hash: string | null
}

export interface BedrockLot {
  id: `bedrock:block:${number}`
  block: number
  blockHash: string
  ts: string
  actType: string
  actId: string
  actHash: string
  printedBase: string
  remainingBase: string
}

export interface BedrockEntity {
  fingerprint: string
  label: string
  entityType: string
  importedGenesisBalanceBase: string
  terminalMiniChainHead: { block: number; hash: string; ts: string } | null
  lots: BedrockLot[]
}

export interface BedrockManifest {
  schema: typeof BEDROCK_SCHEMA
  rule: {
    lotCreation: "every positive archive block prints one lot"
    consumption: "LIFO"
    legacyAmountScale: { beforeBlock: typeof LEGACY_BASE_UNIT_HEIGHT; multiplier: "100000000" }
  }
  source: {
    archive: {
      verify: { valid: true; height: number; entities: number }
      terminus: { block: number; hash: string; ts: string }
    }
    genesisSnapshot: { ts: string; bytes: number; sha256: string; stateHash: string }
    eventGenesis: { seq: 0; hash: string; ts: string }
  }
  seam: {
    archiveThrough: { block: number; hash: string; ts: string }
    nextArchiveBlock: { block: number; hash: string; ts: string } | null
    statement: string
  }
  entities: BedrockEntity[]
  reconciliation: {
    entityCount: number
    lotCount: number
    archiveLotsBalanceBase: string
    importedGenesisBalanceBase: string
    deltaBase: "0"
  }
}

export interface MutableLot {
  id: string
  printedBase: bigint
  remainingBase: bigint
  origin: { era: "bedrock"; block: number; blockHash: string } | { era: "event"; seq: number; effectIndex: number; eventHash: string; reason: string }
}

export interface LotFragment {
  lotId: string
  amountBase: bigint
  origin: MutableLot["origin"]
}

export interface SmeltAssay {
  ingotId: string
  seq: number
  eventHash: string
  entityFp: string
  consumedBase: bigint
  fragments: LotFragment[]
}

export interface CoinAssayState {
  schema: typeof COIN_LOT_SCHEMA
  bedrockManifestHash: string
  throughSeq: number
  stacks: Record<string, MutableLot[]>
  smelts: Record<string, SmeltAssay>
}

/** Convert an old-chain amount to current base units without using floating point. */
export function archiveAmountBase(block: Pick<ArchiveBlock, "idx" | "amount">): bigint {
  if (!Number.isSafeInteger(block.amount)) throw new Error(`archive block ${block.idx} has an unsafe non-integer amount`)
  const amount = BigInt(block.amount)
  return block.idx < LEGACY_BASE_UNIT_HEIGHT ? amount * 100_000_000n : amount
}

/** Amendment 9's exact retroactive lens, bounded at an explicit archive height. */
export function replayArchiveLots(blocks: readonly ArchiveBlock[], throughBlock: number): BedrockLot[] {
  const stack: BedrockLot[] = []
  for (const block of blocks) {
    if (block.idx > throughBlock) break
    const amount = archiveAmountBase(block)
    if (amount > 0n) {
      stack.push({
        id: `bedrock:block:${block.idx}`,
        block: block.idx,
        blockHash: block.hash,
        ts: block.ts,
        actType: block.act_type,
        actId: block.act_id,
        actHash: block.act_hash,
        printedBase: amount.toString(),
        remainingBase: amount.toString(),
      })
      continue
    }
    let need = -amount
    while (need > 0n) {
      const top = stack.at(-1)
      if (!top) throw new Error(`archive lot underflow at block ${block.idx}: missing ${need} base units`)
      const remaining = BigInt(top.remainingBase)
      const take = remaining < need ? remaining : need
      const next = remaining - take
      need -= take
      if (next === 0n) stack.pop()
      else top.remainingBase = next.toString()
    }
  }
  return stack
}

export const sumBedrockLots = (lots: readonly BedrockLot[]): bigint =>
  lots.reduce((sum, lot) => sum + BigInt(lot.remainingBase), 0n)

/** Consume current lots newest-first. The returned fragments are in consumption order. */
export function consumeLotsLifo(stack: MutableLot[], amountBase: bigint): LotFragment[] {
  if (amountBase < 0n) throw new Error("lot consumption amount must be non-negative")
  const consumed: LotFragment[] = []
  let need = amountBase
  while (need > 0n) {
    const top = stack.at(-1)
    if (!top) throw new Error(`coin lot underflow: missing ${need} base units`)
    const take = top.remainingBase < need ? top.remainingBase : need
    top.remainingBase -= take
    need -= take
    consumed.push({ lotId: top.id, amountBase: take, origin: top.origin })
    if (top.remainingBase === 0n) stack.pop()
  }
  return consumed
}

/** Seed the event-era assay from the externally committed, exactly reconciled manifest. */
export function initCoinAssay(manifest: BedrockManifest, bedrockManifestHash: string): CoinAssayState {
  if (manifest.schema !== BEDROCK_SCHEMA) throw new Error(`unsupported bedrock schema ${String(manifest.schema)}`)
  if (manifest.rule.consumption !== "LIFO") throw new Error("bedrock lot rule is not LIFO")
  if (manifest.reconciliation.deltaBase !== "0") throw new Error("bedrock manifest is not exactly reconciled")
  if (!/^[0-9a-f]{64}$/.test(bedrockManifestHash)) throw new Error("invalid bedrock manifest hash")
  const stacks: Record<string, MutableLot[]> = {}
  let total = 0n
  for (const entity of manifest.entities) {
    if (stacks[entity.fingerprint]) throw new Error(`duplicate bedrock entity ${entity.fingerprint}`)
    const stack = entity.lots.map(lot => ({
      id: lot.id,
      printedBase: BigInt(lot.printedBase),
      remainingBase: BigInt(lot.remainingBase),
      origin: { era: "bedrock" as const, block: lot.block, blockHash: lot.blockHash },
    }))
    const balance = stack.reduce((sum, lot) => sum + lot.remainingBase, 0n)
    if (balance !== BigInt(entity.importedGenesisBalanceBase)) {
      throw new Error(`${entity.fingerprint}: embedded bedrock lots do not match imported balance`)
    }
    total += balance
    stacks[entity.fingerprint] = stack
  }
  if (total !== BigInt(manifest.reconciliation.importedGenesisBalanceBase)) {
    throw new Error("embedded bedrock total does not match reconciliation total")
  }
  return { schema: COIN_LOT_SCHEMA, bedrockManifestHash, throughSeq: 0, stacks, smelts: {} }
}

type CoinFx =
  | { t: "coin-credit"; fp: string; amountBase: bigint; reason: string; ref?: string }
  | { t: "coin-debit"; fp: string; amountBase: bigint; reason: string; ref?: string }

type EffectLike = { t: string } & Record<string, unknown>
const isCoinFx = (fx: EffectLike): fx is EffectLike & CoinFx => fx.t === "coin-credit" || fx.t === "coin-debit"

/**
 * Fold one accepted event's economic trace. Effect indexes count coin effects only; adding a
 * projector-only status trace can therefore never rename a coin lot.
 */
export function applyCoinEffects(
  state: CoinAssayState,
  event: { seq: number; hash: string },
  effects: readonly EffectLike[],
): void {
  if (event.seq !== state.throughSeq + 1) {
    throw new Error(`coin assay expected seq ${state.throughSeq + 1}, got ${event.seq}`)
  }
  let effectIndex = 0
  for (const effect of effects) {
    if (!isCoinFx(effect)) continue
    if (effect.amountBase <= 0n) throw new Error(`seq ${event.seq} coin effect ${effectIndex} is not positive`)
    const stack = (state.stacks[effect.fp] ??= [])
    if (effect.t === "coin-credit") {
      const id = `event:${event.seq}:${effectIndex}`
      stack.push({
        id,
        printedBase: effect.amountBase,
        remainingBase: effect.amountBase,
        origin: { era: "event", seq: event.seq, effectIndex, eventHash: event.hash, reason: effect.reason },
      })
    } else {
      const fragments = consumeLotsLifo(stack, effect.amountBase)
      if (effect.reason === "SMELT") {
        const ingotId = effect.ref
        if (!ingotId?.startsWith("ingot:")) throw new Error(`seq ${event.seq} SMELT has no ingot reference`)
        if (state.smelts[ingotId]) throw new Error(`duplicate smelt assay ${ingotId}`)
        state.smelts[ingotId] = {
          ingotId,
          seq: event.seq,
          eventHash: event.hash,
          entityFp: effect.fp,
          consumedBase: effect.amountBase,
          fragments,
        }
      }
    }
    effectIndex++
  }
  state.throughSeq = event.seq
}

export const assayBalance = (state: CoinAssayState, fp: string): bigint =>
  (state.stacks[fp] ?? []).reduce((sum, lot) => sum + lot.remainingBase, 0n)

/** Prove the assay and constitutional actor balances still describe the same spendable coins. */
export function assertAssayBalances(state: CoinAssayState, actors: Record<string, { balanceBase: bigint }>): void {
  const fps = new Set([...Object.keys(state.stacks), ...Object.keys(actors)])
  for (const fp of [...fps].sort()) {
    const assay = assayBalance(state, fp)
    const balance = actors[fp]?.balanceBase ?? 0n
    if (assay !== balance) throw new Error(`coin assay drift for ${fp}: lots ${assay}, actor ${balance}`)
  }
}
