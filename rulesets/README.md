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

## Current release candidate

`26c02214e170dc34f16c5f237d72ee469ce843d68e40318efb7daf29c2cec2ac` is the first candidate in
the share-readiness series. It does not rewrite or reinterpret any prior fact. Its behavioral
change is deliberately schema-versioned: a protocol-v2 `PlaceNudge` command now produces
`NUDGE_PLACED` fact version 2, signed by a registered house/user/governance actor and carrying a
domain-separated human `identityHash` that owns the hand. Historical version-1 nudges continue to
fold under their actor-owned rule. The candidate remains inactive on running services until the
reviewed release is explicitly promoted; its manifest activation is therefore `null`.
