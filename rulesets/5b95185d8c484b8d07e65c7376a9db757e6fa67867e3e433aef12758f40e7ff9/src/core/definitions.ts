import type { ActState, CoreState } from "./types"
import { isDead } from "./types"

/** The one definition currently occupying an entry's ordinary filing lane.
 *
 * Rejected and superseded carvings remain in the version history but do not block another
 * attempt. A provisional carving does: parallel versions let an author put several copies of
 * the same reward in front of the quorum before any one of them rules. An accepted carving does
 * too: changing confirmed text is a Law 30 REPLACE, not another ordinary paid filing.
 */
export function liveDefinitionFor(state: CoreState, entryId: string): ActState | null {
  let live: ActState | null = null
  for (const id of Object.keys(state.acts).sort()) {
    const a = state.acts[id]
    if (a.kind !== "DEFINITION" || a.entryId !== entryId || isDead(a.status)) continue
    if (!live || a.filedSeq > live.filedSeq || (a.filedSeq === live.filedSeq && a.id > live.id)) live = a
  }
  return live
}

/** The accepted definition that presently heads an entry's carving history. */
export function acceptedDefinitionHead(state: CoreState, entryId: string): ActState | null {
  let head: ActState | null = null
  for (const id of Object.keys(state.acts).sort()) {
    const a = state.acts[id]
    if (a.kind !== "DEFINITION" || a.entryId !== entryId || a.status !== "ACCEPTED") continue
    if (!head || (a.version ?? 0) > (head.version ?? 0) ||
        ((a.version ?? 0) === (head.version ?? 0) && a.filedSeq > head.filedSeq) ||
        ((a.version ?? 0) === (head.version ?? 0) && a.filedSeq === head.filedSeq && a.id > head.id)) {
      head = a
    }
  }
  return head
}

/**
 * A definition's next version, derived from the fold.
 *
 * Filings and Law 30 replacement successors must use this same function: both create a new
 * definition of an existing entry, and both count rejected and superseded versions because
 * those versions remain part of the append-only history.
 *
 * Counts, rather than maxes, because the genesis snapshots were verified contiguous per entry.
 */
export function nextDefinitionVersion(state: CoreState, entryId: string): number {
  let n = 0
  for (const id of Object.keys(state.acts)) {
    const a = state.acts[id]
    if (a.kind === "DEFINITION" && a.entryId === entryId) n++
  }
  return n + 1
}

/**
 * Law 6 — the display trailer every definition ends with:
 *   [formal: <latin> | substrate: mind|behavior|matter | horizon: a moment|hours|a life|generations|centuries|as-long-as-us | explicit: yes|no | epoch: 0.NN]
 * Enforced at the door from Amendment 16 (Part G; keeper, 2026-10-06: "code should enforce it").
 * The five fields in that order, the law's own words for substrate, horizon and explicit (any case),
 * and an epoch of 0.NN. Whether `formal` is good Latin is the judges' call, so it need only be present.
 * Standing definitions without it are not touched; they are ordinary contest targets.
 */
const TRAILER = /\[\s*formal\s*:\s*([^|\]]*?)\s*\|\s*substrate\s*:\s*([^|\]]*?)\s*\|\s*horizon\s*:\s*([^|\]]*?)\s*\|\s*explicit\s*:\s*([^|\]]*?)\s*\|\s*epoch\s*:\s*([^|\]]*?)\s*\]\s*$/i
const SUBSTRATES = new Set(["mind", "behavior", "matter"])
const HORIZONS = new Set(["a moment", "hours", "a life", "generations", "centuries", "as-long-as-us"])
export function trailerError(body: string): string | null {
  const shape = "[formal: <latin> | substrate: mind|behavior|matter | horizon: a moment|hours|a life|generations|centuries|as-long-as-us | explicit: yes|no | epoch: 0.NN]"
  const m = TRAILER.exec(body)
  if (!m) return `a definition ends with the Law 6 trailer: ${shape}`
  const [, formal, substrate, horizon, explicit, epoch] = m
  if (!formal) return "the Law 6 trailer's formal name is empty"
  if (!SUBSTRATES.has(substrate.toLowerCase())) return `Law 6 substrate is mind, behavior or matter — not "${substrate}"`
  if (!HORIZONS.has(horizon.toLowerCase())) return `Law 6 horizon is one of: ${[...HORIZONS].join(", ")} — not "${horizon}"`
  if (!/^(yes|no)$/i.test(explicit)) return `Law 6 explicit is yes or no — not "${explicit}"`
  if (!/^0\.\d\d$/.test(epoch)) return `Law 6 epoch is 0.NN — not "${epoch}"`
  return null
}
