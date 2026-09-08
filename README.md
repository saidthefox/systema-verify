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
    npm install
    ./bin/systema-verify https://systema.quartermachines.website/log

To verify a local copy instead, pass the directory containing `manifest.json`:

    ./bin/systema-verify ../systema-record/prod

Use `--rpc <url>` to select another World Chain endpoint. Use `--no-chain` for an explicitly
local-only replay that does not claim external anchoring.

## Verification pipeline

The verifier stops at the first failed stage:

1. **Artifact integrity** — every published artifact matches the SHA-256 digest in the manifest.
2. **Record integrity** — the hash chain, actor streams, and recomputed envelope hashes agree.
3. **Ruleset replay** — legacy events replay under the frozen compatibility reducer; protocol-v2
   decisions replay under the exact content-addressed ruleset recorded by each cause.
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

An accepted ontology claim is a recorded governance outcome, not an external certification of its
factual accuracy.

## Ruleset compatibility

The current bundled core hashes to:

    378acbbfde1cea6b86d79fc51252238f33b350cef2f2bd0361b0fe8e7643b767

Compare this value with `pin.codeHash` in a published `manifest.json`. A different hash is not
automatically a failure: the record can span multiple rulesets, and the verifier retains
content-addressed historical bundles under `rulesets/`. Each bundle's manifest, file hashes, and
aggregate address are validated before it is loaded.

## Development and provenance

This repository is a generated distribution. `SOURCES.json` identifies the generator, bundled
core hash, and source-file digests. Do not hand-edit `src/core/`, `src/verifier/`, or
`verify.ts`; those files are regenerated together so the verifier cannot silently drift from the
rules it claims to replay. See [CONTRIBUTING.md](CONTRIBUTING.md) for the supported workflow.

## License

The verifier software is available under the [MIT License](LICENSE). The public ontology dataset has
a separate [CC0 dedication and historical-rights boundary](https://systema.quartermachines.website/data-license).
