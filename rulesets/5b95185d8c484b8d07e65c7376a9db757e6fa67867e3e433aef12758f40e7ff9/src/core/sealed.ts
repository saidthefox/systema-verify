import type { CoreState, EventEnvelope, SealedMarket } from "./types"
import { targetKey } from "./types"
import { amendment16Version, dialBig, dialNum } from "./dials"
import { activeJudges, lineageOnlyAgentFps, quorumCrossing, quorumMinJudges } from "./math"
import { liveDefinitionFor } from "./definitions"
import { LIMITS, firstTooLong } from "./limits"
import { commitHashOf } from "./ladder"
import { fxRep, ruleProvisionalAct } from "./effects"

/**
 * Amendment 16 Part B (Laws 18–19): judgments on acts are sealed. A judge commits to a hidden
 * side with a visible stake (VOTE_COMMIT, `commitHash = sha256(vote|stakeMilli|salt)`), and reveals
 * it later (VOTE_REVEAL). Only revealed stakes count, and no weight is capped.
 *
 * A market runs in rounds. In COMMIT, judges commit and nothing new is revealed. When the judges
 * with a position (revealed in an earlier round, or committed in this one) reach the Law 18 bar, the
 * reveal opens; from then no one commits until the round ends. The round ends when every commitment
 * is revealed, or on the first TICK after `REVEAL_WINDOW_MS`. A commitment still sealed then
 * forfeits half its stake (burned, like every reputation forfeit) and the other half is released.
 * The market is judged once, at the end of the round, on its revealed stakes: a crossing rules the
 * act; otherwise the revealed positions stand and a new round opens. A judge may commit again in a
 * later round, and the new reveal replaces their standing position (Law 26: reconsideration stays
 * free until the act is ruled).
 *
 * The market is never evaluated on a partial reveal, so the order in which judges reveal decides
 * nothing. Within a round no judge sees another's side before committing their own; positions
 * revealed in an earlier round are on the record, as every recorded fact is.
 *
 * A ruling by any other path (the court, a cascade, a void) releases open commitments in full.
 */

export const isActMarket = (targetType: string | null): boolean =>
  !!targetType && targetType !== "CHALLENGE" && targetType !== "RAID"

export const sealedActMarkets = (state: CoreState): boolean => amendment16Version(state.dials) >= 1

const SALT_MAX = 200

/** Who may judge this act at all: the checks an open vote on an act has always passed. */
export function actJudgmentError(state: CoreState, actorFp: string, tt: string, tid: string): string | null {
  const act = state.acts[tid]
  if (!act || act.kind !== tt) return "target not found"
  if (act.collisionParentId) return "a declared collision has one judgment target — judge the filing, not its derived edge (Law 39)"
  if (act.status !== "PROVISIONAL") return "already ruled — nothing left to judge"
  if (act.authorFp === actorFp) return "you cannot judge your own act (Law 15)"
  if (act.collisionWithEntryId) {
    const proposedEntryId = act.kind === "ENTRY" ? act.id : act.kind === "LABEL" ? act.entryId : null
    if (!proposedEntryId || !liveDefinitionFor(state, proposedEntryId)) {
      return "collision petition is half-born — its proposed concept needs a live definition before judgment (Laws 5/39)"
    }
  }
  return null
}

const stakeText = (v: unknown): string | null => (typeof v === "string" && /^(0|[1-9][0-9]{0,30})$/.test(v) ? v : null)

export function validateActCommit(state: CoreState, e: Pick<EventEnvelope, "actor" | "payload">): string | null {
  const p = e.payload
  const judge = state.actors[e.actor]
  if (!judge || (judge.entityType !== "agent" && judge.entityType !== "user")) return "unknown judge"
  const tt = p.targetType as string
  const tid = typeof p.targetId === "string" ? p.targetId : ""
  const err = actJudgmentError(state, e.actor, tt, tid)
  if (err) return err
  const stake = stakeText(p.stakeMilli)
  const hash = p.commitHash
  if (!stake || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
    return "commitHash (sha256 hex of `vote|stakeMilli|salt`) and stakeMilli required"
  }
  if (p.vote !== undefined || p.reasoning !== undefined) return "a sealed commitment carries neither its side nor its reasoning — reveal them"
  if (BigInt(stake) < dialBig(state.dials, "MIN_JUDGE_STAKE_MILLI")) return "stake below the judging floor"
  if (judge.openStakeMilli + BigInt(stake) > judge.repMilli) return "insufficient uncommitted reputation"
  const market = state.sealed?.[targetKey(tt, tid)]
  if (market?.phase === "REVEAL") return "this market is revealing — commit when its round ends (Amendment 16, Part B)"
  if (market?.commits[e.actor]) return "you are already committed in this round — reveal it when the reveal opens"
  return null
}

export function applyActCommit(state: CoreState, e: EventEnvelope, notes: string[]) {
  const p = e.payload
  const key = targetKey(p.targetType as string, p.targetId as string)
  const stake = BigInt(p.stakeMilli as string)
  const market = ((state.sealed ??= {})[key] ??= { phase: "COMMIT", phaseTs: e.ts, round: 1, commits: {} })
  market.commits[e.actor] = { hash: p.commitHash as string, stakeMilli: stake, ts: e.ts }
  const judge = state.actors[e.actor]
  judge.openStakeMilli += stake
  judge.lastVoteTs = e.ts // a sealed judgment is a judgment cast (Law 18's judging population)
  notes.push(`sealed commitment ${Object.keys(market.commits).length} in round ${market.round} (Amendment 16, Part B)`)
  openRevealIfReady(state, key, market, e.ts, notes)
}

export function validateActReveal(state: CoreState, e: Pick<EventEnvelope, "actor" | "payload">): string | null {
  const p = e.payload
  const tt = p.targetType as string
  const tid = typeof p.targetId === "string" ? p.targetId : ""
  const market = state.sealed?.[targetKey(tt, tid)]
  if (!market) return "no sealed market on that act"
  if (market.phase !== "REVEAL") return "the reveal has not opened — it opens when enough judges have committed"
  const commit = market.commits[e.actor]
  if (!commit) return "no sealed commitment of yours to reveal in this round"
  const vote = p.vote
  const stake = stakeText(p.stakeMilli)
  const salt = p.salt
  if ((vote !== "ADVANCE" && vote !== "STRIKE") || !stake || typeof salt !== "string" || !salt || salt.length > SALT_MAX) {
    return `vote, stakeMilli and salt (at most ${SALT_MAX} characters) required`
  }
  if (BigInt(stake) !== commit.stakeMilli || commitHashOf(vote, stake, salt) !== commit.hash) {
    return "reveal does not match your sealed commitment — the hash is the vow"
  }
  return firstTooLong([["reasoning", typeof p.reasoning === "string" ? p.reasoning : "", LIMITS.REASONING]])
}

export function applyActReveal(state: CoreState, e: EventEnvelope, notes: string[]) {
  const p = e.payload
  const key = targetKey(p.targetType as string, p.targetId as string)
  const market = state.sealed![key]
  const commit = market.commits[e.actor]
  delete market.commits[e.actor]
  const votes = (state.votes[key] ??= {})
  const judge = state.actors[e.actor]
  const prior = votes[e.actor]
  if (prior) judge.openStakeMilli -= prior.stakeMilli // the revealed position replaces the standing one
  votes[e.actor] = { dir: p.vote as "ADVANCE" | "STRIKE", stakeMilli: commit.stakeMilli, ts: e.ts }
  judge.lastVoteTs = e.ts
  notes.push(`revealed ${p.vote as string}${prior ? ` (replacing ${prior.dir})` : ""}`)
  if (!Object.keys(market.commits).length) endRound(state, key, market, e, notes)
}

/** Judges holding a position on this market that the Law 18 bar counts (staked, not Lineage-only). */
function positionedJudges(state: CoreState, key: string, market: SealedMarket): number {
  const outside = lineageOnlyAgentFps(state)
  const fps = new Set<string>()
  for (const [fp, v] of Object.entries(state.votes[key] ?? {})) if (v.stakeMilli > 0n && !outside.has(fp)) fps.add(fp)
  for (const [fp, c] of Object.entries(market.commits)) if (c.stakeMilli > 0n && !outside.has(fp)) fps.add(fp)
  return fps.size
}

function openRevealIfReady(state: CoreState, key: string, market: SealedMarket, ts: string, notes: string[]) {
  if (market.phase !== "COMMIT" || !Object.keys(market.commits).length) return
  const bar = quorumMinJudges(activeJudges(state, ts), dialNum(state.dials, "QUORUM_FLOOR"), dialNum(state.dials, "QUORUM_CEILING"))
  if (positionedJudges(state, key, market) < bar) return
  market.phase = "REVEAL"
  market.phaseTs = ts
  notes.push(`${key}: ${Object.keys(market.commits).length} sealed, the bar of ${bar} judges is met — the reveal opens`)
}

/** The round ends: forfeit what stayed sealed, judge what was revealed, rule or open the next round. */
function endRound(state: CoreState, key: string, market: SealedMarket, e: Pick<EventEnvelope, "seq" | "ts">, notes: string[]) {
  for (const fp of Object.keys(market.commits).sort()) {
    const stake = market.commits[fp].stakeMilli
    const forfeit = stake / 2n
    const judge = state.actors[fp]
    judge.openStakeMilli -= stake
    judge.repMilli -= forfeit
    state.supply.repBurnedMilli += forfeit
    fxRep(fp)
    notes.push(`${fp.slice(0, 12)} never revealed — ${forfeit} milli of ${stake} forfeited (Amendment 16, Part B)`)
  }
  market.commits = {}
  const tid = key.slice(key.indexOf(":") + 1)
  const ver = dialNum(state.dials, "QUORUM_RULE_VERSION")
  if (ver !== 1) throw new Error(`quorum rule v${ver} is ratified but not implemented in this reducer — upgrade before folding`)
  const crossing = quorumCrossing(state, state.votes[key] ?? {}, e.ts)
  if (crossing) {
    delete state.sealed![key]
    notes.push(`quorum ${crossing.status} on revealed stakes (round ${market.round})`)
    ruleProvisionalAct(state, state.acts[tid], crossing.status, `quorum.v${ver}.sealed`, e.seq, notes)
    return
  }
  market.round += 1
  market.phase = "COMMIT"
  market.phaseTs = e.ts
  notes.push(`${key}: round ${market.round - 1} revealed no crossing — the market stays open (round ${market.round})`)
}

/** The clock's duties for sealed act markets, on TICK: open reveals the bar now allows, close reveal windows. */
export function sweepSealedMarkets(state: CoreState, tick: EventEnvelope, notes: string[]) {
  if (!state.sealed) return
  for (const key of Object.keys(state.sealed).sort()) {
    const market = state.sealed[key]
    if (!market) continue // ruled within this sweep: a struck entry cascades to its dependents' markets
    if (market.phase === "COMMIT") openRevealIfReady(state, key, market, tick.ts, notes)
    else if (Date.parse(tick.ts) - Date.parse(market.phaseTs) >= dialNum(state.dials, "REVEAL_WINDOW_MS")) {
      endRound(state, key, market, tick, notes)
    }
  }
}
