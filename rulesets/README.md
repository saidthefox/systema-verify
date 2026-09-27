# Retained rulesets

Every subdirectory named by a 64-character hash is an immutable copy of the exact `src/core/*.ts`
rulebook that produced that hash. The digest uses the same recipe as checkpoint `codeHash` and the
standalone verifier: sorted filename, a NUL byte, then exact file bytes.

`npm run ruleset:build` adds the current rulebook if it is absent. It never overwrites an existing
artifact. `npm run ruleset:check` is the guard used by tests and publication.

The first retained bundle is a **compatibility baseline**, not retroactive proof. Protocol-v1
events never recorded a ruleset hash, and source corrections were not activated by content hash.
Only an event whose envelope explicitly names one of these hashes can prove which artifact made
its admission decision. Protocol v2 carries that reference; historical v1 facts do not acquire it
retroactively.

The reference selects protocol-v2 decision and, ordinarily, factual-transition code. It does not
select command authentication: protocol 2 permanently uses
`systema.command-auth.ed25519-spki-sha256.v2`. The signed command does not contain the later-added
`cause.rulesetHash`, so allowing that hash to reinterpret the signature would overstate what its
author proved. Any future authentication scheme needs a distinct, recorded profile whose
selection is covered by the command signature.

## Closed staging transition compatibility

One historical staging fact is the documented exception to cause-and-transition identity. The
fact was admitted under one retained artifact and evolved by the next while the Forge V3 rehearsal
was being activated. Existing Sepolia checkpoints and the rehearsal token descend from the lived
state, so the owner chose to preserve those testnet commitments rather than retire them.

The profile is fixed in `src/verifier/transition-compatibility.ts` as
`systema.transition-compatibility.staging-smelt-133187.v1` and can apply only when all of these
commitments agree:

- record genesis: `8e6464aee7a9f9a0219618e41ac1f95574fe65657d50f3d9aca6d4672787f3c7`;
- event: seq 133187, SMELT hash
  `71574f27d27cfc3c77ae7d1ceb9d098367b414a21b4f81e9f5ec8244f76b2577`, claim target
  `0xc812c958308c262db7e3a6480f44bf78d3299a7a`;
- decision/admission artifact:
  `378acbbfde1cea6b86d79fc51252238f33b350cef2f2bd0361b0fe8e7643b767`;
- lived transition artifact:
  `294fc9996caa6413b7b0ccbf851fb84203fa62958a143b8b0ca9b518aacad782`;
- pre-state: `329329dd125b8874f474daa73edbf08b2b4e7650df5c07ae170c04c991f65f36`;
- strict cause-only post-state:
  `034fa236edc619b62c0f674914eb3e73b9f031e50c673daa405f2e7fb125d6b9`; and
- lived post-state: `d1be186196dd840f178b6a14147fb3c8a2404486781d6234f8e748ce90897eef`.

The loader integrity-checks both artifacts. The verifier first checks the signed command through
the frozen protocol authentication profile and proves the decision with the cause artifact. It
then independently computes and checks the strict cause-only result on a clone before evolving the
real fold with the lived artifact and checking the lived result. Every other fact uses its cause
artifact. The profile is neither configurable nor a precedent for future ruleset selection; any
prospective transition policy remains a separate recorded-governance decision.

## Current release candidate

`77b338bd5cd602ac729d041860991122d5b38855c2e8ecdf4dfa76da25f921fe` is the final inactive
source candidate from the share-readiness series. It contains 23 exact core files and does not
rewrite or reinterpret a prior fact. Its prospective, schema-versioned boundaries are:

- one canonical dial-policy validator checks genesis, migration snapshots, scheduled amendments,
  activation and direct `DIAL_SET` values, including safe-integer arithmetic and the Forge's
  two-coin minimum;
- a complete bidirectional identity invariant prevents duplicate entity ids, orphaned House keys,
  cross-House agents, and credential-map drift;
- a House or its optional human seat shares one nudge/Gallery allocation, while governance may
  attest for a verified human who has not founded a House;
- Gallery facts name the exact folded act kind and a canonical lowercase SHA-256 identity;
- a House-signed `MintAgent` derives schema-v3 `AGENT_MINTED` on the child's key chain, and a
  House-signed human-seat `RegisterEntity` derives schema-v2 `ENTITY_REGISTERED` on that child's
  key chain; governance alone may register a houseless system entity;
- SMELT amounts and the recorded minimum use canonical safe whole-number arithmetic; and
- mixed verification requires a named, genesis/head/state-bound retained protocol-v1 executor
  rather than silently applying the mutable current reducer; and
- canonical hashing retains an own JSON `__proto__` data member without invoking JavaScript's
  legacy prototype setter, so distinct signed/event objects cannot collapse to the same bytes;
- Lineages remain open and bounded (proposed Law 38c): a Lineage holds exactly one Lineage-only
  agent, additive House-hand affiliations are not counted, and Lineage-only agents stay outside
  every collective judging bar — the active population and competence median, act and screen
  crossings (count and weight), jury pools and size, raid-coalition breadth, and coherence-flag
  breadth. Their own votes, stakes and flags still record and settle.

The candidate also contains prospective, record-authorized protocol-v2 ruleset selection. Until
the first governance `DIAL_SET` for `PROTOCOL_V2_ACTIVE_RULESET`, new decisions use the immutable
historical `63f74959…` fallback. Earlier decisions remain disclosed compatibility evidence rather
than receiving retroactive authority. The policy fact is decided under the previous selector,
must name an available retained lowercase SHA-256 artifact, and takes effect only for the next
command. Genesis, migration snapshots, and scheduled-amendment dials cannot create or change this
authority. Once recorded, writers and verifiers fail closed unless each later decision names the
exact folded selector.

The manifest activation remains `null`. Selecting this artifact in the canonical record is a
separate keeper decision and governance ceremony; building and testing it confers no authority.
Earlier share-readiness candidates `33c2c02f…`, `f3879d98…`, `a645c4f7…`, `8399fd5e…`,
`63f74959…`, `26c02214…`, `9c4bd897…`, and `6a878105…` remain byte-exact but were never activated. Historical facts continue
to fold only under their recorded or closed compatibility execution.
