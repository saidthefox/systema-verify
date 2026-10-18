import type { CoreState } from "./types"
import { nameShapeError, nameShapeErrorV16, norm, normV16 } from "./canonical"
import { amendment16Version } from "./dials"

/**
 * The name rule in force (Law 12-ii; Amendment 16 Part E). Before the amendment, a name may carry no
 * combining mark and the blind comparison strips every mark; after it, marks belong to words, and only
 * Latin, Greek and Cyrillic accents and Arabic and Hebrew vowel points fold. The scan of the record
 * before the ruleset was built (tools/amendment16-name-scan.ts) found no recorded name whose comparison
 * differs between the two, so every key already in the name index means the same under both.
 */
export const nameNorm = (state: CoreState): ((s: string) => string) =>
  amendment16Version(state.dials) >= 1 ? normV16 : norm

export const nameShape = (state: CoreState): ((s: string) => string | null) =>
  amendment16Version(state.dials) >= 1 ? nameShapeErrorV16 : nameShapeError
