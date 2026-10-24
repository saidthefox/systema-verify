import type { ActState, Challenge, CoreState, EventEnvelope, Raid, ScreenV2 } from "./types"
import { EDGE_TYPES, RAID_LIVE, RETIRED_EDGE_TYPES, isDead, targetKey, claimName, nameHolders, retiredEdgeTypeError } from "./types"
import { nameShapeErrorV16, sha256 } from "./canonical"
import { nameNorm } from "./names"
import { LIMITS, firstTooLong } from "./limits"
import { CORRECT_AWARD_BASE, CORRECT_AWARD_REP_MILLI, amendment16Version, amendment17Version, amendment18Version, dialBig, dialBool, dialNum, dialNumOr, payoffRuleVersion } from "./dials"
import {
  CORRECT_UPHELD, CORRECT_UPHELD_REFUND, correctionPartsFor, correctionValueError, definitionPartHashes, entryPartHashes,
  partHash, restoresReplacedValue, standingPartHash,
} from "./corrections"
import type { CorrectionPart, PartHashes } from "./types"
import { activeJudges, lineageOnlyAgentFps, quorumCrossing, quorumMinJudges } from "./math"
import { acceptedDefinitionHead, definitionPartsA17, examplesError, nextDefinitionVersion, trailerError } from "./definitions"
import { drawJury, drawSeed, eligibleJurors, jurySize, nextSeed } from "./sortition"
import {
  freeName, fxActSync, fxCoinCredit, fxCoinDebit, fxRep, fxStatus, refundMarketVotes, refundOpenStakes, ruleProvisionalAct, settleMarketVotes,
  CONTEST_VOID_REFUND, RAID_FAILED_REFUND, settleOpenStakes, softHardF, strikeConfirmed, supersedeReplaced, voidContestsOn,
} from "./effects"

/**
 * The contest ladder — Laws 14/24/30/31, Amendment 5E — as ONE parameterized rule.
 *
 * Prod carries three near-copies of the screen-crossing logic (maybeAutoAdvance,
 * maybeRuleContest, resolveRaidScreen); here both contest screens share the act screens'
 * quorumCrossing and differ only in their Law 31 overlay (human concurrence seals, human
 * dissent resets) and their consequences. Routing is the target's state, never the player's
 * choice: un-attested confirmed act → challenge screen (stake burned at filing, Law 14);
 * attested → the raid ladder (SCREEN → COALITION at conviction parity → COURT; only the
 * court strikes, Law 24). Raid screens settle HARD — the raid is the hard layer (A7 7A);
 * challenge screens settle by the A7 dial, exactly as executeContestRuling does.
 *
 * Mode REPLACE (Law 30 succession) is implemented below: an upheld replace seats its successor in
 * the same ruling. Since Amendment 15 (payoff.v2) every screen also carries a Law 31e clock and
 * expires on TICK when it has not concluded in time; see sweepScreens.
 */

const CONTESTABLE = new Set(["ENTRY", "DEFINITION", "EDGE", "LABEL"])
// same whitelist as the live door's VALID_DEFECTS — one enum, two mouths
const DEFECTS = new Set(["EQUIVOCATION", "MISCLASSIFICATION", "DEFINITION_FAILS_TO_CARVE", "PARAMETER_GAP", "SUPERSEDED_BY", "OUT_OF_SCOPE"])

const str = (p: Record<string, unknown>, k: string): string | null =>
  typeof p[k] === "string" && (p[k] as string).length > 0 ? (p[k] as string) : null
const amt = (p: Record<string, unknown>, k: string): bigint | null =>
  typeof p[k] === "string" && /^[0-9]+$/.test(p[k] as string) ? BigInt(p[k] as string) : null

/** Prospective law only: absent is false, so no historical state hash gains a default dial. */
export const CHALLENGE_REBASE_ACTIVE = "CHALLENGE_REBASE_ACTIVE"

/** A definition screen is stale when a later accepted carving now heads the same entry. */
export function staleDefinitionHead(state: CoreState, c: Challenge): ActState | null {
  if (!dialBool(state.dials, CHALLENGE_REBASE_ACTIVE) || c.targetType !== "DEFINITION") return null
  const target = state.acts[c.targetId]
  if (!target || target.kind !== "DEFINITION" || !target.entryId) return null
  const head = acceptedDefinitionHead(state, target.entryId)
  const basis = c.basisHeadId ?? c.targetId // screens opened before activation bind to their target
  return head && head.id !== basis ? head : null
}

export function liveChallengeFor(state: CoreState, targetId: string): Challenge | null {
  for (const id of Object.keys(state.challenges).sort()) {
    const c = state.challenges[id]
    if (c.targetId === targetId && c.status === "PENDING") return c
  }
  return null
}

export function liveRaidFor(state: CoreState, targetId: string): Raid | null {
  for (const id of Object.keys(state.raids).sort()) {
    const r = state.raids[id]
    if (r.targetId === targetId && RAID_LIVE.includes(r.status)) return r
  }
  return null
}

/** Amendment 17 Part O item 4.2: the coin reason of the author's own attestations refunded on an upheld challenge
 *  (a return from escrow, as STAKE_REFUND; its own name so the trace says which refund it was). */
export const AUTHOR_ATTEST_REFUND = "AUTHOR_ATTEST_REFUND"

/** Amendment 17 Part O item 3.2: the refusal of a REPLACE on an attested act, the draft's text word for word. */
export const ATTESTED_REPLACE_REFUSED = "attested: a raid can only strike; use CORRECT for a part, or STRIKE with coins"

/**
 * An open attestation routes a contest to a raid. Amendment 17 Part O item 4 (decision 33; Laws 20, 22-i, 24,
 * 31, 32): only another player's — an act is attested, for routing, when someone other than its author has an
 * open attestation on it. `author` is passed only when the amendment is in force at the contest's filing; without
 * it any open attestation routes, the author's own included, as before.
 */
const hasLiveAttestation = (state: CoreState, key: string, author?: string): boolean =>
  (state.stakes[key] ?? []).some(s => s.status === "OPEN" && s.side === "ATTEST" && s.fp !== author)

/** Whether a contest filed now on this target routes to a raid (read at the contest's filing seq). */
function attestedForRouting(state: CoreState, tt: string, tid: string): boolean {
  const author = amendment17Version(state.dials) >= 1 ? state.acts[tid]?.authorFp : undefined
  return hasLiveAttestation(state, targetKey(tt, tid), author)
}

/** Amendment 17 Part O item 4.4: a raid opened before the amendment runs on as it was opened. A target only its
 *  author attests no longer routes to it, and a challenge beside a live raid would put one act on two screens. */
export const RAID_RUNS_ON = "a raid on this act is live and runs on as it was opened (Law 24) — contest the act when it concludes (Amendment 17)"

/** The raid on this target still live once applyContest's join-sweep (expireStaleCoalitions) has run at `nowTs`:
 *  a COALITION past RAID_COALITION_TTL_MS is expired by that sweep before routing, so the door does not count it. */
function liveRaidAfterSweep(state: CoreState, targetId: string, nowTs: string): Raid | null {
  const ttl = dialNum(state.dials, "RAID_COALITION_TTL_MS")
  for (const id of Object.keys(state.raids).sort()) {
    const r = state.raids[id]
    if (r.targetId !== targetId || !RAID_LIVE.includes(r.status)) continue
    if (r.status === "COALITION" && r.advancedTs && Date.parse(nowTs) - Date.parse(r.advancedTs) >= ttl) continue
    return r
  }
  return null
}

// ── the one door (Law 31) ───────────────────────────────────────────────────

export function validateContest(state: CoreState, e: Pick<EventEnvelope, "actor" | "payload" | "ts">): string | null {
  const p = e.payload
  // The court and its offices contest without stake or burn (keeper's ruling 2026-08-15): their
  // office is to put questions to the population, not to wager against it. Live exempts the
  // ADMIN filer (isAdmin, /api/contest) — offices reach the fold as `system` actors, and the
  // court key is exempt as dormant law for the day it files directly. Both arrive on the
  // challenge screen only: a raid is a coin position, and an organ of the law holds no position.
  const actor = state.actors[e.actor]
  const exempt = e.actor === state.keys.court || actor?.entityType === "system"
  if (!exempt) {
    if (!actor || (actor.entityType !== "agent" && actor.entityType !== "user")) return "unknown contester"
    if (actor.entityType === "agent" && !dialBool(state.dials, "CONTEST_AGENTS_OPEN")) {
      return "the contest court is not yet open to agents (Law 31 dial)"
    }
  }
  const tt = str(p, "targetType")
  const tid = str(p, "targetId")
  if (!tt || !tid || !CONTESTABLE.has(tt)) return "targetType must be ENTRY, DEFINITION, EDGE, or LABEL"
  if (!str(p, "reasoning")) return "reasoning is required — a contest without a defect teaches no one"
  const bigC = firstTooLong([["reasoning", str(p, "reasoning")!, LIMITS.REASONING]])
  if (bigC) return bigC
  // Amendment 17 Part O item 2: a correction, read when the contest is filed. With the dial absent the mode is
  // refused below exactly as any other unknown mode is today.
  if (str(p, "mode") === "CORRECT" && amendment17Version(state.dials) >= 1) return validateCorrection(state, e, exempt)
  // the defect names WHICH law the target offends — same whitelist as the live door.
  // REQUIRED from Amendment 14's activation seq, optional before it. The gate is a DIAL the
  // amendment sets through activatePending, not an edit to this function, because a replay must
  // judge each event under the rule in force at ITS seq — an unconditional check here would turn
  // every pre-activation contest into a fold crash. dialBool reads false for a dial nobody has
  // set, so the era before the amendment needs no genesis entry; and a genesis dial would have
  // appeared in every historical state and moved the very hash the pins commit to.
  const defect = str(p, "defect")
  if (defect !== null && !DEFECTS.has(defect)) return `defect must be one of: ${[...DEFECTS].join(", ")}`
  if (defect === null && dialBool(state.dials, "CONTEST_DEFECT_REQUIRED")) {
    return `a contest must name its defect (Amendment 14) — one of: ${[...DEFECTS].join(", ")}`
  }
  const mode = str(p, "mode") ?? "STRIKE"
  if (mode !== "STRIKE" && mode !== "REPLACE") return "mode must be STRIKE (remove) or REPLACE (seat a successor, Law 30)"
  if (mode === "REPLACE") {
    const specErr = replaceSpecError(str(p, "targetType") ?? "", p.replacementSpec, amendment17Version(state.dials) >= 1)
    if (specErr) return specErr
    if (amendment16Version(state.dials) >= 1) {
      const doorErr = replaceSpecDoorError(str(p, "targetType") ?? "", p.replacementSpec as Record<string, unknown>, amendment17Version(state.dials) >= 1)
      if (doorErr) return doorErr
    }
  }
  const act = state.acts[tid]
  if (!act || act.kind !== tt) return "target not found"
  if (act.kind === "LABEL" && act.canonical) return "the canonical name rides with its ENTRY — contest the entry; only separately filed labels are independent contest targets"
  if (act.status !== "ACCEPTED") return "only the CONFIRMED record is contested — judge a provisional act instead (Law 18)"
  if (dialBool(state.dials, CHALLENGE_REBASE_ACTIVE) && tt === "DEFINITION") {
    const head = acceptedDefinitionHead(state, act.entryId!)
    if (head && head.id !== tid) return `contest the current accepted definition ${head.id}, not an earlier carving`
  }
  // Amendment 17 Part P rider 2 (Law 30; decisions 47 and 50): a REPLACE that only corrects is a correction's
  if (mode === "REPLACE" && tt === "DEFINITION" && amendment17Version(state.dials) >= 1 &&
      replaceOnlyCorrects(act, String((p.replacementSpec as Record<string, unknown>).body))) return REPLACE_ONLY_CORRECTS
  // shadow parity: the emitter may carry prod's own contest id so screen votes join across
  // systems (the ACT_FILED/actId move, applied to contests)
  const cid = str(p, "contestId")
  if (cid && (state.challenges[cid] || state.raids[cid])) return "contestId already used"
  if (liveChallengeFor(state, tid)) return "this act already has a live contest on the challenge screen — judge that instead (one live contest per target)"
  const attested = attestedForRouting(state, tt, tid)
  if (!attested && amendment17Version(state.dials) >= 1 && liveRaidAfterSweep(state, tid, e.ts)) return RAID_RUNS_ON
  if (attested) {
    // Amendment 17 Part O item 3.2 (keeper's decision 32): a REPLACE aimed at an attested act is refused at
    // the door, free, with its fix, rather than turned into a raid that can only strike and its successor
    // dropped without a word. Read when the contest is filed; absent = converted as before.
    if (mode === "REPLACE" && amendment17Version(state.dials) >= 1) return ATTESTED_REPLACE_REFUSED
    // An OFFICE may raid — with real coins, like anyone (live has always allowed it; the
    // 2026-08-15 "an organ holds no position" refusal was this reducer legislating, not
    // mirroring — retracted by the audit batch, 2026-08-16). Only the court KEY cannot: it has
    // no actor row and no balance to stake.
    if (e.actor === state.keys.court) return "the court key holds no balance — a raid stakes real coins; the office raids under its own account"
    const coins = amt(p, "coinsBase")
    if (coins === null || coins < dialBig(state.dials, "RAID_MIN_COINS_BASE")) {
      return "attested target — contesting it stakes coins against the attester pool; pass coinsBase ≥ 1 coin"
    }
    if (actor!.balanceBase < coins) return "insufficient coin balance"
  } else if (!exempt && actor!.balanceBase < dialBig(state.dials, "CHALLENGE_STAKE_BASE")) {
    return "contesting an un-attested act burns the challenge stake (Law 14) — insufficient coins"
  }
  return null
}

/** Amendment 17 Part P rider 2: the refusal of a REPLACE that changes only the examples or the trailer, the draft's text. */
export const REPLACE_ONLY_CORRECTS = "REPLACE refused: the successor changes only the examples or the trailer — use CORRECT for one part (Law 30, Amendment 17)"

/**
 * Amendment 17 Part P rider 2 (core batch item 11): is this successor body the target definition's own text but for its
 * examples clause or its trailer's fields? The target must carry a prose hash — kept only for a definition filed after
 * activation (a filing, a repair, or a successor whose REPLACE was filed or rebased then) — and the successor's prose,
 * the body before its clause's marker, read with each run of whitespace as one space and its ends trimmed (and what shows
 * nothing — default-ignorable characters, a decomposed accent — read away: corrections.ts `folded`), must hash the
 * same. The door compares form only; one changed visible letter of the prose makes the successor a REPLACE like any other.
 * Linear: Part F's one-pass finder and one scan for Part A's marker.
 */
export function replaceOnlyCorrects(target: ActState, successorBody: string): boolean {
  const prose = target.partHashes?.prose
  if (!prose) return false
  const parts = definitionPartsA17(successorBody)
  return !!parts && partHash("prose", parts.prose) === prose
}

/** Amendment 17 Part O item 2.2: a correction refused, free, for a defect it names. */
export const CORRECT_NAMES_NO_DEFECT = "a correction names no defect — the part it names is the allegation (Law 30; Amendment 17)"
/** …and while another contest of any kind is live on its target. */
export const CORRECT_WAITS = "another contest is live on this act — a correction is refused while it runs, one live contest per target (Law 30; Amendment 17)"
/** …and when it restores a value an upheld correction replaced. */
export const CORRECT_NO_REVERSION = "this value is one an upheld correction replaced — a correction may not restore it (Law 30; Amendment 17)"
/** …and when its value is the one the part holds now: a correction names a new value (Part O items 2.1, 2.2). */
export const CORRECT_NO_CHANGE = "this value is the one the part holds now — a correction names a new value (Law 30; Amendment 17)"
/** …and on a definition filed before activation. */
export const CORRECT_OLD_DEFINITION = "a definition filed before Amendment 17's activation is replaced whole, not corrected: a definition's parts are corrected only on one filed after it (Law 30; Part O item 2.8)"

const correctionOf = (p: Record<string, unknown>): { part: unknown; value: unknown } => {
  const c = p.correction
  return c && typeof c === "object" && !Array.isArray(c) ? { part: (c as Record<string, unknown>).part, value: (c as Record<string, unknown>).value } : { part: undefined, value: undefined }
}

/**
 * Amendment 17 Part O item 2.2 and core batch item 6 — the door of a correction, CONTEST_FILED `{ targetType, targetId,
 * mode: "CORRECT", correction: { part, value }, reasoning }`. One part of one standing record; the value through the
 * door of a filing of that part; an entry's scope or referent on any standing entry (seq 0 among them, decision 42), a
 * definition's parts only on its head version, filed after activation; no defect (exempt from CONTEST_DEFECT_REQUIRED,
 * refused when one is named); no reversion to a value an upheld correction replaced, nor the value the part holds now; no other contest of any kind live
 * on the target; a balance of 2 coins (the challenge stake, burned at filing). Never routed to a raid: a correction
 * takes the challenge screen whatever the target's attestations (Laws 22, 24, 31). Every refusal is free.
 */
function validateCorrection(state: CoreState, e: Pick<EventEnvelope, "actor" | "payload" | "ts">, exempt: boolean): string | null {
  const p = e.payload
  if (p.defect !== undefined) return CORRECT_NAMES_NO_DEFECT
  const tt = str(p, "targetType")!
  const tid = str(p, "targetId")!
  const { part, value } = correctionOf(p)
  const valueError = correctionValueError(part, value)
  if (valueError) return valueError
  const act = state.acts[tid]
  if (!act || act.kind !== tt) return "target not found"
  if (!correctionPartsFor(tt).includes(part as CorrectionPart)) {
    return `a correction reaches an ENTRY's scope or referent, or a DEFINITION's formal, substrate, horizon, explicit or examples — not ${String(part)} of ${/^[AEIOU]/.test(tt) ? "an" : "a"} ${tt} (Law 30; Amendment 17)`
  }
  if (act.kind === "LABEL" && act.canonical) return "the canonical name rides with its ENTRY — contest the entry; only separately filed labels are independent contest targets"
  if (act.status !== "ACCEPTED") return "only the CONFIRMED record is contested — judge a provisional act instead (Law 18)"
  if (act.kind === "DEFINITION") {
    const head = acceptedDefinitionHead(state, act.entryId!)
    if (head && head.id !== tid) return `correct the head version of this entry's definition, ${head.id} — a correction reaches only the head (Law 30; Amendment 17)`
    if (!act.partHashes?.prose) return CORRECT_OLD_DEFINITION
  }
  const cid = str(p, "contestId")
  if (cid && (state.challenges[cid] || state.raids[cid])) return "contestId already used"
  if (liveChallengeFor(state, tid) || liveRaidAfterSweep(state, tid, e.ts)) return CORRECT_WAITS
  const valueHash = partHash(part as CorrectionPart, value as string)
  if (restoresReplacedValue(act, part as CorrectionPart, valueHash)) return CORRECT_NO_REVERSION
  // Part O item 2.2 "the new value": a correction to the value the part already holds changes nothing and is refused,
  // free, rather than refunded and awarded for nothing. Read by the same hashes as the reversion check, so with the
  // same limit: the scope of an entry filed before activation is known only inside its contentHash, and is not caught.
  if (standingPartHash(act, part as CorrectionPart) === valueHash) return CORRECT_NO_CHANGE
  if (!exempt && state.actors[e.actor].balanceBase < dialBig(state.dials, "CHALLENGE_STAKE_BASE")) {
    return "a correction burns the challenge stake at filing, 2 coins (Law 14) — insufficient coins"
  }
  return null
}

/** Amendment 17 Part O item 2.8: the value hashes a REPLACE successor keeps when it is seated, computed when its
 *  body passes the door under the amendment (the contest's filing, or its rebase). Before it: nothing. */
function successorPartHashesOf(state: CoreState, targetType: string, spec: Record<string, unknown>): Pick<Challenge, "successorPartHashes"> {
  if (amendment17Version(state.dials) < 1) return {}
  if (targetType === "DEFINITION") {
    const definition = definitionPartHashes(String(spec.body))
    return definition ? { successorPartHashes: { definition } } : {}
  }
  if (targetType === "ENTRY" && !(typeof spec.existingEntryId === "string" && spec.existingEntryId.trim())) {
    const definition = definitionPartHashes(String(spec.definitionBody))
    return {
      successorPartHashes: {
        entry: entryPartHashes(String(spec.scopeJustification), successorReferentOf(spec)),
        ...(definition ? { definition } : {}),
      },
    }
  }
  return {}
}

export function applyContest(state: CoreState, e: EventEnvelope, notes: string[]) {
  const p = e.payload
  const tt = str(p, "targetType")!
  const tid = str(p, "targetId")!
  const key = targetKey(tt, tid)
  // a stale coalition on this target expires before routing — the join-sweep, deterministic
  expireStaleCoalitions(state, e.ts, notes, tid)
  const correcting = str(p, "mode") === "CORRECT" // only ever admitted under Amendment 17 (validateCorrection)

  if (!correcting && attestedForRouting(state, tt, tid)) {
    const coins = BigInt(p.coinsBase as string)
    state.actors[e.actor].balanceBase -= coins
    fxCoinDebit(e.actor, coins, "RAID_STAKE", key)
    state.supply.escrowPoolBase += coins
    ;(state.stakes[key] ??= []).push({ fp: e.actor, side: "RAID", amountBase: coins, status: "OPEN", payoutBase: 0n, placedSeq: e.seq })
    let raid = liveRaidFor(state, tid)
    if (!raid) {
      const id = str(p, "contestId") ?? `raid:${tt}:${tid}:${e.seq}` // prod's id when the emitter carries it (D6 otherwise)
      raid = { id, targetType: tt, targetId: tid, status: "SCREEN", openedByFp: e.actor, frozenAttestBase: null, advancedTs: null }
      if (payoffRuleVersion(state.dials) >= 2) raid.openedTs = e.ts // Law 31e clock
      if (screenV2Active(state)) raid.v2 = { phase: "JURY", phaseTs: e.ts }
      if (amendment17Version(state.dials) >= 1) raid.voidsWithTarget = true // Part P rider 1, read at the raid's opening
      if (amendment18Version(state.dials) >= 1) raid.voidsOnAnyFall = true // Amendment 18 decision 60, read at the opening
      state.raids[raid.id] = raid
      if (amendment18Version(state.dials) >= 1) raid.refundsRaiders = true // Amendment 18 decision 64, read at the opening
      notes.push(`raid opened ${raid.id}`)
    } else {
      notes.push(`raid joined ${raid.id}`)
    }
    if (raid.status === "COALITION") checkParity(state, raid, e.ts, notes)
  } else {
    // the court and its offices file without the burn (keeper 2026-08-15; live's isAdmin exemption)
    const exempt = e.actor === state.keys.court || state.actors[e.actor]?.entityType === "system"
    if (!exempt) {
      const burn = dialBig(state.dials, "CHALLENGE_STAKE_BASE")
      state.actors[e.actor].balanceBase -= burn
      fxCoinDebit(e.actor, burn, "CHALLENGE_BURN", `challenge:${tt}:${tid}`)
      state.supply.coinBurnedBase += burn // burned at filing, Law 14 — not escrowed
      state.burns[String(e.seq)] = { fp: e.actor, amountBase: burn, compensated: false } // mirrorable (A8)
    }
    const mode = (str(p, "mode") ?? "STRIKE") as Challenge["mode"]
    const correction = correcting ? correctionOf(p) as { part: CorrectionPart; value: string } : null
    const c: Challenge = {
      id: str(p, "contestId") ?? `challenge:${tt}:${tid}:${e.seq}`, targetType: tt, targetId: tid, mode,
      ...(mode === "REPLACE" ? { replacementSpec: p.replacementSpec as Record<string, unknown> } : {}),
      ...(mode === "REPLACE" ? successorReferentStamp(state, tt, p.replacementSpec as Record<string, unknown>) : {}),
      ...(mode === "REPLACE" ? successorPartHashesOf(state, tt, p.replacementSpec as Record<string, unknown>) : {}),
      ...(correction ? { correction: { part: correction.part, value: correction.value, valueHash: partHash(correction.part, correction.value) } } : {}),
      authorFp: e.actor, status: "PENDING", filedSeq: e.seq,
      ...(dialBool(state.dials, CHALLENGE_REBASE_ACTIVE) && tt === "DEFINITION" ? { basisHeadId: tid } : {}),
      ...(payoffRuleVersion(state.dials) >= 2 ? { filedTs: e.ts } : {}), // Law 31e clock
      // Part O item 4: a correction touches no attestation, so it stamps no author's refund
      ...(amendment17Version(state.dials) >= 1 && !correcting ? { authorAttestRefund: true as const } : {}),
      ...(amendment17Version(state.dials) >= 1 ? { voidsWithTarget: true as const } : {}), // Part P rider 1
      ...(amendment18Version(state.dials) >= 1 ? { voidsOnAnyFall: true as const } : {}), // Amendment 18 decision 60
    }
    if (screenV2Active(state)) c.v2 = { phase: "JURY", phaseTs: e.ts } // the draw waits for the clock
    state.challenges[c.id] = c
    notes.push(`challenge opened ${c.id}`)
  }
}

// ── screen votes (targetType CHALLENGE | RAID) ──────────────────────────────

/** Amendment 18 decision 60 (Law 30): does a contest's target still stand? Read under the amendment at every door that
 *  could uphold the contest — the court's, the screen's — so a contest live on an act that fell by a path its own
 *  stamp did not void (one filed before the amendment) strikes nothing twice. Null when it stands. */
export function targetFallen(state: CoreState, contest: Pick<Challenge, "targetId">): string | null {
  const act = state.acts[contest.targetId]
  if (!act) return "its target is not in the record"
  return act.status === "ACCEPTED" ? null : `its target no longer stands (${act.status})`
}

export function validateScreenVote(state: CoreState, actorFp: string, tt: string, tid: string): string | null {
  const judge = state.actors[actorFp]
  if (judge.entityType === "agent" && !dialBool(state.dials, "CONTEST_AGENTS_OPEN")) {
    return "contest screens are not yet open to agents (Law 31 dial)"
  }
  const v18 = amendment18Version(state.dials) >= 1
  if (tt === "CHALLENGE") {
    const c = state.challenges[tid]
    if (!c) return "no such contest"
    if (c.status !== "PENDING") return `this contest is already resolved (${c.status})`
    // Amendment 18 decision 60: no vote lands on a contest whose target has fallen; it voids, lapses or is dismissed
    const fallen = v18 ? targetFallen(state, c) : null
    if (fallen) return `this contest ${fallen} — nothing is left to judge (Law 30; Amendment 18)`
    const stale = staleDefinitionHead(state, c)
    if (stale) return `this challenge is stale against definition ${stale.id} — rebase it before asking jurors to vote`
    if (c.parked) return "this screen is parked for the court (Law 31b-ii) — no further votes land"
    if (c.v2) return "this is a SEALED screen (screen.v2) — jurors VOTE_COMMIT, then VOTE_REVEAL"
    if (c.authorFp === actorFp) return "you cannot judge your own contest (Law 15)"
    // Amendment 18 decision 63 (Law 15): the target's author does not judge the contest of their own act
    if (v18 && state.acts[c.targetId]?.authorFp === actorFp) return "you cannot judge the contest of your own act (Law 15; Amendment 18)"
    return null
  }
  const r = state.raids[tid]
  if (!r) return "no such raid"
  if (r.status !== "SCREEN") return "this raid is past the screening stage"
  const fallen = v18 ? targetFallen(state, r) : null // decision 60
  if (fallen) return `this raid ${fallen} — nothing is left to judge (Law 30; Amendment 18)`
  if (r.parked) return "this screen is parked for the court (Law 31b-ii) — no further votes land"
  if (r.v2) return "this is a SEALED screen (screen.v2) — jurors VOTE_COMMIT, then VOTE_REVEAL"
  if (r.openedByFp === actorFp) return "you cannot judge your own raid (Law 15)"
  // decision 63: the author is barred; the act's attesters are not — their coins are what the raid attacks
  if (v18 && state.acts[r.targetId]?.authorFp === actorFp) return "you cannot judge the raid on your own act (Law 15; Amendment 18)"
  return null
}

// Law 38b-i: the seal (and the dissent) belong to a SEATED human — a user housed under a proof
// of personhood. validateVote refuses unseated screen votes at the door; this mirrors the same
// seat on the read side, so an unhoused vote already in a market never seals or resets a screen.
const humanOn = (state: CoreState, market: Record<string, { dir: string }>, dir: string): boolean =>
  Object.keys(market).some(fp => state.actors[fp].entityType === "user" && !!state.actors[fp].houseId && market[fp].dir === dir)

/** The Law 31 overlay shared by both screens: quorum weighs; a person seals; a person's
 *  doubt re-opens — once. Returns the verdict to execute, or null (parked / reset / no consensus). */
function screenCrossing(state: CoreState, key: string, e: EventEnvelope, notes: string[], screen: Challenge | Raid): "ACCEPTED" | "REJECTED" | null {
  // Laws 31c/31d are ratified dormant and UNIMPLEMENTED — a lit dial halts the fold (D1)
  if (dialNum(state.dials, "SEAL_WINDOW_MS") !== 0 || dialNum(state.dials, "DISSENT_SLOTS") !== 0) {
    throw new Error("Law 31c/31d dials are set but their machinery is not implemented — refusing to fold under unimplemented law")
  }
  const v2 = screen.v2
  const market = state.votes[key] ?? {}
  const crossing = quorumCrossing(state, market, e.ts)
  if (!crossing) return null
  const winDir = crossing.status === "ACCEPTED" ? "ADVANCE" : "STRIKE"
  const loseDir = winDir === "ADVANCE" ? "STRIKE" : "ADVANCE"
  if (humanOn(state, market, loseDir)) {
    const limit = dialNum(state.dials, "HUMAN_RESET_LIMIT")
    if (limit > 0 && (screen.humanResets ?? 0) >= limit) {
      // Law 31b-ii: two doubts go to the court. Nothing is voided — the standing market and
      // the dissent ARE the case file; only a COURT_RULING concludes a parked screen.
      screen.parked = true
      // Law 31e: the court's clock starts here. (screen.v2, dormant, parks in sweepScreensV2 without
      // this stamp; the sweep then stamps it on its first pass, at most one hourly tick late.)
      if (payoffRuleVersion(state.dials) >= 2) screen.parkedTs = e.ts
      if (v2) {
        v2.phase = "PARKED"
        v2.phaseTs = e.ts
      }
      notes.push("human dissent again — the screen parks for the court (Law 31b-ii); the market stands as the case file")
      return null
    }
    screen.humanResets = (screen.humanResets ?? 0) + 1
    refundMarketVotes(state, key) // human dissent voids the screen — refund all, restart at zero
    if (v2) {
      // sealed screens restart FURTHER back: fresh jury at the next TICK, fresh seed —
      // a person's doubt re-opens the question to different judges, not the same twelve
      v2.phase = "JURY"
      v2.phaseTs = e.ts
      delete v2.juryFps
      delete v2.jurySeed
      delete v2.commits
      v2.altRounds = 0
    }
    notes.push("human dissent reset the screen (Law 31)")
    return null
  }
  if (!humanOn(state, market, winDir)) {
    notes.push("awaiting human concurrence (Law 31)")
    return null
  }
  return crossing.status
}

export function evaluateChallengeScreen(state: CoreState, c: Challenge, e: EventEnvelope, notes: string[]) {
  const verdict = screenCrossing(state, targetKey("CHALLENGE", c.id), e, notes, c)
  if (verdict) executeChallengeRuling(state, c, verdict, c.v2 ? "screen.v2" : "quorum.v1", e.seq, notes)
}

export function evaluateRaidScreen(state: CoreState, raid: Raid, e: EventEnvelope, notes: string[]) {
  const verdict = screenCrossing(state, targetKey("RAID", raid.id), e, notes, raid)
  if (!verdict) return
  if (verdict === "REJECTED") executeRaidDismissal(state, raid, notes)
  else executeRaidAdvance(state, raid, e.ts, notes)
}

// ── consequences ────────────────────────────────────────────────────────────

/** ACCEPTED = upheld (the target falls — and mode REPLACE seats its successor in the same
 *  ruling), REJECTED = dismissed (the stake stays burned). Returns false only when an upheld
 *  REPLACE cannot materialize — the contest then stays PENDING for the court, exactly prod's
 *  failed-swap-leaves-it-pending semantics, and the vote market stays open. */
export function executeChallengeRuling(state: CoreState, c: Challenge, verdict: "ACCEPTED" | "REJECTED", rule: string, atSeq: number, notes: string[]): boolean {
  if (verdict === "ACCEPTED" && amendment18Version(state.dials) >= 1) {
    // Amendment 18 decision 60 (Law 30): a contest is not upheld against an act that no longer stands. The court's
    // door and the screen's refuse it first; should a crossing still reach here, the contest concludes VOID — its
    // burn refunded, its judges' stakes returned — rather than striking the dead act again.
    const fallen = targetFallen(state, c)
    if (fallen) {
      voidFallenContest(state, c, notes)
      notes.push(`challenge ${c.id} VOID — ${fallen} (Law 30; Amendment 18); market refunded`)
      return true
    }
  }
  if (verdict === "ACCEPTED") {
    const stale = staleDefinitionHead(state, c)
    if (stale) {
      c.parked = true
      if (c.v2) { c.v2.phase = "PARKED" }
      notes.push(`challenge stale against definition ${stale.id} — rebase and rejudge before it can be upheld`)
      return false
    }
  }
  if (verdict === "ACCEPTED" && c.mode === "REPLACE") {
    const blocked = replaceFeasible(state, c)
    if (blocked) {
      notes.push(`successor cannot materialize — ${blocked}; contest parked for the court`)
      return false
    }
  }
  if (verdict === "ACCEPTED" && c.mode === "CORRECT") {
    const blocked = correctionFeasible(state, c)
    if (blocked) {
      notes.push(`correction cannot be applied — ${blocked}; the contest waits for the court`)
      return false
    }
  }
  c.status = verdict
  fxStatus("screen-status", c.id, "CHALLENGE", verdict)
  if (verdict === "ACCEPTED" && c.mode === "CORRECT") {
    applyUpheldCorrection(state, c, atSeq, notes)
  } else if (verdict === "ACCEPTED") {
    // The court key holds no actor row and takes no award for a contest it filed itself
    // (dormant law — office contests carry the office's own fp and are paid like live pays
    // them). Any other unknown author still crashes the fold loudly.
    // Amendment 16 Part C: contesting your own act stays legal (a better carving of your own
    // definition is welcome), but it pays no challenge award; the successor's own acceptance
    // reward is paid as usual.
    const selfContest = amendment16Version(state.dials) >= 1 && state.acts[c.targetId]?.authorFp === c.authorFp
    if (selfContest) notes.push(`challenge ${c.id} upheld for its target's own author — no challenge award (Amendment 16, Part C)`)
    const author = c.authorFp === state.keys.court || selfContest ? null : state.actors[c.authorFp]
    if (author) {
      const repAward = dialBig(state.dials, "CHALLENGE_UPHELD_REP_MILLI")
      author.repMilli += repAward
      state.supply.repMintedMilli += repAward
      fxRep(c.authorFp)
      const coinAward = dialBig(state.dials, "CHALLENGE_UPHELD_COIN_BASE")
      author.balanceBase += coinAward
      fxCoinCredit(c.authorFp, coinAward, "CHALLENGE_UPHELD", c.id)
      state.supply.coinMintedBase += coinAward
    }
    if (c.mode === "REPLACE") {
      // Law 30: seat FIRST (prod seats before the strike), then supersede, then hand the
      // web and the words to the successor.
      const target = state.acts[c.targetId]
      const succId = seatSuccessor(state, c, rule, atSeq, notes)
      c.successorId = succId
      supersedeReplaced(state, target, succId, atSeq, `${rule}.replace`, notes)
      if (c.targetType === "ENTRY") teardownReplacedEntry(state, c, target, succId, notes)
    } else {
      strikeConfirmed(state, state.acts[c.targetId], atSeq, `${rule}.challenge`, notes)
    }
    // Amendment 17 Part O item 4.2: on a contest filed under the amendment, an upheld STRIKE or REPLACE refunds
    // the target author's own open attestations of it — they shield nothing, so they forfeit nothing. Only the
    // author's; a dismissed challenge refunds nothing; edge royalties already paid are untouched. On both paths
    // that reach here: the screen's verdict and the court's COURT_RULING.
    if (c.authorAttestRefund && (c.mode === "STRIKE" || c.mode === "REPLACE")) {
      const author = state.acts[c.targetId]?.authorFp
      const refunded = author ? refundOpenStakes(state, targetKey(c.targetType, c.targetId), "ATTEST", { fp: author, reason: AUTHOR_ATTEST_REFUND }) : 0n
      if (refunded > 0n) notes.push(`challenge ${c.id}: the author's own attestations refunded, ${refunded} base (Amendment 17, Part O item 4)`)
    }
    // The act fell, so a market that attested it AFTER the challenge was filed closes as
    // forfeit — nothing pays out (no RAID side), the coins stay escrowed. In prod this was
    // the 2026-08-10 stranded-market fix; here it is one line that cannot be forgotten.
    settleOpenStakes(state, targetKey(c.targetType, c.targetId), "REJECTED", notes)
  }
  settleMarketVotes(state, targetKey("CHALLENGE", c.id), verdict, softHardF(state))
  notes.push(`challenge ${c.id} ${verdict === "ACCEPTED" ? "UPHELD" : "DISMISSED"}`)
  return true
}

/** Amendment 18 decision 60: a challenge concludes VOID at a ruling door because its target has fallen — paid as
 *  Part P rider 1 pays a void (effects.ts voidContestsOn): the screen refunded, the filing burn refunded by
 *  compensation (CONTEST_VOID_REFUND), no award, nothing clawed back. */
function voidFallenContest(state: CoreState, c: Challenge, notes: string[]) {
  refundMarketVotes(state, targetKey("CHALLENGE", c.id))
  const burn = state.burns[String(c.filedSeq)]
  if (burn && !burn.compensated) {
    if (burn.fp !== c.authorFp) throw new Error(`challenge ${c.id}: burn at seq ${c.filedSeq} belongs to ${burn.fp}, not its author ${c.authorFp}`)
    state.actors[burn.fp].balanceBase += burn.amountBase
    fxCoinCredit(burn.fp, burn.amountBase, CONTEST_VOID_REFUND, c.id)
    state.supply.coinMintedBase += burn.amountBase // the refund mints exactly what the filing burned
    burn.compensated = true
    notes.push(`challenge ${c.id}: filing stake refunded`)
  }
  c.status = "VOID"
  fxStatus("screen-status", c.id, "CHALLENGE", "VOID")
}

/** Can an upheld correction be applied now? Its target still standing and, for a definition, still the head. Read at
 *  the ruling (the screen's or the court's), as replaceFeasible reads a successor's. */
export function correctionFeasible(state: CoreState, c: Challenge): string | null {
  const act = state.acts[c.targetId]
  if (!act || act.status !== "ACCEPTED") return "its target no longer stands"
  if (act.kind === "DEFINITION") {
    const head = acceptedDefinitionHead(state, act.entryId!)
    if (!head || head.id !== act.id) return `its definition is no longer the head (${head?.id ?? "none"})`
  }
  return null
}

/**
 * Amendment 17 Part O items 2.5 and 2.6 — an upheld correction. The act keeps its id, author, version, attestations,
 * holdback, text and contentHash, and carries the correction as its own fact: the part, the new value's hash and the
 * hash of the value it replaced; a referent correction sets the act's referent. The corrector's 2-coin burn is refunded
 * (CORRECT_UPHELD_REFUND, mirroring the burn, which is then compensated) and the correction pays CORRECT_AWARD_BASE
 * coins and CORRECT_AWARD_REP_MILLI reputation (CORRECT_UPHELD) — unless it corrected the corrector's own act, which has
 * the 2 coins back and no award (Law 14), or the court key filed it, which holds no row. Nothing is clawed back and no
 * coin stake on the target is settled: the attestations stand. The screen's judges settle soft, as on any challenge.
 */
function applyUpheldCorrection(state: CoreState, c: Challenge, atSeq: number, notes: string[]) {
  const act = state.acts[c.targetId]
  const { part, value, valueHash } = c.correction!
  const replacedHash = standingPartHash(act, part)
  act.corrections = [...(act.corrections ?? []), { challengeId: c.id, part, valueHash, ...(replacedHash ? { replacedHash } : {}), atSeq }]
  if (part === "referent") {
    if (value === "THING") delete act.referent // absent = THING, Law 3b
    else act.referent = value as "CONCEPT" | "WORD"
  }
  fxActSync(act.id, act.kind)
  const burn = state.burns[String(c.filedSeq)]
  if (burn && !burn.compensated) {
    if (burn.fp !== c.authorFp) throw new Error(`correction ${c.id}: burn at seq ${c.filedSeq} belongs to ${burn.fp}, not its author ${c.authorFp}`)
    state.actors[burn.fp].balanceBase += burn.amountBase
    fxCoinCredit(burn.fp, burn.amountBase, CORRECT_UPHELD_REFUND, c.id)
    state.supply.coinMintedBase += burn.amountBase // the refund mints exactly what the filing burned
    burn.compensated = true
  }
  const own = act.authorFp === c.authorFp
  const corrector = c.authorFp === state.keys.court || own ? null : state.actors[c.authorFp]
  if (corrector) {
    const rep = dialBig(state.dials, CORRECT_AWARD_REP_MILLI)
    corrector.repMilli += rep
    state.supply.repMintedMilli += rep
    fxRep(c.authorFp)
    const coins = dialBig(state.dials, CORRECT_AWARD_BASE)
    corrector.balanceBase += coins
    fxCoinCredit(c.authorFp, coins, CORRECT_UPHELD, c.id)
    state.supply.coinMintedBase += coins
  }
  notes.push(`correction ${c.id}: ${act.kind} ${act.id} ${part} corrected — the act as filed, the correction its own fact (Amendment 17, Part O item 2)${own ? "; its own author's correction: the burn refunded, no award" : ""}`)
}

// ── stale definition challenge rebasing (prospective, activation-gated) ─────

export function validateContestRebase(state: CoreState, e: Pick<EventEnvelope, "actor" | "payload">): string | null {
  if (!dialBool(state.dials, CHALLENGE_REBASE_ACTIVE)) return "challenge rebasing is not active"
  const p = e.payload
  const cid = str(p, "challengeId")
  const nextId = str(p, "targetId")
  if (!cid || !nextId || !str(p, "reasoning")) return "challengeId, targetId, and reasoning required"
  const big = firstTooLong([["reasoning", str(p, "reasoning")!, LIMITS.REASONING]])
  if (big) return big
  const defect = str(p, "defect")
  if (defect !== null && !DEFECTS.has(defect)) return `defect must be one of: ${[...DEFECTS].join(", ")}`
  if (defect === null && dialBool(state.dials, "CONTEST_DEFECT_REQUIRED")) return "a rebased contest must name its defect"
  const c = state.challenges[cid]
  if (!c) return "no such challenge"
  if (c.status !== "PENDING") return `already resolved: ${c.status}`
  if (c.authorFp !== e.actor && e.actor !== state.keys.court) return "only the challenger or court may rebase this screen"
  if (c.targetType !== "DEFINITION" || c.mode !== "REPLACE") return "rebasing currently applies to stale definition replacements"
  const head = staleDefinitionHead(state, c)
  if (!head) return "challenge is not stale — its definition basis is still current"
  if (head.id !== nextId) return `targetId must be the current accepted definition ${head.id}`
  const other = liveChallengeFor(state, nextId)
  if (other && other.id !== c.id) return `definition ${nextId} already has a live challenge`
  const specErr = replaceSpecError("DEFINITION", p.replacementSpec, amendment17Version(state.dials) >= 1)
  if (specErr) return specErr
  if (amendment16Version(state.dials) >= 1) {
    const doorErr = replaceSpecDoorError("DEFINITION", p.replacementSpec as Record<string, unknown>, amendment17Version(state.dials) >= 1)
    if (doorErr) return doorErr
  }
  // Amendment 17 Part O item 3.2 (Laws 24, 30): a rebase files a new successor on a new head, and "only a rebase
  // after activation, which files a new successor, meets the door then in force" (Prospective effect). So a
  // REPLACE rebased onto a head another player attests is refused, free, with the same fix, as at filing:
  // otherwise the challenge screen would seat a successor over an attested act without the court. Read at the
  // rebase's seq; the author's own attestation does not count (Part O item 4). Absent = admitted, as before.
  if (amendment17Version(state.dials) >= 1 && attestedForRouting(state, "DEFINITION", nextId)) return ATTESTED_REPLACE_REFUSED
  // Amendment 17 Part P rider 2: the rebased successor is compared with its new target, the door read at the rebase
  if (amendment17Version(state.dials) >= 1 && replaceOnlyCorrects(state.acts[nextId], String((p.replacementSpec as Record<string, unknown>).body))) {
    return REPLACE_ONLY_CORRECTS
  }
  return null
}

export function applyContestRebase(state: CoreState, e: EventEnvelope, notes: string[]) {
  const p = e.payload
  const c = state.challenges[str(p, "challengeId")!]
  refundMarketVotes(state, targetKey("CHALLENGE", c.id))
  c.targetId = str(p, "targetId")!
  c.basisHeadId = c.targetId
  c.replacementSpec = p.replacementSpec as Record<string, unknown>
  // Amendment 17 Part O item 2.8: a successor rebased under the amendment passed the door then, and is filed after it
  const hashes = successorPartHashesOf(state, "DEFINITION", c.replacementSpec)
  if (hashes.successorPartHashes) c.successorPartHashes = hashes.successorPartHashes
  else delete c.successorPartHashes
  c.rebaseCount = (c.rebaseCount ?? 0) + 1
  c.humanResets = 0
  delete c.parked
  if (payoffRuleVersion(state.dials) >= 2) {
    // Law 31e: a rebase asks for a fresh judgment, so the seven days start again from it, and the
    // court's clock (if the screen was parked) is gone with the parking.
    c.filedTs = e.ts
    delete c.parkedTs
  }
  if (c.v2) {
    c.v2 = { phase: "JURY", phaseTs: e.ts }
  }
  notes.push(`challenge ${c.id} rebased onto definition ${c.targetId}; prior votes voided, fresh judgment required`)
}

// ── Law 30 mode REPLACE — the succession ────────────────────────────────────

/**
 * A drafted ENTRY successor's referent (Amendment 17 Part O item 5), read as the entry door reads a
 * filing's (Law 3b, reducer ENTRY): a non-empty string, else absent; absent and THING are THING.
 */
export function successorReferentOf(spec: Record<string, unknown>): string | null {
  return typeof spec.referent === "string" && spec.referent.length > 0 ? spec.referent : null
}

/**
 * Shape-validate a replacementSpec at filing, so a malformed swap can't be proposed. With `amendment17`
 * (in force when the contest is filed) a drafted ENTRY successor may declare its referent, THING,
 * CONCEPT or WORD, through Law 3b's door (Part O item 5). Without it, as before, a `referent` key is not
 * read: it is kept in the spec as filed and the successor is THING.
 */
export function replaceSpecError(targetType: string, spec: unknown, amendment17 = false): string | null {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return "mode REPLACE requires a replacementSpec object describing the successor"
  }
  const s = spec as Record<string, unknown>
  const has = (k: string) => typeof s[k] === "string" && (s[k] as string).trim().length > 0
  if (targetType === "ENTRY") {
    if (has("existingEntryId")) return null
    if (!has("canonicalName") || !has("scopeJustification") || !has("definitionBody")) {
      return "ENTRY replacementSpec needs existingEntryId, or a full draft: canonicalName, scopeJustification, definitionBody — a replacement must carve (Law 5)"
    }
    if (amendment17) {
      const referent = successorReferentOf(s)
      if (referent !== null && referent !== "THING" && referent !== "CONCEPT" && referent !== "WORD") {
        return "ENTRY replacementSpec referent must be THING, CONCEPT, or WORD (Law 3b) — a drafted successor's referent passes a filing's door (Amendment 17)"
      }
    }
    return null
  }
  if (targetType === "DEFINITION") return has("body") ? null : "DEFINITION replacementSpec needs body"
  if (targetType === "EDGE") {
    if (!has("fromEntryId") || !has("toEntryId")) return "EDGE replacementSpec needs fromEntryId and toEntryId"
    if (!EDGE_TYPES.has(String(s.edgeType))) return `EDGE replacementSpec edgeType must be one of: ${[...EDGE_TYPES].join(", ")}`
    if (s.fromEntryId === s.toEntryId) return "EDGE replacementSpec cannot be a self-loop"
    return null
  }
  return `unsupported REPLACE targetType ${targetType}`
}

/**
 * Amendment 16 Part D — a successor passes the same door a fresh filing of the same act passes: the
 * name shape of Law 12-ii, the length limits, and (Part G) the Law 6 trailer. Collisions are already
 * refused when the successor would be seated (replaceFeasible). Before the amendment a successor was
 * checked only for non-empty fields: "!!!" and 500-character names, and 20,000-character definitions
 * against the 8,000 limit, were seated (Fable 5.1 analysis, 3.3).
 *
 * `amendment17` is Amendment 17 in force at the contest's (or the rebase's) filing: a successor's
 * definition body then ends with the four-field trailer, an epoch refused with its fix (Part G item 5),
 * and carries the Law 6b examples clause before it, checked after the trailer. A successor naming an
 * existing entry carries no body and so neither. A successor edge may not take a type Amendment 17
 * retires (Part N item 5).
 */
export function replaceSpecDoorError(targetType: string, s: Record<string, unknown>, amendment17 = false): string | null {
  const fail = (why: string) => `REPLACE successor refused: ${why} — a successor passes the same door as any filing (Amendment 16, Part D)`
  const bodyError = (body: string): string | null => {
    if (amendment17) {
      const why = trailerError(body, 4) ?? examplesError(body, 4)
      return why ? fail(`${why} (Amendment 17)`) : null
    }
    const trailer = trailerError(body, 5)
    return trailer ? fail(trailer) : null
  }
  if (targetType === "ENTRY") {
    if (typeof s.existingEntryId === "string" && s.existingEntryId.trim()) return null
    const shape = nameShapeErrorV16(String(s.canonicalName)) // Part D runs only under Amendment 16, so Part E's shape
    if (shape) return fail(shape)
    const big = firstTooLong([["scopeJustification", s.scopeJustification, LIMITS.SCOPE], ["definitionBody", s.definitionBody, LIMITS.DEFINITION_BODY]])
    if (big) return fail(big)
    return bodyError(String(s.definitionBody))
  }
  if (targetType === "DEFINITION") {
    const big = firstTooLong([["body", s.body, LIMITS.DEFINITION_BODY]])
    if (big) return fail(big)
    return bodyError(String(s.body))
  }
  if (targetType === "EDGE") {
    // Amendment 17 Part N item 5: a successor edge of a retired type is refused with its challenge
    if (amendment17 && RETIRED_EDGE_TYPES.has(String(s.edgeType))) return fail(`${retiredEdgeTypeError(String(s.edgeType))} (Amendment 17)`)
    const big = firstTooLong([["note", s.note ?? "", LIMITS.EDGE_NOTE]])
    return big ? fail(big) : null
  }
  return null
}

// the name comparison in force comes from names.ts (Law 12-ii; Amendment 16 Part E)

/** Can the successor materialize RIGHT NOW? Checked at ruling time (the world moved since
 *  filing) — by the quorum path before executing, and by COURT_RULING validation. */
export function replaceFeasible(state: CoreState, c: Challenge): string | null {
  const spec = (c.replacementSpec ?? {}) as Record<string, unknown>
  if (c.targetType === "ENTRY") {
    const existing = typeof spec.existingEntryId === "string" ? spec.existingEntryId : null
    if (existing) {
      const succ = state.acts[existing]
      if (!succ || succ.kind !== "ENTRY" || succ.status !== "ACCEPTED") return "existingEntryId must be a confirmed entry"
      if (succ.id === c.targetId) return "replacement cannot be the target itself"
      return null
    }
    const n = nameNorm(state)(spec.canonicalName as string)
    const blocked = nameHolders(state.names, n).some(h => {
      const a = state.acts[h]
      return (a.kind === "ENTRY" ? a.id : a.entryId) !== c.targetId
    })
    if (blocked) return `replacement name already held (Law 12): ${spec.canonicalName}`
    return null
  }
  if (c.targetType === "DEFINITION") {
    const old = state.acts[c.targetId]
    const entry = old?.entryId ? state.acts[old.entryId] : null
    if (!entry || isDead(entry.status)) return "the definition's entry no longer stands — nothing to re-define"
    return null
  }
  // EDGE
  const from = state.acts[spec.fromEntryId as string]
  const to = state.acts[spec.toEntryId as string]
  if (!from || from.kind !== "ENTRY" || isDead(from.status) || !to || to.kind !== "ENTRY" || isDead(to.status)) {
    return "replacement edge endpoints must be live entries"
  }
  for (const id of Object.keys(state.acts)) {
    const a = state.acts[id]
    if (a.kind === "EDGE" && !isDead(a.status) && a.id !== c.targetId &&
        a.fromEntryId === spec.fromEntryId && a.toEntryId === spec.toEntryId && a.edgeType === spec.edgeType) {
      return "the corrected edge already exists — file a plain STRIKE instead"
    }
  }
  return null
}

/** Amendment 17 Part O item 5: the referent a drafted ENTRY successor carries, stamped on its challenge when
 * the contest is filed under the amendment (CONCEPT or WORD; THING and absent stamp nothing). Before it,
 * nothing: a `referent` key in the spec is kept as filed and never read, and the successor is THING. */
function successorReferentStamp(state: CoreState, targetType: string, spec: Record<string, unknown>): Pick<Challenge, "successorReferent"> {
  if (targetType !== "ENTRY" || amendment17Version(state.dials) < 1) return {}
  if (typeof spec.existingEntryId === "string" && spec.existingEntryId.trim()) return {} // a confirmed entry keeps its own
  const referent = successorReferentOf(spec)
  return referent === "CONCEPT" || referent === "WORD" ? { successorReferent: referent } : {}
}

const partHashesOf = (hashes: PartHashes | undefined): Pick<ActState, "partHashes"> => (hashes ? { partHashes: { ...hashes } } : {})

/** Create the successor ACCEPTED through the ONE acceptance pipeline (award, quarter-mint,
 *  holdback, the eating) — authored by the challenger, ids derived from the challenge (D6). */
function seatSuccessor(state: CoreState, c: Challenge, rule: string, atSeq: number, notes: string[]): string {
  const spec = (c.replacementSpec ?? {}) as Record<string, unknown>
  const seat = (act: ActState) => {
    state.acts[act.id] = act
    ruleProvisionalAct(state, act, "ACCEPTED", `${rule}.replace-seat`, atSeq, notes)
    return act.id
  }
  if (c.targetType === "ENTRY") {
    const existing = typeof spec.existingEntryId === "string" ? spec.existingEntryId : null
    if (existing) return existing // a confirmed entry takes the place — nothing to seat
    const entryId = `succ:${c.id}`
    const n = nameNorm(state)(spec.canonicalName as string)
    seat({
      id: entryId, kind: "ENTRY", authorFp: c.authorFp, status: "PROVISIONAL", filedSeq: atSeq, contentHash: `replace:${c.id}`, nameNorm: n,
      ...(c.successorReferent ? { referent: c.successorReferent } : {}), // Law 3b; absent = THING, as every successor before Amendment 17
      ...partHashesOf(c.successorPartHashes?.entry), // Amendment 17 Part O item 2.8: filed after activation
    })
    claimName(state.names, n, entryId) // claim ALONGSIDE (plural, A+A) — the relic's hold outlives it, as live's labelHolders always did
    seat({
      id: `succdef:${c.id}`, kind: "DEFINITION", authorFp: c.authorFp, status: "PROVISIONAL", filedSeq: atSeq, contentHash: `replacedef:${c.id}`, entryId, version: 1,
      ...partHashesOf(c.successorPartHashes?.definition),
    })
    return entryId
  }
  if (c.targetType === "DEFINITION") {
    const old = state.acts[c.targetId]
    return seat({
      id: `succ:${c.id}`, kind: "DEFINITION", authorFp: c.authorFp, status: "PROVISIONAL",
      filedSeq: atSeq, contentHash: `replace:${c.id}`, entryId: old.entryId,
      version: nextDefinitionVersion(state, old.entryId!),
      ...partHashesOf(c.successorPartHashes?.definition),
    })
  }
  return seat({
    id: `succ:${c.id}`, kind: "EDGE", authorFp: c.authorFp, status: "PROVISIONAL", filedSeq: atSeq, contentHash: `replace:${c.id}`,
    fromEntryId: spec.fromEntryId as string, toEntryId: spec.toEntryId as string, edgeType: spec.edgeType as string,
  })
}

/** The succession's teardown: the replaced entry's edges re-point to the successor (collisions
 *  and self-loops removed instead — voided pending, orphaned accepted, markets refunded), its
 *  pending dependents void, its accepted definitions orphan, and its accepted names transfer
 *  (Law 39: a merged concept keeps every word it ever carried). */
function teardownReplacedEntry(state: CoreState, c: Challenge, old: ActState, succId: string, notes: string[]) {
  for (const id of Object.keys(state.acts).sort()) {
    const dep = state.acts[id]
    if (isDead(dep.status) || dep.id === old.id || dep.id === succId) continue

    if (dep.kind === "EDGE" && (dep.fromEntryId === old.id || dep.toEntryId === old.id)) {
      const from = dep.fromEntryId === old.id ? succId : dep.fromEntryId!
      const to = dep.toEntryId === old.id ? succId : dep.toEntryId!
      const collision = from === to || Object.keys(state.acts).some(oid => {
        const o = state.acts[oid]
        return o.kind === "EDGE" && !isDead(o.status) && o.id !== dep.id &&
          o.fromEntryId === from && o.toEntryId === to && o.edgeType === dep.edgeType
      })
      if (collision) {
        if (dep.status === "PROVISIONAL") refundMarketVotes(state, targetKey("EDGE", dep.id))
        else dep.orphaned = true
        refundOpenStakes(state, targetKey("EDGE", dep.id), "BOTH")
        dep.status = "REJECTED"
        fxStatus("act-status", dep.id, dep.kind, "REJECTED")
        voidContestsOn(state, dep, notes) // Amendment 17 Part P rider 1
        notes.push(`edge ${dep.id} removed (would collide after re-pointing)`)
      } else {
        dep.fromEntryId = from
        dep.toEntryId = to
        fxActSync(dep.id, dep.kind)
        notes.push(`edge ${dep.id} re-pointed to ${succId}`)
      }
      continue
    }

    if (dep.kind === "DEFINITION" && dep.entryId === old.id) {
      if (dep.status === "PROVISIONAL") refundMarketVotes(state, targetKey("DEFINITION", dep.id))
      else dep.orphaned = true // its author wasn't wrong — the construct got a better carving
      refundOpenStakes(state, targetKey("DEFINITION", dep.id), "BOTH")
      dep.status = "REJECTED"
      fxStatus("act-status", dep.id, dep.kind, "REJECTED")
      voidContestsOn(state, dep, notes) // Amendment 17 Part P rider 1
      notes.push(`definition ${dep.id} ${dep.orphaned ? "orphaned" : "voided"}`)
      continue
    }

    if (dep.kind === "LABEL" && dep.entryId === old.id) {
      if (dep.status === "ACCEPTED") {
        dep.entryId = succId // the word transfers; the names map already points at this act
        fxActSync(dep.id, dep.kind)
        notes.push(`label ${dep.id} transferred to ${succId}`)
      } else {
        refundMarketVotes(state, targetKey("LABEL", dep.id))
        refundOpenStakes(state, targetKey("LABEL", dep.id), "BOTH")
        dep.status = "REJECTED"
        fxStatus("act-status", dep.id, dep.kind, "REJECTED")
        freeName(state, dep)
        voidContestsOn(state, dep, notes) // Amendment 17 Part P rider 1
        notes.push(`label ${dep.id} voided`)
      }
    }
  }

  // the old CANONICAL name rides to the successor as an alias (Law 39), unless the successor
  // already answers to it (a draft that reused the name took it over at seating)
  if (old.nameNorm && nameHolders(state.names, old.nameNorm).includes(old.id)) {
    const aliasId = `succalias:${c.id}`
    state.acts[aliasId] = {
      id: aliasId, kind: "LABEL", authorFp: c.authorFp, status: "ACCEPTED", filedSeq: old.filedSeq,
      contentHash: `alias:${c.id}`, entryId: succId, nameNorm: old.nameNorm,
      ruling: { status: "ACCEPTED", atSeq: old.filedSeq, rule: "law39.transfer" }, // bookkeeping, never rewarded
    }
    fxActSync(aliasId, "LABEL")
    // plural (A+A): the relic's own claim hands over — the alias row IS the transferred hold,
    // in the relic's old position; other concepts' holds on the word are untouched.
    const l = state.names[old.nameNorm]!
    l[l.indexOf(old.id)] = aliasId
    notes.push(`name '${old.nameNorm}' transferred to ${succId} as alias`)
  }
}

/** Amendment 18 decision 64 (Law 24): a raid opened under the amendment that fails returns the raiders' coins
 *  (RAID_FAILED_REFUND) and leaves every attestation open, so the act stays attested and keeps its route (Law 31).
 *  Before it: the attesters win the raid pool and every stake on the act settles. */
function settleFailedRaid(state: CoreState, raid: Raid, notes: string[]) {
  const tkey = targetKey(raid.targetType, raid.targetId)
  if (raid.refundsRaiders) {
    const returned = refundOpenStakes(state, tkey, "RAID", { reason: RAID_FAILED_REFUND })
    notes.push(`raid ${raid.id} failed — ${returned} base returned to the raiders; the attestations stand (Law 24; Amendment 18)`)
  } else {
    settleOpenStakes(state, tkey, "ACCEPTED", notes) // the attesters win the raid pool
  }
}

function executeRaidDismissal(state: CoreState, raid: Raid, notes: string[]) {
  raid.status = "DISMISSED"
  fxStatus("screen-status", raid.id, "RAID", "DISMISSED")
  // frivolous raid: raiders forfeit to the attesters (under Amendment 18, are refunded); the screen settles HARD
  // against ADVANCE voters — the raid was the hard layer and they backed it.
  settleFailedRaid(state, raid, notes)
  settleMarketVotes(state, targetKey("RAID", raid.id), "REJECTED", 1000n)
  notes.push(`raid ${raid.id} DISMISSED`)
}

function executeRaidAdvance(state: CoreState, raid: Raid, nowTs: string, notes: string[]) {
  let frozen = 0n
  for (const s of state.stakes[targetKey(raid.targetType, raid.targetId)] ?? []) {
    if (s.status === "OPEN" && s.side === "ATTEST") frozen += s.amountBase
  }
  raid.frozenAttestBase = frozen
  raid.status = "COALITION"
  fxStatus("screen-status", raid.id, "RAID", "COALITION")
  raid.advancedTs = nowTs
  settleMarketVotes(state, targetKey("RAID", raid.id), "ACCEPTED", 1000n)
  notes.push(`raid ${raid.id} ADVANCED (parity target ${frozen})`)
  checkParity(state, raid, nowTs, notes)
}

/** COALITION → COURT when raid coins ≥ the frozen attester pool AND ≥ K distinct raiders. */
export function checkParity(state: CoreState, raid: Raid, nowTs: string, notes: string[]) {
  if (raid.status !== "COALITION") return
  let coins = 0n
  const raiders = new Set<string>()
  const outside = lineageOnlyAgentFps(state) // Law 38c-iv: breadth counts House-backed raiders only
  for (const s of state.stakes[targetKey(raid.targetType, raid.targetId)] ?? []) {
    if (s.status === "OPEN" && s.side === "RAID") {
      coins += s.amountBase
      if (!outside.has(s.fp)) raiders.add(s.fp)
    }
  }
  const K = quorumMinJudges(activeJudges(state, nowTs), dialNum(state.dials, "QUORUM_FLOOR"), dialNum(state.dials, "QUORUM_CEILING"))
  if (coins >= (raid.frozenAttestBase ?? 0n) && raiders.size >= K) {
    raid.status = "COURT"
    fxStatus("screen-status", raid.id, "RAID", "COURT")
    notes.push(`raid ${raid.id} reached COURT (conviction parity, ${raiders.size} raiders)`)
  }
}

/** The court's binding verdict — only the court strikes confirmed truth (Law 24). */
export function executeRaidRuling(state: CoreState, raid: Raid, verdict: "STRUCK" | "UPHELD", atSeq: number, notes: string[]) {
  raid.status = verdict
  fxStatus("screen-status", raid.id, "RAID", verdict)
  const tkey = targetKey(raid.targetType, raid.targetId)
  if (verdict === "STRUCK") {
    strikeConfirmed(state, state.acts[raid.targetId], atSeq, "court.raid", notes)
    settleOpenStakes(state, tkey, "REJECTED", notes) // the raiders win the attester pool
    settleMarketVotes(state, targetKey("RAID", raid.id), "ACCEPTED", 1000n) // early rulings settle leftover screen votes
  } else {
    settleFailedRaid(state, raid, notes) // the attesters win the raid pool — or, under Amendment 18, keep their positions
    settleMarketVotes(state, targetKey("RAID", raid.id), "REJECTED", 1000n)
  }
  notes.push(`raid ${raid.id} ${verdict}`)
}

/** Coalition TTL — fires on TICK and on the contest-door join-sweep, both deterministic.
 *  Co-raiders are refunded; the attester pool stands untouched. */
export function expireStaleCoalitions(state: CoreState, nowTs: string, notes: string[], onlyTargetId?: string) {
  const ttl = dialNum(state.dials, "RAID_COALITION_TTL_MS")
  for (const id of Object.keys(state.raids).sort()) {
    const r = state.raids[id]
    if (r.status !== "COALITION" || !r.advancedTs) continue
    if (onlyTargetId && r.targetId !== onlyTargetId) continue
    if (Date.parse(nowTs) - Date.parse(r.advancedTs) < ttl) continue
    refundOpenStakes(state, targetKey(r.targetType, r.targetId), "RAID")
    r.status = "EXPIRED"
    fxStatus("screen-status", r.id, "RAID", "EXPIRED")
    notes.push(`raid ${id} EXPIRED — co-raiders refunded`)
  }
}

// ── Law 31e — screens expire (Amendment 15, payoff.v2) ──────────────────────────────

/**
 * A contest screen that has not concluded within CHALLENGE_TTL_MS of its filing (or its last
 * rebase) — or, once parked for the court, of its parking — expires on the next tick. Expiry
 * decides nothing: every judge's stake returns untouched, a challenge's burned filing stake is
 * refunded to the challenger by a compensation mint (the burn is then marked compensated, so a
 * COMPENSATION cannot refund it twice), a raid's coins return to the raiders, and the target stands
 * exactly as it stood.
 *
 * The refund carries its own reason, CHALLENGE_EXPIRED_REFUND, rather than borrowing COMPENSATION:
 * a refund the clock made and a refund the court made are different facts, and a trace that names
 * which is findable (the projector's coin assay whitelists it as a mint).
 *
 * Clocks are stamped only under v2, so nothing before activation changes hash. A screen that is
 * open at activation carries no stamp: the first tick after activation stamps it and moves on, which
 * is what "counts its seven days from activation" means. No-op under v1 or while the TTL is absent.
 */
export function sweepScreens(state: CoreState, tick: EventEnvelope, notes: string[]) {
  if (payoffRuleVersion(state.dials) < 2) return
  const ttl = dialNumOr(state.dials, "CHALLENGE_TTL_MS", 0)
  if (ttl <= 0) return
  const now = Date.parse(tick.ts)
  const expired = (started: string | undefined, stamp: () => void): boolean => {
    if (!started) { stamp(); return false }
    return now - Date.parse(started) >= ttl
  }
  for (const id of Object.keys(state.challenges).sort()) {
    const c = state.challenges[id]
    if (c.status !== "PENDING") continue
    const parked = !!c.parked || c.v2?.phase === "PARKED"
    const due = parked
      ? expired(c.parkedTs, () => { c.parkedTs = tick.ts })
      : expired(c.filedTs, () => { c.filedTs = tick.ts })
    if (!due) continue
    refundMarketVotes(state, targetKey("CHALLENGE", c.id))
    let refunded = false
    const burn = state.burns[String(c.filedSeq)]
    if (burn && !burn.compensated) {
      // The burn is keyed by the filing seq, so it can only be this challenger's — anything else is
      // a corrupt fold, and a corrupt fold halts (D1) rather than quietly paying or not paying.
      if (burn.fp !== c.authorFp) throw new Error(`challenge ${c.id}: burn at seq ${c.filedSeq} belongs to ${burn.fp}, not its author ${c.authorFp}`)
      state.actors[burn.fp].balanceBase += burn.amountBase
      fxCoinCredit(burn.fp, burn.amountBase, "CHALLENGE_EXPIRED_REFUND", c.id)
      state.supply.coinMintedBase += burn.amountBase // the refund mints exactly what the filing burned
      burn.compensated = true
      refunded = true
    }
    c.status = "EXPIRED"
    fxStatus("screen-status", c.id, "CHALLENGE", "EXPIRED")
    notes.push(`challenge ${c.id} EXPIRED (Law 31e) — market refunded${refunded ? ", filing stake refunded" : ""}; the target stands`)
  }
  for (const id of Object.keys(state.raids).sort()) {
    const r = state.raids[id]
    if (r.status !== "SCREEN") continue // COALITION has Law 24's own TTL; COURT waits for the court
    const parked = !!r.parked || r.v2?.phase === "PARKED"
    const due = parked
      ? expired(r.parkedTs, () => { r.parkedTs = tick.ts })
      : expired(r.openedTs, () => { r.openedTs = tick.ts })
    if (!due) continue
    refundMarketVotes(state, targetKey("RAID", r.id))
    refundOpenStakes(state, targetKey(r.targetType, r.targetId), "RAID")
    r.status = "EXPIRED"
    fxStatus("screen-status", r.id, "RAID", "EXPIRED")
    notes.push(`raid ${r.id} EXPIRED at the screen (Law 31e) — raiders and judges refunded; the pool stands`)
  }
}

// ── screen.v2 — sortition + sealed votes (DORMANT until the dial turns by amendment) ─────

export function screenV2Active(state: CoreState): boolean {
  const v = dialNum(state.dials, "SCREEN_RULE_VERSION")
  if (v !== 1 && v !== 2) throw new Error(`screen rule v${v} is ratified but not implemented — refusing to fold under unknown law`)
  return v === 2
}

/** The live v2 screen behind a commit/reveal, or a refusal naming why. */
function v2Screen(state: CoreState, tt: string | null, tid: string | null):
  { screen: Challenge | Raid; v2: ScreenV2; key: string } | string {
  if (tt === "CHALLENGE") {
    const c = tid ? state.challenges[tid] : undefined
    if (!c) return "no such contest"
    if (c.status !== "PENDING") return `this contest is already resolved (${c.status})`
    const stale = staleDefinitionHead(state, c)
    if (stale) return `this challenge is stale against definition ${stale.id} — rebase it before asking jurors to vote`
    if (!c.v2) return "this screen predates screen.v2 — it is judged by open VOTE_CAST"
    return { screen: c, v2: c.v2, key: targetKey("CHALLENGE", c.id) }
  }
  if (tt === "RAID") {
    const r = tid ? state.raids[tid] : undefined
    if (!r) return "no such raid"
    if (r.status !== "SCREEN") return "this raid is past the screening stage"
    if (!r.v2) return "this screen predates screen.v2 — it is judged by open VOTE_CAST"
    return { screen: r, v2: r.v2, key: targetKey("RAID", r.id) }
  }
  return "sealed votes exist only on contest screens (CHALLENGE | RAID)"
}

export const commitHashOf = (vote: string, stakeMilli: string, salt: string): string =>
  sha256(`${vote}|${stakeMilli}|${salt}`)

export function validateCommit(state: CoreState, e: Pick<EventEnvelope, "actor" | "payload">): string | null {
  const p = e.payload
  const found = v2Screen(state, str(p, "targetType"), str(p, "targetId"))
  if (typeof found === "string") return found
  const { v2 } = found
  if (v2.phase !== "COMMIT") return `the screen is in its ${v2.phase} phase — commits land only in COMMIT`
  if (!v2.juryFps?.includes(e.actor)) return "you are not on this screen's jury (the draw is on the record)"
  if (v2.commits?.[e.actor]) return "sealed means one shot — your commit stands until reveal"
  const h = str(p, "commitHash")
  if (!h || !/^[0-9a-f]{64}$/.test(h)) return "commitHash must be sha256 hex of `vote|stakeMilli|salt`"
  return null
}

export function applyCommit(state: CoreState, e: EventEnvelope, notes: string[]) {
  const p = e.payload
  const found = v2Screen(state, str(p, "targetType"), str(p, "targetId")) as { screen: Challenge | Raid; v2: ScreenV2; key: string }
  const { v2 } = found
  ;(v2.commits ??= {})[e.actor] = p.commitHash as string
  notes.push(`sealed commit ${Object.keys(v2.commits).length}/${v2.juryFps!.length}`)
  if (Object.keys(v2.commits).length === v2.juryFps!.length) {
    v2.phase = "REVEAL"
    v2.phaseTs = e.ts
    notes.push("all jurors committed — the reveal opens")
  }
}

export function validateReveal(state: CoreState, e: Pick<EventEnvelope, "actor" | "payload">): string | null {
  const p = e.payload
  const found = v2Screen(state, str(p, "targetType"), str(p, "targetId"))
  if (typeof found === "string") return found
  const { v2, key } = found
  if (v2.phase !== "REVEAL") return `the screen is in its ${v2.phase} phase — reveals land only in REVEAL`
  const commit = v2.commits?.[e.actor]
  if (!commit) return "no commit of yours to reveal"
  if (state.votes[key]?.[e.actor]) return "already revealed"
  const vote = str(p, "vote")
  const stake = str(p, "stakeMilli")
  const salt = str(p, "salt")
  if ((vote !== "ADVANCE" && vote !== "STRIKE") || !stake || !/^[0-9]+$/.test(stake) || !salt) return "vote, stakeMilli, salt required"
  if (commitHashOf(vote, stake, salt) !== commit) return "reveal does not match your sealed commit — the hash is the vow"
  const judge = state.actors[e.actor]
  // Law 31b-i: the human juror's floor is its own dial (0 in force — the voice needs no purse)
  const floorMilli = judge.entityType === "user"
    ? dialBig(state.dials, "SCREEN_HUMAN_STAKE_MIN_MILLI")
    : dialBig(state.dials, "MIN_JUDGE_STAKE_MILLI")
  if (BigInt(stake) < floorMilli) return "stake below the judging floor"
  if (BigInt(stake) > 0n && judge.openStakeMilli + BigInt(stake) > judge.repMilli) return "insufficient uncommitted reputation at reveal"
  return null
}

export function applyReveal(state: CoreState, e: EventEnvelope, notes: string[]) {
  const p = e.payload
  const tt = str(p, "targetType")!
  const tid = str(p, "targetId")!
  const key = targetKey(tt, tid)
  const judge = state.actors[e.actor]
  const stake = BigInt(p.stakeMilli as string)
  ;(state.votes[key] ??= {})[e.actor] = { dir: p.vote as "ADVANCE" | "STRIKE", stakeMilli: stake, ts: e.ts }
  judge.openStakeMilli += stake
  judge.lastVoteTs = e.ts
  notes.push(`revealed ${p.vote}`)
  // the crossing evaluates on each reveal — same D1 trigger discipline as open screens
  if (tt === "CHALLENGE") evaluateChallengeScreen(state, state.challenges[tid], e, notes)
  else evaluateRaidScreen(state, state.raids[tid], e, notes)
}

/** The clock's duties for sealed screens, folded on TICK: draw juries (fresh entropy no
 *  filer can grind), close commit windows (alternates if the panel went quiet), close
 *  reveal windows (evaluate what stands, or park for the court — Law 24's backstop). */
export function sweepScreensV2(state: CoreState, tick: EventEnvelope, notes: string[]) {
  const screens: { screen: Challenge | Raid; v2: ScreenV2; tt: string; id: string }[] = []
  for (const id of Object.keys(state.challenges).sort()) {
    const c = state.challenges[id]
    if (c.status === "PENDING" && c.v2) screens.push({ screen: c, v2: c.v2, tt: "CHALLENGE", id })
  }
  for (const id of Object.keys(state.raids).sort()) {
    const r = state.raids[id]
    if (r.status === "SCREEN" && r.v2) screens.push({ screen: r, v2: r.v2, tt: "RAID", id })
  }
  for (const { screen, v2, tt, id } of screens) {
    const elapsed = Date.parse(tick.ts) - Date.parse(v2.phaseTs)
    if (v2.phase === "JURY") {
      const exclude = tt === "CHALLENGE" ? [(screen as Challenge).authorFp] : [(screen as Raid).openedByFp]
      const pool = eligibleJurors(state, screen, exclude)
      if (!pool.humans.length && !pool.agents.length) {
        v2.phase = "PARKED"
        v2.phaseTs = tick.ts
        notes.push(`screen ${id}: no eligible jurors — parked for the court`)
        continue
      }
      const seed = drawSeed(tick.hash, id)
      v2.jurySeed = seed
      v2.juryFps = drawJury(seed, pool, jurySize(state), dialNum(state.dials, "JURY_MIN_HUMANS"))
      v2.commits = {}
      v2.altRounds = 0
      v2.phase = "COMMIT"
      v2.phaseTs = tick.ts
      notes.push(`jury drawn for ${id}: ${v2.juryFps.length} seats (seed from the clock, not the filer)`)
    } else if (v2.phase === "COMMIT" && elapsed >= dialNum(state.dials, "COMMIT_WINDOW_MS")) {
      const committed = Object.keys(v2.commits ?? {}).length
      const bar = quorumMinJudges(activeJudges(state, tick.ts), dialNum(state.dials, "QUORUM_FLOOR"), dialNum(state.dials, "QUORUM_CEILING"))
      if (committed < bar && (v2.altRounds ?? 0) < dialNum(state.dials, "JURY_ALTERNATE_ROUNDS")) {
        const exclude = [...(v2.juryFps ?? []), ...(tt === "CHALLENGE" ? [(screen as Challenge).authorFp] : [(screen as Raid).openedByFp])]
        const pool = eligibleJurors(state, screen, exclude)
        const round = (v2.altRounds ?? 0) + 1
        const alternates = drawJury(nextSeed(v2.jurySeed!, round), pool, bar - committed + dialNum(state.dials, "JURY_EXTRA"), dialNum(state.dials, "JURY_MIN_HUMANS"))
        v2.juryFps = [...(v2.juryFps ?? []), ...alternates].sort()
        v2.altRounds = round
        v2.phaseTs = tick.ts // the window restarts for the widened panel
        notes.push(`screen ${id}: panel quiet — ${alternates.length} alternates drawn (round ${round})`)
      } else {
        v2.phase = "REVEAL"
        v2.phaseTs = tick.ts
        notes.push(`screen ${id}: commit window closed (${committed} sealed) — the reveal opens`)
      }
    } else if (v2.phase === "REVEAL" && elapsed >= dialNum(state.dials, "REVEAL_WINDOW_MS")) {
      // final evaluation with what stands; a screen that cannot conclude goes to the court
      if (tt === "CHALLENGE") evaluateChallengeScreen(state, screen as Challenge, tick, notes)
      else evaluateRaidScreen(state, screen as Raid, tick, notes)
      const still = tt === "CHALLENGE" ? (screen as Challenge).status === "PENDING" : (screen as Raid).status === "SCREEN"
      if (still && v2.phase === "REVEAL") {
        v2.phase = "PARKED"
        v2.phaseTs = tick.ts
        notes.push(`screen ${id}: reveal window closed without a verdict — parked for the court (Law 24)`)
      }
    }
  }
}
