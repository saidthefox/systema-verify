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
 * From Amendment 17 (Part G item 5; keeper's decision 27) a new trailer has four fields, the epoch gone:
 *   [formal: <latin> | substrate: mind|behavior|matter | horizon: ... | explicit: yes|no]
 * and one that still carries an epoch is refused, free, with its fix. Standing definitions keep theirs.
 *
 * The trailer is found by `findTrailer`, which decides exactly what this regular expression decided
 * (Amendment 16 as recorded) — the same match or none, at the same index, with the same five fields:
 *
 *   /\[\s*formal\s*:\s*([^|\]]*?)\s*\|\s*substrate\s*:\s*([^|\]]*?)\s*\|\s*horizon\s*:\s*([^|\]]*?)\s*\|\s*explicit\s*:\s*([^|\]]*?)\s*\|\s*epoch\s*:\s*([^|\]]*?)\s*\]\s*$/i
 *
 * but in one linear pass. The expression backtracks: each field is `\s*` + a lazy group that may also
 * take whitespace + `\s*`, so a body that does not match is re-split every possible way, field after
 * field. On Node 24, "[formal: a | substrate: " and 1,500 spaces took 3.5 s, and five fields padded
 * with runs of eight spaces (162 characters) took 72 s — on the app's one event loop, for one refusal.
 * The differential test in __tests__/trailer.test.ts holds the two to the same verdicts.
 */
/** JavaScript's `\s` (and what String.prototype.trim removes): WhiteSpace and LineTerminator. */
function isSpace(c: number): boolean {
  return c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
}
const OPEN = 0x5b, CLOSE = 0x5d, BAR = 0x7c, COLON = 0x3a // [ ] | :
/** Where `field\s*:` (field matched as `/i` without `u` matches it: ASCII letters in either case, no
 * other character) begins at `at` after optional whitespace: the index after the colon, or -1. */
function fieldHead(body: string, at: number, field: string): number {
  let i = at
  while (i < body.length && isSpace(body.charCodeAt(i))) i++
  for (let k = 0; k < field.length; k++, i++) {
    let c = body.charCodeAt(i)
    if (c >= 0x41 && c <= 0x5a) c += 0x20
    if (c !== field.charCodeAt(k)) return -1
  }
  while (i < body.length && isSpace(body.charCodeAt(i))) i++
  return body.charCodeAt(i) === COLON ? i + 1 : -1
}
/** A field's value: its text between the colon and the next `|` or `]`, whitespace trimmed at both ends
 * (the greedy `\s*` either side of the lazy group); all whitespace is "". */
function fieldValue(body: string, from: number, to: number): string {
  while (from < to && isSpace(body.charCodeAt(from))) from++
  while (to > from && isSpace(body.charCodeAt(to - 1))) to--
  return body.slice(from, to)
}
/** The last `|` or `]` before `before`, or -1. */
function delimiterBefore(body: string, before: number): number {
  let i = before - 1
  while (i >= 0) {
    const c = body.charCodeAt(i)
    if (c === BAR || c === CLOSE) return i
    i--
  }
  return -1
}
export interface Trailer { index: number; formal: string; substrate: string; horizon: string; explicit: string; epoch: string }
/** Amendment 17's trailer (Part G item 5): Amendment 16's without the epoch. */
export interface TrailerA17 { index: number; formal: string; substrate: string; horizon: string; explicit: string }
/** How many fields the Law 6 trailer in force has: five under Amendment 16, four (no epoch) under 17. */
export type TrailerFields = 5 | 4
const FIELDS_AFTER_FORMAL: Record<TrailerFields, readonly string[]> = {
  5: ["substrate", "horizon", "explicit", "epoch"],
  4: ["substrate", "horizon", "explicit"],
}
/**
 * The one pass behind both shapes: where the trailer opens and its field values in order (formal first),
 * or null. For `fields` 5 it is the Amendment 16 expression above; for 4 it is the same expression with
 * its `\s*\|\s*epoch\s*:\s*([^|\]]*?)` removed. No field value can hold `|` or `]`, and nothing else in a
 * trailer is one, so the trailer's `|`s and final `]` are the last `fields` of those characters in the
 * body: the `]` is the last character that is not whitespace, and each `|` the last `|` or `]` before the
 * one after it (a `]` there means no trailer). After each `|` comes its field's name and colon; before the
 * first `|`, after the `|` or `]` before it, the trailer opens at the leftmost `[` followed by `formal` and
 * a colon — the match the expression's left-to-right search returns. Every character is visited a bounded
 * number of times, whichever the shape.
 */
function scanTrailer(body: string, fields: TrailerFields): { index: number; values: string[] } | null {
  const names = FIELDS_AFTER_FORMAL[fields]
  let close = body.length - 1
  while (close >= 0 && isSpace(body.charCodeAt(close))) close--
  if (close < 0 || body.charCodeAt(close) !== CLOSE) return null
  const bars: number[] = new Array(names.length).fill(0)
  for (let k = names.length - 1, next = close; k >= 0; k--) {
    next = delimiterBefore(body, next)
    if (next < 0 || body.charCodeAt(next) !== BAR) return null
    bars[k] = next
  }
  const heads: number[] = []
  for (let k = 0; k < names.length; k++) {
    const value = fieldHead(body, bars[k] + 1, names[k])
    if (value < 0) return null
    heads.push(value)
  }
  for (let i = delimiterBefore(body, bars[0]) + 1; i < bars[0]; i++) {
    if (body.charCodeAt(i) !== OPEN) continue
    const formal = fieldHead(body, i + 1, "formal")
    if (formal < 0) continue
    const values = [fieldValue(body, formal, bars[0])]
    for (let k = 0; k < names.length; k++) values.push(fieldValue(body, heads[k], k + 1 < names.length ? bars[k + 1] : close))
    return { index: i, values }
  }
  return null
}
/**
 * The Law 6 trailer a body ends with, or null — the regular expression above, without backtracking.
 * Amendment 16's five fields; `findTrailerA17` reads Amendment 17's four.
 */
export function findTrailer(body: string): Trailer | null {
  const m = scanTrailer(body, 5)
  if (!m) return null
  const [formal, substrate, horizon, explicit, epoch] = m.values
  return { index: m.index, formal, substrate, horizon, explicit, epoch }
}
/** Amendment 17's four-field trailer (Part G item 5) a body ends with, or null: the expression above without
 * its epoch field, in the same one pass. A five-field trailer is not one (its last field is not `explicit`). */
export function findTrailerA17(body: string): TrailerA17 | null {
  const m = scanTrailer(body, 4)
  if (!m) return null
  const [formal, substrate, horizon, explicit] = m.values
  return { index: m.index, formal, substrate, horizon, explicit }
}
/** Where the trailer of the shape in force opens, or -1: what Law 6b's clause is read up to. */
export function trailerIndex(body: string, fields: TrailerFields): number {
  return scanTrailer(body, fields)?.index ?? -1
}
const SUBSTRATES = new Set(["mind", "behavior", "matter"])
const HORIZONS = new Set(["a moment", "hours", "a life", "generations", "centuries", "as-long-as-us"])
/** Amendment 17 Part G item 5 (keeper's decision 27): a new trailer that still carries an epoch is refused,
 * free, with the exact fix; the door never drops the field itself. The reducer adds "(Amendment 17)". */
export const TRAILER_EPOCH_DROPPED = 'Law 6: the trailer no longer carries an epoch — drop "| epoch: 0.NN"'
export const TRAILER_SHAPE_A16 = "[formal: <latin> | substrate: mind|behavior|matter | horizon: a moment|hours|a life|generations|centuries|as-long-as-us | explicit: yes|no | epoch: 0.NN]"
export const TRAILER_SHAPE_A17 = "[formal: <latin> | substrate: mind|behavior|matter | horizon: a moment|hours|a life|generations|centuries|as-long-as-us | explicit: yes|no]"
/**
 * The Law 6 trailer of the shape in force: `fields` 5 is Amendment 16's (Part G), the five fields with
 * an epoch of 0.NN, exactly as recorded; 4 is Amendment 17's (Part G item 5), the same without the epoch.
 * Under 4 a body that ends with Amendment 16's five-field trailer is refused with TRAILER_EPOCH_DROPPED,
 * whatever its fields hold, before anything else is read: the fix is to drop the field, and the other
 * fields are then read as any four-field trailer's. A five-field and a four-field trailer never both end
 * one body (the four-field trailer's last field is `explicit`, the five-field one's `epoch`).
 */
export function trailerError(body: string, fields: TrailerFields = 5): string | null {
  let m: TrailerA17 | null
  if (fields === 4) {
    m = findTrailerA17(body)
    if (!m) return findTrailer(body) ? TRAILER_EPOCH_DROPPED : `a definition ends with the Law 6 trailer: ${TRAILER_SHAPE_A17}`
  } else {
    m = findTrailer(body)
    if (!m) return `a definition ends with the Law 6 trailer: ${TRAILER_SHAPE_A16}`
  }
  const { formal, substrate, horizon, explicit } = m
  if (!formal) return "the Law 6 trailer's formal name is empty"
  if (!SUBSTRATES.has(substrate.toLowerCase())) return `Law 6 substrate is mind, behavior or matter — not "${substrate}"`
  if (!HORIZONS.has(horizon.toLowerCase())) return `Law 6 horizon is one of: ${[...HORIZONS].join(", ")} — not "${horizon}"`
  if (!/^(yes|no)$/i.test(explicit)) return `Law 6 explicit is yes or no — not "${explicit}"`
  if (fields === 5) {
    const { epoch } = m as Trailer
    if (!/^0\.\d\d$/.test(epoch)) return `Law 6 epoch is 0.NN — not "${epoch}"`
  }
  return null
}

/**
 * Law 6b — type specimens (Amendment 17, drafted 2026-10-13; keeper: "this belongs in the game", the
 * near-miss optional). Immediately before its Law 6 trailer a definition carries the examples clause:
 *   e.g.: <example>; <example>[; ...] [| not: <near-miss>[; ...]]
 * The door checks FORM only; whether each example is a genuine member under the definition's own carve
 * and pinned sense, and each near-miss a genuine non-member, is the judges' call (Law 11d):
 *   - the clause opens at the last `e.g.:` before the trailer (any case, spaces allowed before the colon;
 *     not run on from a preceding Unicode letter, mark or number, \p{L}\p{M}\p{N}) and runs to the trailer,
 *     from which any whitespace — a newline or spaces, or none — may separate it;
 *   - two to six examples, separated by `;`;
 *   - optionally one near-miss part, opened by `| not:` (any case, spaces allowed around `|` and `:`),
 *     naming one to three near-misses separated by `;`; the clause holds no other `|`;
 *   - no example begins with `not:` (any case, spaces allowed before the colon): a hand-written `; not: X`
 *     where `| not: X` belongs is refused with the fix (keeper, 2026-10-14), never read as one more
 *     example and never rewritten; a refused definition charges no filing slot, so the filer refiles;
 *   - every item, trimmed of surrounding whitespace, holds at least one Unicode letter or number
 *     (\p{L}\p{N}) and at most 120 characters (counted as Unicode code points, so every script and every
 *     emoji counts alike);
 *   - no item appears twice in the clause (compared ignoring case and runs of whitespace).
 * So an item cannot itself contain `;`, `|` or `e.g.:`. Standing definitions are not touched; they are
 * ordinary contest targets, as Amendment 16 Part G left definitions without a trailer.
 */
export const EXAMPLES_CLAUSE = { MIN_EXAMPLES: 2, MAX_EXAMPLES: 6, MAX_NEAR_MISSES: 3, ITEM_CHARS: 120 } as const
/** The clause's shape, as the door names it and the app describes it: one string, two mouths. */
export const EXAMPLES_SHAPE = "e.g.: <example>; <example>[; ...] [| not: <near-miss>[; ...]]"
/** The refusal of an example written `not: X` — a near-miss filed after `;` instead of `|` — and its fix. */
export const NEAR_MISS_AFTER_SEMICOLON = 'Law 6b: a near-miss follows "| not:", not "; not:" — write: e.g.: A; B | not: X'
const EXAMPLES_MARKER = /(?<![\p{L}\p{M}\p{N}])e\.g\.\s*:/giu
const NEAR_MISS_OPENER = /^\s*not\s*:/i
const HAS_LETTER_OR_NUMBER = /[\p{L}\p{N}]/u
export function examplesError(body: string, fields: TrailerFields): string | null {
  const at = trailerIndex(body, fields)
  if (at < 0) return `the Law 6b examples clause stands immediately before the Law 6 trailer, and this definition does not end with one`
  const head = body.slice(0, at)
  let marker: RegExpMatchArray | null = null
  for (const m of head.matchAll(EXAMPLES_MARKER)) marker = m
  if (!marker) {
    return `a definition names at least ${EXAMPLES_CLAUSE.MIN_EXAMPLES} real instances of what it carves in the Law 6b examples clause, immediately before its Law 6 trailer: ${EXAMPLES_SHAPE}`
  }
  const parts = head.slice(marker.index! + marker[0].length).split("|")
  if (parts.length > 2) return `the Law 6b examples clause holds one "|" at most — the one that opens its near-miss part: ${EXAMPLES_SHAPE}`
  let nearText: string | null = null
  if (parts.length === 2) {
    const opener = NEAR_MISS_OPENER.exec(parts[1])
    if (!opener) return `a "|" in the Law 6b examples clause opens the near-miss part and is written "| not:" — ${EXAMPLES_SHAPE}`
    nearText = parts[1].slice(opener[0].length)
  }
  const exampleItems = parts[0].split(";").map(s => s.trim())
  // A near-miss written after ";" would otherwise pass as one more example; the door names the fix and
  // leaves the filing as it was (keeper, 2026-10-14). Only the start of an item: "knot: a tie" is an example.
  if (exampleItems.some(item => NEAR_MISS_OPENER.test(item))) return NEAR_MISS_AFTER_SEMICOLON
  const lists: Array<["example" | "near-miss", string[]]> = [["example", exampleItems]]
  if (nearText !== null) lists.push(["near-miss", nearText.split(";").map(s => s.trim())])
  for (const [what, items] of lists) {
    if (items.length === 1 && !items[0]) {
      return what === "example"
        ? `the Law 6b examples clause names no examples — name at least ${EXAMPLES_CLAUSE.MIN_EXAMPLES}, separated by ";": ${EXAMPLES_SHAPE}`
        : `the Law 6b near-miss part names nothing — name one to ${EXAMPLES_CLAUSE.MAX_NEAR_MISSES} after "| not:", or leave the part out (it is optional)`
    }
    for (let i = 0; i < items.length; i++) {
      if (!HAS_LETTER_OR_NUMBER.test(items[i])) {
        return `Law 6b ${what} ${i + 1} is empty — items are separated by ";" and each names something`
      }
    }
  }
  const [, examples] = lists[0]
  if (examples.length < EXAMPLES_CLAUSE.MIN_EXAMPLES) {
    return `the Law 6b examples clause names at least ${EXAMPLES_CLAUSE.MIN_EXAMPLES} examples, separated by ";" — it names ${examples.length}`
  }
  if (examples.length > EXAMPLES_CLAUSE.MAX_EXAMPLES) {
    return `the Law 6b examples clause names at most ${EXAMPLES_CLAUSE.MAX_EXAMPLES} examples — it names ${examples.length}`
  }
  const nearMisses = lists[1]?.[1] ?? []
  if (nearMisses.length > EXAMPLES_CLAUSE.MAX_NEAR_MISSES) {
    return `the Law 6b near-miss part names at most ${EXAMPLES_CLAUSE.MAX_NEAR_MISSES} near-misses — it names ${nearMisses.length}`
  }
  const seen = new Set<string>()
  for (const [what, items] of lists) {
    for (let i = 0; i < items.length; i++) {
      const chars = [...items[i]].length
      if (chars > EXAMPLES_CLAUSE.ITEM_CHARS) {
        return `Law 6b ${what} ${i + 1} is ${chars} characters; the limit is ${EXAMPLES_CLAUSE.ITEM_CHARS} — name the instance, do not describe it`
      }
      const key = items[i].replace(/\s+/g, " ").toLowerCase()
      if (seen.has(key)) return `Law 6b: "${items[i]}" appears twice in the examples clause — each item names a different thing`
      seen.add(key)
    }
  }
  return null
}

/**
 * Amendment 17 Part O item 2 (CORRECT) and Part P rider 2 — a definition body's parts as the door reads them under the
 * amendment: the four-field trailer (Part G item 5, found by Part F's one pass) and Law 6b's clause (Part A's marker,
 * its last match before the trailer, as examplesError reads it). `prose` is the body before the clause's marker;
 * `clause` the clause, from its marker to the trailer, trimmed; `separator` what stands between the clause and the
 * trailer; `trailer` the rest of the body, from the trailer's `[`. Null when the body has not both, which no body
 * the amended door accepted can be. Linear: the finder's one pass and one scan for the marker.
 */
export interface DefinitionPartsA17 {
  prose: string
  clause: string
  separator: string
  trailer: string
  formal: string
  substrate: string
  horizon: string
  explicit: string
}
export function definitionPartsA17(body: string): DefinitionPartsA17 | null {
  const t = findTrailerA17(body)
  if (!t) return null
  const head = body.slice(0, t.index)
  let marker: RegExpMatchArray | null = null
  for (const m of head.matchAll(EXAMPLES_MARKER)) marker = m
  if (!marker) return null
  const tail = head.slice(marker.index!)
  const clause = tail.trimEnd()
  return {
    prose: head.slice(0, marker.index!), clause, separator: tail.slice(clause.length), trailer: body.slice(t.index),
    formal: t.formal, substrate: t.substrate, horizon: t.horizon, explicit: t.explicit,
  }
}

/** The opening of Law 6b's clause at the start of a value (a correction of the examples carries the clause alone). */
export const EXAMPLES_CLAUSE_OPENING = /^e\.g\.\s*:/i
/** How many examples-clause markers a text holds (Part A's marker, as the door finds it). */
export function examplesMarkerCount(text: string): number {
  let n = 0
  for (const _ of text.matchAll(EXAMPLES_MARKER)) n++
  return n
}
