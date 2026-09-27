import type { House } from "./types"

/**
 * Law 38's exact, recorded exception: the keeper's seven founding agents were already bound to
 * the first production House when the one-mint grant was ratified. They are holdings, not mints.
 *
 * The fingerprints and entity ids below are facts in the production genesis snapshot. Keeping
 * the roster exact matters: this is not a role-based keeper bypass and it cannot admit an eighth
 * exempt hand. A future rehoming may move this roster into a commons institution; until then the
 * only effect of this declaration is correct mint accounting.
 */
export const FOUNDING_FLEET_HOUSE_ID = "cmrw4fdbw0000n830rsfjbuww"

export const FOUNDING_FLEET = [
  { label: "Fable",  agentId: "cmr784qh80000s126lorkncbp", fingerprint: "2a6494a3b42971a76424e7b0516939bb52c3add916a049e0a33be71453d9eda2" },
  { label: "Mira",   agentId: "cmr784ql70004s126xidclkdv", fingerprint: "b449fdf1924658e391b3767407758eee42e8c768be4e6a404bd91945fca6df05" },
  { label: "Ezra",   agentId: "cmr784qm70008s1263mj8aiwp", fingerprint: "322f9c1c0c022fe4cfb68ee2f81ca5fad6b9f3b2aafbf64c9a7a8236e9357c9d" },
  { label: "Seth",   agentId: "cmr784qmu000cs1266pz2yn6t", fingerprint: "632d0543c1db3db5527aa53898e95135541316a96dd37e888ac546ffb8ca135d" },
  { label: "Hermes", agentId: "cmra0tza90000ug040p3trnvn", fingerprint: "d7569061bfdac421a90ff19bffea89f0e32504c7ef220bea5af225ff54d605ee" },
  { label: "Ares",   agentId: "cmredr7nq0016g8vud5czj3ft", fingerprint: "cc6d906ca4e76673818d38b5231f600d2f2a21dab31c64a1775e3a9579647637" },
  { label: "Dakk",   agentId: "cmrf3a1k5000zcqqtow3xr0x2", fingerprint: "43154504a8ba122eeb91b29b79f29a2839c8d44af5ad902cb91257fe53110d59" },
] as const

export const FOUNDING_FLEET_AGENT_IDS = FOUNDING_FLEET.map(member => member.agentId)

const FOUNDING_FLEET_FINGERPRINTS = new Set<string>(
  FOUNDING_FLEET.map(member => member.fingerprint),
)

/**
 * Count the House's spent mint grants, not all hands it happens to hold. There is currently no
 * membership-transfer event: outside the exact genesis exception above, every fingerprint enters
 * a House only through AGENT_MINTED. Therefore this count is exactly the number of mints without
 * adding a history-derived CoreState field that would move old state hashes.
 */
export function houseAgentMintsUsed(house: Pick<House, "id" | "agentFps">): number {
  if (house.id !== FOUNDING_FLEET_HOUSE_ID) return house.agentFps.length
  return house.agentFps.reduce(
    (used, fingerprint) => used + (FOUNDING_FLEET_FINGERPRINTS.has(fingerprint) ? 0 : 1),
    0,
  )
}
