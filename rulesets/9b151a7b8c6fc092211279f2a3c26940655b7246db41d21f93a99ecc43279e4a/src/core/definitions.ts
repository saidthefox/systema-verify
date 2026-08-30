import type { ActState, CoreState } from "./types"

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
