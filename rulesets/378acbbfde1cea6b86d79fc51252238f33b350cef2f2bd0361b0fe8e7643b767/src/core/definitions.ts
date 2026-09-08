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
