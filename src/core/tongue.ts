import {
  LANGUAGE_EXTLANGS, LANGUAGE_SUBTAGS, LANGUAGE_SUBTAG_PREFERRED, LANGUAGE_SUBTAG_REGISTRY_FILE_DATE, LANGUAGE_TAG_PREFERRED,
} from "./language-subtags"

/**
 * Amendment 17 Part M (Law 39; keeper's decisions 21, 36 and 37): a separately filed label declares its
 * tongue, written as a language code, the primary language subtag of BCP 47 (RFC 5646): two or three
 * letters, listed as a language in the IANA Language Subtag Registry, read from the copy pinned in this
 * ruleset (language-subtags.ts, by its File-Date). Its case is folded, as BCP 47's is; nothing else is
 * changed. The door refuses any other value, never cutting or guessing, each refusal free and with its fix:
 *   - no tongue at all (the door used to read a missing tongue as `en`);
 *   - a tag with a region or a script (`pt-BR`, `zh-Hant`): write the language alone, `pt`;
 *   - the registry's codes for no language, several, an undetermined or an uncoded one (zxx, mul, und,
 *     mis) and its private-use range qaa–qtz, since a label binds a word in one real tongue;
 *   - anything the registry does not list.
 * The fixes follow BCP 47's canonical forms (RFC 5646 section 4.5; implementation notes, 2026-10-16), read from the
 * same pinned copy: an extended language subtag written after its prefix is refused with its own primary code as
 * the fix (`zh-yue` → `yue`), not with its prefix; a code the registry marks deprecated is refused with its
 * Preferred-Value (`iw` → `he`), with a region or a script or alone; and a grandfathered or redundant tag the
 * registry replaces is refused with the language of its Preferred-Value (`i-klingon` → `tlh`). A deprecated code
 * without a Preferred-Value is its own canonical form and is admitted, as BCP 47 leaves it.
 * Linear and bounded: one scan for the first two separators over at most MAX_TONGUE_CHARS characters, and set
 * and map lookups. The canonical name declares no tongue and is not such a label.
 */

const LISTED: ReadonlySet<string> = new Set(LANGUAGE_SUBTAGS.join(" ").split(" "))
const pairs = (rows: readonly string[]): ReadonlyMap<string, string> =>
  new Map(rows.join(" ").split(" ").map(pair => pair.split(">") as [string, string]))
/** A deprecated language subtag → its Preferred-Value. */
const PREFERRED = pairs(LANGUAGE_SUBTAG_PREFERRED)
/** `prefix-extlang`, each extended language subtag after its one prefix. */
const EXTLANG: ReadonlySet<string> = new Set(LANGUAGE_EXTLANGS.join(" ").split(" "))
/** A grandfathered or redundant tag, lower-cased → the language of its Preferred-Value. */
const TAG_PREFERRED = pairs(LANGUAGE_TAG_PREFERRED)
const SPECIAL: Readonly<Record<string, string>> = {
  zxx: "no linguistic content",
  mul: "several languages",
  und: "an undetermined language",
  mis: "an uncoded language",
}
/** Longer than any tag a person writes for one word's tongue; past it the value is not read further. */
export const MAX_TONGUE_CHARS = 64
const FIX = "give the label's language code, e.g. `en`"

export const TONGUE_MISSING = `a separately filed label declares its tongue (Law 39): ${FIX}`

const shown = (value: string): string =>
  value.length <= 16 && /^[\x21-\x7e]+$/.test(value) && !value.includes("`") ? `\`${value}\`` : "the tongue"

const isPrivateUse = (code: string): boolean => code.length === 3 && code[0] === "q" && code[1] >= "a" && code[1] <= "t"

const isSeparator = (c: string): boolean => c === "-" || c === "_"
const deprecated = (code: string, preferred: string): string =>
  `\`${code}\` is deprecated in the IANA Language Subtag Registry (File-Date ${LANGUAGE_SUBTAG_REGISTRY_FILE_DATE}), which prefers \`${preferred}\` (Law 39): write the language alone: \`${preferred}\``

/** Why `lang` is not a label's tongue under Amendment 17, or null when it is one. */
export function tongueError(lang: unknown): string | null {
  if (typeof lang !== "string" || lang.length === 0) return TONGUE_MISSING
  const notListed = `${shown(lang)} is not a language code the IANA Language Subtag Registry lists (File-Date ${LANGUAGE_SUBTAG_REGISTRY_FILE_DATE}); a label's tongue is the primary language subtag of BCP 47, two or three letters (Law 39): ${FIX}`
  if (lang.length > MAX_TONGUE_CHARS) return notListed
  let cut = -1
  let next = lang.length
  for (let i = 0; i < lang.length; i++) {
    if (!isSeparator(lang[i])) continue
    if (cut < 0) cut = i
    else { next = i; break }
  }
  // A grandfathered or redundant tag the registry replaces (`i-klingon`, `zh-min-nan`, `sgn-BE-FR`): its canonical
  // form is its Preferred-Value, of which the tongue is the language.
  const tag = cut >= 0 ? TAG_PREFERRED.get(lang.toLowerCase().replace(/_/g, "-")) : undefined
  const replaced = (): string =>
    `\`${lang.toLowerCase()}\` is a tag the IANA Language Subtag Registry (File-Date ${LANGUAGE_SUBTAG_REGISTRY_FILE_DATE}) replaces with \`${tag}\` (Law 39): write the language alone: \`${tag}\``
  const primary = cut < 0 ? lang : lang.slice(0, cut)
  if (!/^[A-Za-z]{2,3}$/.test(primary)) return tag ? replaced() : notListed
  const code = primary.toLowerCase()
  if (isPrivateUse(code)) {
    return `\`${code}\` is a private-use code (qaa–qtz), and a label binds a word in one real tongue (Law 39): ${FIX}`
  }
  if (Object.prototype.hasOwnProperty.call(SPECIAL, code)) {
    return `\`${code}\` is the registry's code for ${SPECIAL[code]}, and a label binds a word in one real tongue (Law 39): ${FIX}`
  }
  if (!LISTED.has(code)) return tag ? replaced() : notListed
  const preferred = PREFERRED.get(code)
  if (preferred) return deprecated(code, preferred)
  if (cut >= 0) {
    // An extended language subtag after its prefix (`zh-yue`, `ar-ajp`) is its own language, BCP 47's canonical form.
    const extlang = lang.slice(cut + 1, next).toLowerCase()
    if (/^[a-z]{3}$/.test(extlang) && EXTLANG.has(`${code}-${extlang}`)) {
      const own = PREFERRED.get(extlang) ?? extlang
      return `a label's tongue is the language alone, and BCP 47 writes an extended language subtag as its own language (Law 39): write the language alone: \`${own}\``
    }
    if (tag) return replaced()
    return `a label's tongue is the language alone, without a region or a script (Law 39): write the language alone: \`${code}\``
  }
  return null
}
