import type { ActState, CorrectionPart, PartHashes } from "./types"
import { DEFINITION_CORRECTION_PARTS, ENTRY_CORRECTION_PARTS } from "./types"
import { sha256 } from "./canonical"
import { LIMITS, firstTooLong } from "./limits"
import {
  EXAMPLES_CLAUSE_OPENING, definitionPartsA17, examplesError, examplesMarkerCount, findTrailerA17, trailerError,
} from "./definitions"

/**
 * Amendment 17 Part O item 2 — CORRECT: one part of one record corrected, nothing struck (Laws 14, 15, 16, 18b, 27,
 * 30; keeper's decisions 31 and 42). The parts: an ENTRY's `scope` or `referent`, on any standing entry, those at
 * seq 0 among them; a DEFINITION's trailer fields (`formal`, `substrate`, `horizon`, `explicit`) or its `examples`
 * clause, on the head version of a definition filed after activation. The value passes the door of a filing of that
 * part. The core holds no text: it keeps the value hash of each part from the act's filing (every act filed after
 * activation) and, with each upheld correction, the hash of the value it replaced, and refuses a correction that
 * restores a replaced value by those hashes. An entry filed before activation committed its original scope only
 * inside its contentHash, so a correction restoring that exact scope after another replaced it is not caught at the
 * door; the judges see it on the screen (implementation notes, 2026-10-16).
 */

/** The mint reason of an upheld correction's refund of its 2-coin burn (a coin-assay closed reason). */
export const CORRECT_UPHELD_REFUND = "CORRECT_UPHELD_REFUND"
/** The mint reason of an upheld correction's award, CORRECT_AWARD_BASE (a coin-assay closed reason). */
export const CORRECT_UPHELD = "CORRECT_UPHELD"

/** The parts a correction may name on an act of this kind (none on an edge or a label). */
export const correctionPartsFor = (kind: string): readonly CorrectionPart[] =>
  kind === "ENTRY" ? ENTRY_CORRECTION_PARTS : kind === "DEFINITION" ? DEFINITION_CORRECTION_PARTS : []

const isPart = (value: unknown): value is CorrectionPart =>
  typeof value === "string" && [...ENTRY_CORRECTION_PARTS, ...DEFINITION_CORRECTION_PARTS].includes(value as CorrectionPart)

/** Characters that show nothing: Unicode's Default_Ignorable_Code_Point (zero-width space, word joiner, soft hyphen,
 *  zero-width (non-)joiner, byte-order mark, bidirectional controls, variation selectors...). */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu

/**
 * Part P's reading of "the same text" (decision 50, reading 7.1: whitespace folded), and the reversion check's: the
 * characters that show nothing removed, then Unicode's canonical composition (NFC: "é" one code point or "e" and its
 * accent, the same text by Unicode's own definition), then each run of whitespace one space and the ends trimmed. So a
 * successor, or a correction's value, that differs from the standing text only in what no reader or judge can see is
 * the same text: a zero-width space, a soft hyphen or a decomposed accent does not make a REPLACE of a fix to the
 * examples or the trailer (Part P rider 2), nor a new value of a replaced one (Part O item 2.2). Every visible change —
 * a letter, its case, a comma — still counts. Linear: one pass each.
 */
const folded = (text: string): string => text.replace(INVISIBLE, "").normalize("NFC").replace(/\s+/g, " ").trim()

/** Law 6b's clause in its canonical form: marker, examples and near-misses each folded and case-folded, as the door
 *  compares items (its duplicate check), and each list read as a set (sorted by code unit), so a clause differing only
 *  in spacing, case or the order of its items is the same value: the same examples reordered restore a replaced clause,
 *  and change nothing (Part O item 2.2). */
function canonicalClause(clause: string): string {
  const body = clause.trim().replace(EXAMPLES_CLAUSE_OPENING, "")
  const [examples, nearPart] = body.split("|")
  const items = (text: string) => text.split(";").map(item => folded(item).toLowerCase()).sort()
  const near = nearPart === undefined ? null : items(nearPart.replace(/^\s*not\s*:/i, ""))
  return `e.g.: ${items(examples).join("; ")}${near ? ` | not: ${near.join("; ")}` : ""}`
}

/** The value of a part as the reversion check compares it: the door's reading, whitespace folded; the trailer's
 *  enumerated fields case-folded, as the door reads them in any case, and the formal name too (a recased name is the
 *  same name); the clause in its canonical form. The scope and the prose keep their case: a letter's case there is a
 *  change (decision 50, reading 7.1). */
export function canonicalPartValue(part: CorrectionPart | "prose", value: string): string {
  switch (part) {
    case "referent": return value
    case "formal": case "substrate": case "horizon": case "explicit": return folded(value).toLowerCase()
    case "examples": return canonicalClause(value)
    default: return folded(value)
  }
}

/** A part's value hash: domain-separated by the part, over its canonical value. */
export const partHash = (part: CorrectionPart | "prose", value: string): string =>
  sha256(`systema.correction.v1\n${part}\n${canonicalPartValue(part, value)}`)

/** An entry's part hashes at filing: its scope and its referent (absent = THING, Law 3b). */
export function entryPartHashes(scope: string, referent: string | null | undefined): PartHashes {
  return { scope: partHash("scope", scope), referent: partHash("referent", referent || "THING") }
}

/** A definition's part hashes at filing, read from a body the amended door accepted; null when it has not the parts. */
export function definitionPartHashes(body: string): PartHashes | null {
  const parts = definitionPartsA17(body)
  if (!parts) return null
  return {
    formal: partHash("formal", parts.formal), substrate: partHash("substrate", parts.substrate),
    horizon: partHash("horizon", parts.horizon), explicit: partHash("explicit", parts.explicit),
    examples: partHash("examples", parts.clause), prose: partHash("prose", parts.prose),
  }
}

/** The hash of the value a part holds now: its last upheld correction's, else the hash kept from filing, else — the
 *  referent, which the core holds — the referent's. Undefined only for the scope of an entry filed before activation. */
export function standingPartHash(act: ActState, part: CorrectionPart): string | undefined {
  const corrected = (act.corrections ?? []).filter(c => c.part === part)
  if (corrected.length) return corrected[corrected.length - 1].valueHash
  if (act.partHashes?.[part]) return act.partHashes[part]
  if (part === "referent" && act.kind === "ENTRY") return partHash("referent", act.referent ?? "THING")
  return undefined
}

/** Is this the hash of a value an upheld correction of this part replaced? (Law 30: no reversion.) */
export const restoresReplacedValue = (act: ActState, part: CorrectionPart, valueHash: string): boolean =>
  (act.corrections ?? []).some(c => c.part === part && c.replacedHash === valueHash)

const DOOR = "a correction's value passes the door of a filing of its part (Law 30; Amendment 17)"
/** The other trailer fields a field's value is read among: any lawful values, never shown to anyone. */
const PLACEHOLDER: Record<"formal" | "substrate" | "horizon" | "explicit", string> = {
  formal: "res", substrate: "mind", horizon: "hours", explicit: "no",
}
const trailerWith = (part: "formal" | "substrate" | "horizon" | "explicit", value: string): string => {
  const f = { ...PLACEHOLDER, [part]: value }
  return `[formal: ${f.formal} | substrate: ${f.substrate} | horizon: ${f.horizon} | explicit: ${f.explicit}]`
}

/**
 * Why `value` is not a lawful value for `part` (Part O item 2.2), or null. The same door as a filing of that part: a
 * scope within its length (Law 28a); a referent of Law 3b's three; a trailer field as Law 6's four-field trailer reads
 * it (a `formal` not empty; `substrate`, `horizon`, `explicit` from their lists), and read back as exactly that one
 * field; an examples clause of Law 6b's form, the clause alone (it opens with its marker and holds no other).
 */
export function correctionValueError(part: unknown, value: unknown): string | null {
  if (!isPart(part)) return "a correction names its part: scope or referent (an ENTRY), or formal, substrate, horizon, explicit or examples (a DEFINITION) (Law 30; Amendment 17)"
  if (typeof value !== "string" || value.length === 0) return `a correction carries the new value of its part, ${part} (Law 30; Amendment 17)`
  if (part === "scope") {
    const big = firstTooLong([["scopeJustification", value, LIMITS.SCOPE]])
    return big ? `${DOOR}: ${big}` : null
  }
  const big = firstTooLong([[part, value, LIMITS.DEFINITION_BODY]])
  if (big) return `${DOOR}: ${big}`
  if (part === "referent") {
    return value === "THING" || value === "CONCEPT" || value === "WORD" ? null : `${DOOR}: referent must be THING, CONCEPT, or WORD (Law 3b)`
  }
  if (part === "examples") {
    const clause = value.trim()
    if (!EXAMPLES_CLAUSE_OPENING.test(clause) || examplesMarkerCount(clause) !== 1) {
      return `${DOOR}: the examples are corrected as the whole Law 6b clause, opening with its one marker: e.g.: <example>; <example>[; ...] [| not: <near-miss>[; ...]]`
    }
    const why = examplesError(`${clause} ${trailerWith("formal", PLACEHOLDER.formal)}`, 4)
    return why ? `${DOOR}: ${why}` : null
  }
  if (/[|\]]/.test(value)) {
    return `${DOOR}: the value of ${part} is read as one field of the Law 6 trailer, so it holds no "|" or "]" that would end the field`
  }
  const trailer = trailerWith(part, value)
  const why = trailerError(trailer, 4)
  if (why) return `${DOOR}: ${why}`
  if (findTrailerA17(trailer)?.[part] !== value.trim()) {
    return `${DOOR}: the value of ${part} is read as one field of the Law 6 trailer, so it holds no "|" or "]" that would end the field`
  }
  return null
}

/**
 * The shown text of a definition, its head as filed with its upheld corrections applied, rebuilt the same on every
 * fold (Part O item 2.5): the prose as filed; the clause as filed or as last corrected; between them and the trailer
 * the separator as filed; the trailer as filed, or, when a field was corrected, rebuilt from its four fields as read,
 * each corrected field taking its last corrected value. Null when the body has not the amended parts, which no body a
 * correction reaches can be.
 *
 * Known corner (inherent: the core holds no text, and a correction's value passes its part's door alone): the rebuilt
 * body need not pass the definition door again. Where the prose itself holds a "[formal:" and the original clause's
 * "|" kept the trailer finder off it, an examples correction without near-misses lets the finder anchor at the prose's
 * "[formal:", and the shown body fails the examples door. The shown text is still the record's (the parts as filed
 * and as corrected); a surface that pre-fills a REPLACE from it (Part O item 2.10) runs the door on it before sending.
 */
export function correctedDefinitionBody(body: string, corrections: ReadonlyArray<{ part: string; value: string }>): string | null {
  const parts = definitionPartsA17(body)
  if (!parts) return null
  const latest: Partial<Record<string, string>> = {}
  for (const c of corrections) latest[c.part] = c.value.trim()
  const clause = latest.examples ?? parts.clause
  const fields = (["formal", "substrate", "horizon", "explicit"] as const)
  if (!fields.some(f => latest[f] !== undefined)) return `${parts.prose}${clause}${parts.separator}${parts.trailer}`
  const v = Object.fromEntries(fields.map(f => [f, latest[f] ?? parts[f]])) as Record<typeof fields[number], string>
  const after = parts.trailer.slice(parts.trailer.trimEnd().length) // whatever whitespace followed the trailer's "]"
  return `${parts.prose}${clause}${parts.separator}[formal: ${v.formal} | substrate: ${v.substrate} | horizon: ${v.horizon} | explicit: ${v.explicit}]${after}`
}
