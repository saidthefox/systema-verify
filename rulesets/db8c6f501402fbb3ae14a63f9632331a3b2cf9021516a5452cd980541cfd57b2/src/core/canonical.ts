import { createHash } from "crypto"

/**
 * Canonical serialization + hashing. Key-sorted JSON, bigints as decimal strings — the same
 * stable() discipline contentHash uses today, extended for the state's bigint fields. This is
 * consensus-critical: two implementations that serialize differently compute different state
 * hashes from identical states.
 */
function stable(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString()
  if (Array.isArray(v)) return v.map(stable)
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>
    const out: Record<string, unknown> = Object.create(null)
    for (const k of Object.keys(o).sort()) {
      // A null-prototype output is consensus-critical here: assigning an own JSON `__proto__`
      // member onto `{}` invokes the legacy prototype setter and silently drops the member from
      // JSON.stringify, making distinct signed/event objects hash alike.
      if (o[k] !== undefined) out[k] = stable(o[k])
    }
    return out
  }
  return v
}

export const canonical = (v: unknown): string => JSON.stringify(stable(v))

/**
 * THE STATE HASH — canonical, and STABLE AGAINST THE STRUCT GROWING.
 *
 * `hashOf(state)` serializes whatever fields CoreState has TODAY, so the day the struct gained
 * `attestations: {}` every previously-anchored pin stopped reproducing — not because any event
 * changed, but because an empty map appeared in the serialization of every historical state.
 * Found 2026-08-19: both prod pins mismatched while `logHash` was identical, which is exactly
 * the signature of "the record is fine, the hash recipe moved".
 *
 * The fix is to drop EMPTY collections. A field that holds nothing contributes nothing, so a
 * new field is invisible to every state that predates the thing it records, and becomes part of
 * the hash the moment it actually holds something. `{}` and "absent" mean the same thing here —
 * nothing recorded — and the reducer already deletes keys as they empty (releaseName does this
 * explicitly), so the two are not distinguishable state in the first place.
 *
 * Versioned, because this IS a boundary: pins cast under v1 cannot be re-derived under v2, and
 * a verifier must be told which rule to apply rather than left to guess from a mismatch.
 */
export const STATE_HASH_V = 2

const isEmptyCollection = (v: unknown): boolean =>
  v !== null && typeof v === "object" &&
  (Array.isArray(v) ? v.length === 0 : Object.keys(v as object).length === 0)

function stableForState(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString()
  if (Array.isArray(v)) return v.map(stableForState)
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>
    const out: Record<string, unknown> = Object.create(null)
    for (const k of Object.keys(o).sort()) {
      if (o[k] === undefined) continue
      const inner = stableForState(o[k])
      if (isEmptyCollection(inner)) continue // a field holding nothing says nothing
      out[k] = inner
    }
    return out
  }
  return v
}

/** The hash a checkpoint commits to. Use THIS for pins, never hashOf(state). */
export const stateHashOf = (state: unknown): string => sha256(JSON.stringify(stableForState(state)))
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex")

/** Fingerprint an ed25519 SPKI key exactly as the sequencer and retired Chain do. */
export const keyFingerprint = (publicKeyB64: string): string =>
  createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest("hex")

/** One reserved external-fact profile. It is governance's statement about Systema's own retired
 * infrastructure, so a public guest may not squat its globally unique act id. */
export const CHAIN_TERMINUS_ACT_ID = "systema-chain-archive-terminus-v1"
export const CHAIN_TERMINUS_ACT_HASH = "67de9aa2e96de62ad062a941f55fd394f31ba762f319fa9c7d26bf9d587f517e"
export const hashOf = (v: unknown): string => sha256(canonical(v))

export const ZERO64 = "0".repeat(64)

/** Law 12's blind comparison, as revised by Law 12-ii (2026-08-14): fold case and diacritics
 *  to base letters, keep every Unicode letter and digit, discard the rest. `café` ≡ `cafe`
 *  inside the gate; no script normalizes to nothing. One normalizer, everywhere — the core,
 *  the live gates, and the genesis importer must all call THIS one. */
export const norm = (s: string): string =>
  s.normalize("NFKD").toLowerCase().replace(/\p{M}+/gu, "").replace(/[^\p{L}\p{N}]+/gu, "")

/** Amendment 16 Part E — the scripts whose combining marks are diacritics, folded in the blind
 *  comparison: Latin, Greek and Cyrillic accents, and the optional vowel points of Arabic and Hebrew
 *  (keeper, 2026-10-07), so `café` ≡ `cafe` and `كَتَبَ` ≡ `كتب`. In every other script a mark is part
 *  of the letter (a Devanagari vowel sign, a kana voicing mark) and is kept, so `काल` and `कल` stay
 *  different names. */
const FOLDS_MARKS = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}]/u
const MARK = /\p{M}/u
const LETTER = /\p{L}/u
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u

/** Law 12-ii as amended by Amendment 16 Part E. The same comparison as `norm` for every name whose
 *  marks all sit on Latin, Greek, Cyrillic, Arabic or Hebrew letters; elsewhere a mark is kept with
 *  the letter it follows, and a mark that follows no letter is dropped. Strictly finer than `norm`: two names it
 *  equates, `norm` equates too, so it can remove a collision but never create one. */
export const normV16 = (s: string): string => {
  let out = ""
  let base = "" // the letter a following mark belongs to, if any
  for (const ch of s.normalize("NFKD").toLowerCase()) {
    if (MARK.test(ch)) {
      if (base && !FOLDS_MARKS.test(base)) out += ch
    } else if (LETTER_OR_DIGIT.test(ch)) {
      out += ch
      base = LETTER.test(ch) ? ch : ""
    } else base = ""
  }
  return out
}

/** Law 12-ii-a — the shape of a canonical name (and of a label's word): letters of any script,
 *  digits, hyphens, and apostrophes; lowercase where the script has case; hyphens/apostrophes
 *  join word-parts, never lead or trail. Returns an error string, or null when well-formed. */
export function nameShapeError(s: string): string | null {
  if (!s) return "a name needs at least one letter"
  // Law 39 / keeper 2026-08-15: a name is a word, not a definition — the 80-char bound is LAW
  // (matches LIMITS.ENTRY_NAME === LABEL_TEXT; kept literal here so canonical stays leaf-level).
  if (s.length > 80) return `a name is a word, not a definition — ${s.length} characters exceeds the 80-character bound (Law 39)`
  if (s !== s.toLowerCase()) return "lowercase where the script has case (Law 12-ii)"
  if (!/^[\p{L}\p{N}]+([-'][\p{L}\p{N}]+)*$/u.test(s)) {
    return "letters of any script, digits, hyphens, and apostrophes only — hyphens join words; spaces and underscores do not enter a new name (Law 12-ii)"
  }
  if (!norm(s)) return "a name must survive normalization (Law 12-ii: no script normalizes to nothing)"
  return null
}

/** Law 12-ii-a as amended by Amendment 16 Part E: a word may carry combining marks within it (never
 *  leading a word-part), and a name is written in NFC so one spelling has one form. */
export function nameShapeErrorV16(s: string): string | null {
  if (!s) return "a name needs at least one letter"
  if (s.length > 80) return `a name is a word, not a definition — ${s.length} characters exceeds the 80-character bound (Law 39)`
  if (s !== s.normalize("NFC")) return "a name is written in composed form (NFC) — one spelling, one form (Amendment 16, Part E)"
  if (s !== s.toLowerCase()) return "lowercase where the script has case (Law 12-ii)"
  if (!/^[\p{L}\p{N}][\p{L}\p{M}\p{N}]*([-'][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*$/u.test(s)) {
    return "letters of any script with their marks, digits, hyphens, and apostrophes only — hyphens join words; spaces and underscores do not enter a new name (Law 12-ii)"
  }
  if (!normV16(s)) return "a name must survive normalization (Law 12-ii: no script normalizes to nothing)"
  return null
}
