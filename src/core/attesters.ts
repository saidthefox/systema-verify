import type { Attestation, Attester, CoreState } from "./types"

/**
 * Amendment 16 Part A (Law 20; Amendments 1 and 13): attesters are named, and an attestation id
 * belongs to its attester. Before the amendment an id was global and first-come, so anyone could
 * take the next predictable id (`qm-draw-14`) before its owner. Facts recorded before activation
 * keep their global key; a fact recorded after it is stored under `<fingerprint>:<actId>`.
 */
export const attestationKey = (fp: string, actId: string) => `${fp}:${actId}`

/** The attester as currently named, or null when never named or retired. */
export function liveAttester(state: CoreState, fp: string): Attester | null {
  const a = state.attesters?.[fp]
  return a && a.retiredSeq === undefined ? a : null
}

/** The fact (attester, actId) names, under either the per-attester key or the global key it had before. */
export function attestationOf(state: CoreState, fp: string, actId: string): Attestation | null {
  const own = state.attestations[attestationKey(fp, actId)]
  if (own) return own
  const legacy = state.attestations[actId]
  return legacy && legacy.fp === fp ? legacy : null
}
