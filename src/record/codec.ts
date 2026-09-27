import type { CoreState } from "../core/types"

type JsonRecord = Record<string, unknown>
type PathPart = string | number

const hasOwn = (value: JsonRecord, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const pathText = (path: readonly PathPart[]): string => path.reduce<string>((text, part) => {
  if (typeof part === "number") return `${text}[${part}]`
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part)
    ? `${text}.${part}`
    : `${text}[${JSON.stringify(part)}]`
}, "$")

const pathKey = (path: readonly PathPart[]): string => JSON.stringify(path)

const kindOf = (value: unknown): string => {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

const invalidState = (path: readonly PathPart[], expected: string, value: unknown): never => {
  throw new Error(`invalid CoreState at ${pathText(path)}: expected ${expected}, got ${kindOf(value)}`)
}

const recordAt = (value: unknown, path: readonly PathPart[]): JsonRecord => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidState(path, "object", value)
  }
  return value as JsonRecord
}

const recordField = (parent: JsonRecord, key: string, path: readonly PathPart[]): JsonRecord =>
  recordAt(parent[key], [...path, key])

const arrayField = (parent: JsonRecord, key: string, path: readonly PathPart[]): unknown[] => {
  const value = parent[key]
  if (!Array.isArray(value)) return invalidState([...path, key], "array", value)
  return value
}

const requireString = (parent: JsonRecord, key: string, path: readonly PathPart[]): void => {
  if (typeof parent[key] !== "string") invalidState([...path, key], "string", parent[key])
}

const requireBigint = (
  parent: JsonRecord,
  key: string,
  path: readonly PathPart[],
  bigintPaths: Set<string>,
): void => {
  const valuePath = [...path, key]
  if (typeof parent[key] !== "bigint") invalidState(valuePath, "canonical bigint tag", parent[key])
  bigintPaths.add(pathKey(valuePath))
}

/**
 * Validate the runtime distinctions that TypeScript cannot preserve across JSON.
 *
 * `hashOf` deliberately renders a bigint as its decimal string, so a sidecar that silently
 * substitutes `"1"` for `1n` has the same historical state hash. The load boundary therefore
 * has to prove every bigint-bearing CoreState slot before a snapshot reaches the reducer. It
 * also rejects tagged bigints anywhere CoreState does not define one, closing the inverse
 * substitution in open records such as replacement specs and dials.
 *
 * Three maps were added after the original snapshot cut and are upcast by `initState`; they may
 * be absent here. `names` likewise accepts the historical single-holder string until that
 * upcast runs. All bigint-bearing fields, however, have always required their exact runtime
 * type and are checked without an upcast.
 */
export function assertCoreState(value: unknown): asserts value is CoreState {
  const state = recordAt(value, [])
  if (!Number.isSafeInteger(state.seq) || (state.seq as number) < 0) {
    invalidState(["seq"], "non-negative safe integer", state.seq)
  }
  requireString(state, "ts", [])

  const dials = recordField(state, "dials", [])
  for (const [key, dial] of Object.entries(dials)) {
    if (typeof dial !== "string" && typeof dial !== "boolean" &&
        !(typeof dial === "number" && Number.isFinite(dial))) {
      invalidState(["dials", key], "finite number, string, or boolean", dial)
    }
  }
  const keys = recordField(state, "keys", [])
  requireString(keys, "court", ["keys"])
  requireString(keys, "governance", ["keys"])
  requireString(keys, "sequencer", ["keys"])

  const bigintPaths = new Set<string>()

  const actors = recordField(state, "actors", [])
  for (const [fp, rawActor] of Object.entries(actors)) {
    const path = ["actors", fp]
    const actor = recordAt(rawActor, path)
    requireBigint(actor, "repMilli", path, bigintPaths)
    requireBigint(actor, "balanceBase", path, bigintPaths)
    requireBigint(actor, "openStakeMilli", path, bigintPaths)
  }

  const acts = recordField(state, "acts", [])
  for (const [id, rawAct] of Object.entries(acts)) {
    const path = ["acts", id]
    const act = recordAt(rawAct, path)
    if (act.awardedRepMilli !== undefined) requireBigint(act, "awardedRepMilli", path, bigintPaths)
    if (act.holdback !== undefined) {
      const holdback = recordField(act, "holdback", path)
      requireBigint(holdback, "heldBase", [...path, "holdback"], bigintPaths)
    }
  }

  const raids = recordField(state, "raids", [])
  for (const [id, rawRaid] of Object.entries(raids)) {
    const path = ["raids", id]
    const raid = recordAt(rawRaid, path)
    if (!hasOwn(raid, "frozenAttestBase")) {
      invalidState([...path, "frozenAttestBase"], "canonical bigint tag or null", undefined)
    }
    if (raid.frozenAttestBase !== null) {
      requireBigint(raid, "frozenAttestBase", path, bigintPaths)
    }
  }

  const burns = recordField(state, "burns", [])
  for (const [seq, rawBurn] of Object.entries(burns)) {
    const path = ["burns", seq]
    const burn = recordAt(rawBurn, path)
    requireBigint(burn, "amountBase", path, bigintPaths)
  }

  const flags = recordField(state, "flags", [])
  for (const [target, rawByFlagger] of Object.entries(flags)) {
    const byFlagger = recordAt(rawByFlagger, ["flags", target])
    for (const [fp, rawFlag] of Object.entries(byFlagger)) {
      const path = ["flags", target, fp]
      const flag = recordAt(rawFlag, path)
      requireBigint(flag, "weightMilli", path, bigintPaths)
    }
  }

  const votes = recordField(state, "votes", [])
  for (const [target, rawByVoter] of Object.entries(votes)) {
    const byVoter = recordAt(rawByVoter, ["votes", target])
    for (const [fp, rawVote] of Object.entries(byVoter)) {
      const path = ["votes", target, fp]
      const vote = recordAt(rawVote, path)
      requireBigint(vote, "stakeMilli", path, bigintPaths)
    }
  }

  const stakes = recordField(state, "stakes", [])
  for (const [target, rawStakes] of Object.entries(stakes)) {
    const stakeList = Array.isArray(rawStakes)
      ? rawStakes
      : invalidState(["stakes", target], "array", rawStakes)
    for (const [index, rawStake] of stakeList.entries()) {
      const path = ["stakes", target, index]
      const stake = recordAt(rawStake, path)
      requireBigint(stake, "amountBase", path, bigintPaths)
      requireBigint(stake, "payoutBase", path, bigintPaths)
    }
  }

  const supply = recordField(state, "supply", [])
  for (const key of [
    "coinMintedBase",
    "coinBurnedBase",
    "escrowPoolBase",
    "repMintedMilli",
    "repBurnedMilli",
  ]) {
    requireBigint(supply, key, ["supply"], bigintPaths)
  }

  // Validate the collection roots the reducer reads directly. The three optional maps are
  // historical upcasts documented above; every other root must already be usable as CoreState.
  for (const key of [
    "houses", "credentialToHouse", "challenges", "amendments", "laws", "nudges", "gallery",
    "ingots", "names",
  ]) recordField(state, key, [])
  for (const key of ["attestations", "lineages", "revokedCredentials"]) {
    if (state[key] !== undefined) recordField(state, key, [])
  }
  arrayField(state, "pendingActivations", [])

  const names = state.names as JsonRecord
  for (const [name, holders] of Object.entries(names)) {
    if (typeof holders === "string") continue // pre-A+A snapshot; initState wraps it after hash proof
    if (!Array.isArray(holders) || holders.some(holder => typeof holder !== "string")) {
      invalidState(["names", name], "string or string array", holders)
    }
  }

  // A `$big` object in an in-memory state would be reinterpreted on its next load, and a tagged
  // bigint in any non-bigint CoreState slot recreates the same type-collision in reverse. Walk
  // the complete value after checking every legitimate bigint path and reject both conditions.
  const ancestors = new Set<object>()
  const inspect = (current: unknown, path: PathPart[]): void => {
    if (typeof current === "bigint") {
      if (!bigintPaths.has(pathKey(path))) invalidState(path, "non-bigint CoreState value", current)
      return
    }
    if (current === null || typeof current !== "object") return
    if (ancestors.has(current)) throw new Error(`invalid CoreState at ${pathText(path)}: cyclic value`)
    ancestors.add(current)
    if (Array.isArray(current)) {
      current.forEach((item, index) => inspect(item, [...path, index]))
    } else {
      const object = current as JsonRecord
      if (hasOwn(object, "$big")) {
        throw new Error(`invalid CoreState at ${pathText(path)}: "$big" is reserved for codec tags`)
      }
      for (const [key, item] of Object.entries(object)) inspect(item, [...path, key])
    }
    ancestors.delete(current)
  }
  inspect(state, [])
}

/**
 * State serialization for the genesis sidecar (`genesis-state.json`).
 *
 * Bigints ride as `{ "$big": "123" }`. The tagging is a MANUAL pre-walk, never a
 * JSON.stringify replacer: Next's server runtime patches stringify to serialize bigints as
 * bare numbers WITHOUT consulting the replacer (found 2026-08-11 — the first staging
 * genesis wrote a sidecar whose bigints had silently become numbers, and the hash check
 * refused it at load, exactly as designed). The walk hands stringify a bigint-free tree,
 * so no runtime's cleverness can reach one. Round-trip preserves hashOf() exactly.
 */
const tag = (v: unknown): unknown => {
  if (typeof v === "bigint") return { $big: v.toString() }
  if (Array.isArray(v)) return v.map(tag)
  if (v && typeof v === "object") {
    // Match JSON.parse/decodeTags: a null-prototype destination retains an own `__proto__` data
    // member instead of invoking Object.prototype's legacy setter and losing committed bytes.
    const out: Record<string, unknown> = Object.create(null)
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x !== undefined) out[k] = tag(x)
    }
    return out
  }
  return v
}

export const stateToJson = (s: CoreState): string => {
  assertCoreState(s)
  return JSON.stringify(tag(s))
}

const canonicalBigint = /^(?:0|-?[1-9][0-9]*)$/

const decodeTags = (value: unknown, path: PathPart[]): unknown => {
  if (Array.isArray(value)) return value.map((item, index) => decodeTags(item, [...path, index]))
  if (value === null || typeof value !== "object") return value

  const object = value as JsonRecord
  if (hasOwn(object, "$big")) {
    const keys = Object.keys(object)
    const raw = object.$big
    if (keys.length !== 1 || typeof raw !== "string" || !canonicalBigint.test(raw)) {
      throw new Error(
        `invalid bigint tag at ${pathText(path)}: expected exactly {"$big":"<canonical decimal>"}`,
      )
    }
    return BigInt(raw)
  }

  // Mutate the fresh JSON.parse tree in place. Besides avoiding a second full allocation for a
  // large sidecar, this preserves JSON.parse's safe own-data-property treatment of `__proto__`;
  // copying that key by ordinary assignment onto `{}` would invoke the legacy prototype setter.
  for (const [key, item] of Object.entries(object)) object[key] = decodeTags(item, [...path, key])
  return object
}

export const stateFromJson = (json: string): CoreState => {
  const state = decodeTags(JSON.parse(json) as unknown, [])
  assertCoreState(state)
  return state
}
