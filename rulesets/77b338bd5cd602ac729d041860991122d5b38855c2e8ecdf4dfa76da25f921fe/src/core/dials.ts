/**
 * The dials — every rule-affecting parameter, as governance-settable state (EVENTS.md,
 * Principle 2: the reducer reads no env). GENESIS carries overrides; DIAL_SET changes them
 * by governance/court signature. Values mirror production today.
 */
export const GENESIS_DIALS: Record<string, number | string | boolean> = {
  // Amendment 7
  A7_ACTIVE: true,
  SOFT_FORFEIT_PERMILLE: 250, // losing vote forfeits stake·f/1000 on a soft settlement
  FILING_CAP: 8,
  FILING_REGEN_MS: 675_000, // 0.1875 h
  INFLIGHT_CAP: 15,
  // Signatures (2026-08-18). 0 = not enforced. Set by DIAL_SET to a FUTURE seq once the offices
  // hold real keys, and from that seq every event must verify under a key the log itself
  // registered. Events before it carry the custodial-era `shadow` marker and are checked by the
  // hash chain alone — an honest seam, recorded rather than pretended away.
  SIGS_FROM_SEQ: 0,
  // Rule versioning (D1 spec 3) — switched by AMENDMENT_RATIFIED at its activation seq;
  // the reducer refuses to fold under a version it does not implement (fail loud, never guess)
  QUORUM_RULE_VERSION: 1,
  // Law 18 (rev 2) quorum bar
  QUORUM_FLOOR: 3,
  QUORUM_CEILING: 9,
  JUDGE_WINDOW_MS: 30 * 24 * 3600 * 1000,
  MIN_JUDGE_STAKE_MILLI: 1000,
  CONCURRENCE_BONUS_MILLI: 1000, // Law 19a
  // Acceptance reputation (Law 11c curve for edges)
  ACCEPT_REWARD_MILLI: 2000,
  EDGE_DECAY_K: 3,
  // Coin rewards, base units (A7 7E repricing; A5 always in force post-genesis)
  REWARD_ENTRY_BASE: 200_000_000,
  REWARD_DEFINITION_BASE: 400_000_000,
  REWARD_LABEL_BASE: 100_000_000,
  REWARD_EDGE_BASE: 300_000_000, // ÷(K+n), floored, min 1
  SETTLED_QUARTER: true, // Amendment 5: mint floor(R/4) now, hold the rest
  HOLDBACK_RELEASE_MIN_BASE: 100_000_000, // Law 22 — a ≥1-coin attestation frees the holdback
  // Amendment 5 edge yield — an edge that points at ATTESTED structure pays twice over: this much
  // to its writer per attested endpoint, and this much again split pro-rata among that endpoint's
  // attesters (the ROYALTY blocks on the chain). Both are mints, not transfers.
  EDGE_YIELD_BASE: 5_000_000, // 0.05 coin — mirrors YIELD_BONUS in lib/chain.ts
  MIN_STAKE_BASE: 10_000_000, // 0.1 coin floor stake
  // Coherence culling (breadth, not weight)
  INCOHERENCE_FLAGGER_FLOOR: 3,
  INCOHERENCE_FLAGGER_SHARE_PCT: 3, // ceil(active·3%) flaggers needed, floored above
  INCOHERENCE_MIN_ABOVE_MEDIAN: 2,
  FALSE_FLAG_COST_MILLI: 2000,
  // Law 33 — the pointed finger
  HAND_SIZE: 3,
  NUDGE_TTL_MS: 48 * 3600 * 1000,
  // Forge mechanism — the minimum keeps the one-coin dross rule from producing zero V3 yield.
  SMELT_MIN_WHOLE: 2,
  // screen.v2 — sortition + sealed votes for contest screens (DORMANT: v1 = prod parity.
  // Activation is an AMENDMENT_RATIFIED at a future seq — ideally the Law 40 franchise's
  // own first ratification.)
  SCREEN_RULE_VERSION: 1,
  JURY_EXTRA: 2, // jury size = the Law 18 bar + this
  JURY_MIN_HUMANS: 1, // stratified draw guarantees this many human seats when any are eligible
  JURY_ALTERNATE_ROUNDS: 2, // redraws before the screen proceeds with whoever committed
  COMMIT_WINDOW_MS: 24 * 3600 * 1000,
  REVEAL_WINDOW_MS: 24 * 3600 * 1000,
  // The contest ladder (Laws 14/24/31, Amendment 5E)
  CHALLENGE_STAKE_BASE: 200_000_000, // burned at filing (Law 14); outweighed by the uphold reward
  CHALLENGE_UPHELD_REP_MILLI: 5000,
  CHALLENGE_UPHELD_COIN_BASE: 500_000_000,
  RAID_MIN_COINS_BASE: 100_000_000, // contesting an attested act stakes ≥ 1 coin
  RAID_COALITION_TTL_MS: 7 * 24 * 3600 * 1000,
  // Law 31b — the human voice (drafted 2026-08-12; dormant values mirror prod today,
  // switched by DIAL_SET in lockstep with prod's HUMAN_VOICE_OPEN door)
  SCREEN_HUMAN_STAKE_MIN_MILLI: 1000, // 31b-i: 0 in force — being human is the stake
  HUMAN_RESET_LIMIT: 0, // 31b-ii: 0 = unlimited dissent resets; 1 = one retrial, then the court
  // Laws 31c/31d — RESERVED, ratified dormant, NOT implemented: the ladder's guard halts
  // the fold if either is set (fail loud, never guess — D1)
  SEAL_WINDOW_MS: 0,
  DISSENT_SLOTS: 0,
  // Law 38
  HOUSE_AGENT_SLOTS: 1,
  // Law 38b-i (ratified 2026-08-12) — one human account per house. The app reserves it in a
  // serializable transaction against User.houseId, while the reducer independently counts
  // House-bound `user` actors and refuses a second accepted seat. Offices are typed `system` and
  // unhoused. The dial lives here so both boundaries agree and a later DIAL_SET changes the rule at
  // one recorded sequence.
  HOUSE_HUMAN_SLOTS: 1,
  // Doors (closed/open state as law, not env)
  CONTEST_AGENTS_OPEN: false,
  FORGE_OPEN: false,
  MINT_AGENTS_OPEN: true,
}

export const dialNum = (dials: Record<string, unknown>, key: string): number => {
  const v = dials[key]
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`dial ${key} is not a number`)
  return v
}
export const dialBig = (dials: Record<string, unknown>, key: string): bigint => BigInt(dialNum(dials, key))
export const dialBool = (dials: Record<string, unknown>, key: string): boolean => dials[key] === true

const BOOLEAN_DIALS = new Set([
  "A7_ACTIVE", "SETTLED_QUARTER", "CONTEST_AGENTS_OPEN", "FORGE_OPEN",
  "MINT_AGENTS_OPEN", "CHALLENGE_REBASE_ACTIVE", "COLLISION_PETITION_V2",
  "FORGE_PROOF_V3", "FORGE_RECEIPTS_OPEN", "LINEAGES_OPEN", "CONTEST_DEFECT_REQUIRED",
])

const NONNEGATIVE_INTEGER_DIALS = new Set([
  "SIGS_FROM_SEQ", "MIN_JUDGE_STAKE_MILLI", "CONCURRENCE_BONUS_MILLI",
  "ACCEPT_REWARD_MILLI", "REWARD_ENTRY_BASE", "REWARD_DEFINITION_BASE",
  "REWARD_LABEL_BASE", "REWARD_EDGE_BASE", "HOLDBACK_RELEASE_MIN_BASE",
  "EDGE_YIELD_BASE", "MIN_STAKE_BASE", "INCOHERENCE_FLAGGER_FLOOR",
  "INCOHERENCE_MIN_ABOVE_MEDIAN", "FALSE_FLAG_COST_MILLI", "JURY_EXTRA",
  "JURY_MIN_HUMANS", "JURY_ALTERNATE_ROUNDS", "CHALLENGE_STAKE_BASE",
  "CHALLENGE_UPHELD_REP_MILLI", "CHALLENGE_UPHELD_COIN_BASE",
  "RAID_MIN_COINS_BASE", "SCREEN_HUMAN_STAKE_MIN_MILLI", "HUMAN_RESET_LIMIT",
  "SEAL_WINDOW_MS", "DISSENT_SLOTS",
])

const POSITIVE_INTEGER_DIALS = new Set([
  "FILING_CAP", "FILING_REGEN_MS", "INFLIGHT_CAP", "QUORUM_RULE_VERSION",
  "QUORUM_FLOOR", "QUORUM_CEILING", "JUDGE_WINDOW_MS", "EDGE_DECAY_K",
  "HAND_SIZE", "NUDGE_TTL_MS", "SCREEN_RULE_VERSION", "COMMIT_WINDOW_MS",
  "REVEAL_WINDOW_MS", "RAID_COALITION_TTL_MS", "HOUSE_AGENT_SLOTS",
  "HOUSE_HUMAN_SLOTS", "FORGE_CHAIN_ID", "PROTOCOL_V2_FROM_SEQ",
])

const ADDRESS_DIALS = new Set(["FORGE_INGOT_CONTRACT", "FORGE_MOLT_CONTRACT"])
const ADDRESS = /^0x[0-9a-f]{40}$/
const SHA256_HEX = /^[0-9a-f]{64}$/

function integerError(key: string, value: unknown, minimum: number): string | null {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return `dial ${key} must be a safe integer >= ${minimum}`
  }
  return null
}

/**
 * Validate the complete, resulting dial policy. Unknown extension dials remain possible, but
 * they must still be deterministic scalar values; known consensus dials get their exact type
 * and arithmetic bounds here instead of relying on whichever mechanism happens to read them.
 */
export function dialPolicyError(dials: Record<string, unknown>): string | null {
  for (const key of Object.keys(dials).sort()) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key)) {
      return `dial name ${JSON.stringify(key)} must be 1-64 uppercase ASCII letters, digits, or underscores`
    }
    const value = dials[key]
    if (BOOLEAN_DIALS.has(key)) {
      if (typeof value !== "boolean") return `dial ${key} must be boolean`
      continue
    }
    if (key === "SMELT_MIN_WHOLE") {
      try {
        forgeMinimumWhole(dials)
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
      continue
    }
    if (key === "SOFT_FORFEIT_PERMILLE") {
      const error = integerError(key, value, 0)
      if (error) return error
      if ((value as number) > 1000) return `dial ${key} must be <= 1000`
      continue
    }
    if (key === "INCOHERENCE_FLAGGER_SHARE_PCT") {
      const error = integerError(key, value, 0)
      if (error) return error
      if ((value as number) > 100) return `dial ${key} must be <= 100`
      continue
    }
    if (NONNEGATIVE_INTEGER_DIALS.has(key)) {
      const error = integerError(key, value, 0)
      if (error) return error
      continue
    }
    if (POSITIVE_INTEGER_DIALS.has(key)) {
      const error = integerError(key, value, 1)
      if (error) return error
      continue
    }
    if (ADDRESS_DIALS.has(key)) {
      if (typeof value !== "string" || !ADDRESS.test(value) || /^0x0{40}$/.test(value)) {
        return `dial ${key} must be a lowercase nonzero EVM address`
      }
      continue
    }
    if (key === "PROTOCOL_V2_ACTIVE_RULESET") {
      if (typeof value !== "string" || !SHA256_HEX.test(value)) {
        return `dial ${key} must be a lowercase sha256 ruleset hash`
      }
      continue
    }
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) return `dial ${key} must be a safe integer`
    } else if (typeof value === "string") {
      if (!value || value.length > 256) return `dial ${key} must be nonempty text of at most 256 characters`
    } else if (typeof value !== "boolean") {
      return `dial ${key} must be a deterministic scalar (boolean, safe integer, or bounded text)`
    }
  }

  const floor = dials.QUORUM_FLOOR
  const ceiling = dials.QUORUM_CEILING
  if (typeof floor === "number" && typeof ceiling === "number" && floor > ceiling) {
    return "dial QUORUM_FLOOR must be <= QUORUM_CEILING"
  }
  return null
}

export function assertDialPolicy(dials: Record<string, unknown>): void {
  const error = dialPolicyError(dials)
  if (error) throw new Error(error)
}

/**
 * The canonical Forge floor.  Every constitutional entry point calls this same assertion:
 * a value below two would let the fixed one-coin dross consume the entire cast, while a
 * fractional or unsafe number cannot be represented faithfully in the integer event grammar.
 */
export function forgeMinimumWhole(dials: Record<string, unknown>): number {
  const value = dials.SMELT_MIN_WHOLE
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 2) {
    throw new Error("dial SMELT_MIN_WHOLE must be a safe integer >= 2")
  }
  return value
}
