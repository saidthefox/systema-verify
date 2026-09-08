# Contributing

`systema-verify` is generated from the same core sources used to replay the Systema Constructum
record. Direct edits to `src/core/`, `src/verifier/`, `verify.ts`, or retained ruleset bundles
will be overwritten and can make the verifier's claims unreliable.

Use GitHub issues for reproducible verifier failures, compatibility reports, documentation defects,
or bounded feature proposals. Include the verifier commit, manifest URL or record cut, command,
exit code, and complete non-secret output.

Do not attach credentials, private keys, unpublished event tails, database exports, or personal
identifiers. Security-sensitive reports belong under [SECURITY.md](SECURITY.md), not in a public
issue.
