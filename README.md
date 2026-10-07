# systema-verify

Independent command-line verification for the public
[Systema Constructum](https://systema.quartermachines.website) record.

The verifier downloads or opens a published record, checks every declared artifact, replays the
record under its retained rulesets, and compares the resulting state commitment with the checkpoint
published on World Chain. The operator's database and application are not trusted inputs.

## Requirements

- Node.js 20 or newer
- Network access to the published record and a World Chain JSON-RPC endpoint

## Quick start

    git clone https://github.com/saidthefox/systema-verify.git
    cd systema-verify
    npm ci
    ./bin/systema-verify https://systema.quartermachines.website/log

To verify a local copy instead, pass the directory containing `manifest.json`:

    ./bin/systema-verify ../systema-record/prod

Use `--rpc <url>` to select another World Chain endpoint. Use `--no-chain` for an explicitly
local-only replay that does not claim external anchoring.

## Verification pipeline

The verifier stops at the first failed stage:

1. **Artifact integrity** — every published artifact matches the SHA-256 digest in the manifest.
2. **Record integrity** — the hash chain, actor streams, and recomputed envelope hashes agree.
3. **Ruleset replay** — each lived protocol-v1 prefix replays under an integrity-checked retained
   executor bound to its exact genesis, handoff head, and handoff-state commitment; protocol-v2
   decisions replay under the exact content-addressed ruleset recorded by each cause. One closed,
   hash-bound staging fact uses the separately named transition artifact documented below.
4. **Signatures** — signatures are enforced from the recorded activation sequence onward.
5. **External checkpoint** — the folded state digest is compared with the commitment read from
   World Chain.

The checkpoint address is compiled into this verifier rather than accepted from the record being
checked:

- **Network:** World Chain mainnet (chain ID `480`)
- **Contract:** `0x0EFa83693F6c64683B6E4a601BfB6dcfb6BCc720`
- **Read:** `headAt(<height>)`

## Results and exit codes

| Exit | Result | Meaning |
|---:|---|---|
| 0 | `VERIFIED` | Artifact, record, replay, signature, and checkpoint checks passed. |
| 1 | `FAILED` | The supplied record failed a verification check. |
| 2 | error | The run could not complete because of an operational error. |
| 3 | `INCONCLUSIVE` | This verifier lacks a ruleset or event type required by the record. |

`INCONCLUSIVE` is never treated as a pass. Update the repository and run the check again.

## Trust boundaries

The verifier does not establish either of the following:

- **The truth of the genesis snapshot.** Its bytes and commitment are checked, but assertions about
  the pre-log era cannot be reconstructed from later events.
- **That a publisher served the longest available prefix.** A newer checkpoint whose sequence is
  above the supplied head can reveal truncation; an unavailable future checkpoint cannot.
- **Which unrecorded source originally admitted each protocol-v1 fact.** V1 envelopes carried no
  ruleset address. The retained profile proves exact reproduction to the committed handoff state,
  not retroactive provenance for the original mutable deployment.

An accepted ontology claim is a recorded governance outcome, not an external certification of its
factual accuracy.

## Ruleset compatibility

The current bundled core hashes to:

    5b95185d8c484b8d07e65c7376a9db757e6fa67867e3e433aef12758f40e7ff9

Compare this value with `pin.codeHash` in a published `manifest.json`. A different hash is not
automatically a failure: the record can span multiple rulesets, and the verifier retains
content-addressed historical bundles under `rulesets/`. Each bundle's manifest, file hashes, and
aggregate address are validated before it is loaded.

Registry entries marked `unrecoverable` preserve an honest historical gap: their directories,
manifests, and surviving bytes remain in the distribution, but the verifier will never execute
them. It reports the artifact unavailable, including the recorded reason and exact missing-file
roster, rather than treating an incomplete bundle as valid law.

Production and staging v1 history both reproduce under retained artifact
`b4345092bce3…`. The selector is fail-closed: production binds genesis `1a5bbf1d05ba…` to
handoff `3285:47b4362aed11…` and state `a6b42005cb27…`; staging binds genesis
`8e6464aee7a9…` to handoff `80938:67af2f06582d…` and state `5f9e79586f14…`. This is
explicitly reported as compatibility reproduction, because v1 facts themselves did not name it.

One historical staging exception is bundled openly as
`systema.transition-compatibility.staging-smelt-133187.v1`. It applies only to staging genesis
`8e6464aee7a9…` and fact 133187/`71574f27d27c…`: admission remains with cause ruleset
`378acbbfde1c…`, while factual evolution uses integrity-checked artifact `294fc9996caa…` and
must reproduce the committed pre/strict/lived state hashes. It is fixed source data, not a flag or
general policy for selecting transitions; it is not configurable.

## Development and provenance

This repository is a generated distribution. `FILES.sha256` is the byte-sorted, exhaustive
inventory of every generated regular file except itself; SHA-256 of those exact manifest bytes is
the distribution identity. `SOURCES.json` identifies the generator, bundled core hash,
retained-corpus status, and the paths, modes, and digests of every generated output. Its versioned
`SELF` and `MANIFEST` sentinels break the otherwise unavoidable self-hash cycle; neither is an
unverified wildcard because `FILES.sha256` hashes `SOURCES.json` and an external identity hashes
`FILES.sha256`.

An immutable content-addressed installation deliberately contains no `node_modules`: adding an
install tree would change its exhaustive identity and make generator `--check` fail. A normal Git
checkout uses `npm ci` as shown above. Systema's operator path executes this exact distribution's
`verify.ts` with the TSX runtime from the separately sealed Constructum release; it never copies
dependencies into this distribution or substitutes the release's own verifier source.
Do not hand-edit `src/core/`, `src/verifier/`,
`src/record/codec.ts`, or `verify.ts`; those files are regenerated together so the verifier cannot silently drift from the
rules it claims to replay. See [CONTRIBUTING.md](CONTRIBUTING.md) for the supported workflow.

`npm test` typechecks the current verifier and current core. Content-addressed directories under
`rulesets/` are immutable historical programs: the verifier validates their manifest, file roster,
individual hashes, and aggregate address before loading them at replay time. They are intentionally
excluded from reinterpretation by the current TypeScript compiler.

## License

The verifier software is available under the [MIT License](LICENSE). The public ontology dataset has
a separate [CC0 dedication and historical-rights boundary](https://systema.quartermachines.website/data-license).
