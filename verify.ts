import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { join, resolve, sep } from "node:path"
import type { MixedLogVerdict } from "./src/core/verify"
import { CHAIN_TERMINUS_ACT_ID, stateHashOf } from "./src/core/canonical"
import { stateFromJson } from "./src/record/codec"
import type { AnyEventEnvelope, CoreState } from "./src/core/types"
import { MixedRecordPreflightError, replayMixedRecord } from "./src/verifier/mixed-record"
import type { TransitionCompatibility } from "./src/verifier/transition-compatibility"
import { verifyBedrockGenesisBinding } from "./src/verifier/bedrock-genesis"
import { BEDROCK_ATTESTATION_ID, BEDROCK_SCHEMA, sumBedrockLots, type BedrockManifest } from "./src/core/coin-lots"

/**
 * systema-verify — TRUST NOTHING. One command, run by someone who is not the keeper.
 *
 * Every other instrument in this project is run BY the operator, ON the operator's box, against
 * the operator's copy. That proves the kingdom is self-consistent; it cannot prove the operator
 * is honest, because the same person holds the record and the ruler. This closes that: it fetches
 * the published record, folds it with the retained law, and checks the result against a finalized
 * prior commitment the operator cannot erase. The operator still chose, sequenced, and signed the
 * record and currently controls checkpoint submission; the anchor is tamper evidence, not
 * decentralised governance.
 *
 * WHAT IT PROVES, in order, each step refusing to continue if the one before it failed:
 *   1. BYTES     every artifact matches the sha256 the manifest promised
 *   2. RECORD    the hash chain, the per-actor puddles, and every recomputed envelope hash
 *   3. LAW       v1 admission re-validates under its frozen compatibility rule; every v2
 *                decision resolves and runs the exact retained rulebook named in its cause;
 *                any closed transition compatibility is separately integrity-checked and named
 *   4. SIGNATURES from SIGS_FROM_SEQ onward, enforced whether or not you asked
 *   5. ANCHOR    the folded state hashes to the digest the World Chain contract actually holds.
 *                READ FROM THE CHAIN, not from the publisher's receipt — the receipt is the
 *                publisher's own claim, and checking a claim against itself proves nothing.
 *                The contract address is compiled into this tool for the same reason.
 *
 * WHAT IT CANNOT PROVE, and says so rather than letting you assume it:
 *   - the genesis SNAPSHOT. A snapshot-genesis log begins from a committed state, not from
 *     nothing. Replacing its sidecar changes the GENESIS/bedrock/checkpoint commitments and is
 *     detectable relative to a trusted prior commitment—but what the snapshot ASSERTS about the
 *     chain era is vouched for, not replayed. It is one named seam alongside custody, sequencing,
 *     data availability, and personhood assertions.
 *   - that you were shown the WHOLE record. A publisher can always serve a shorter prefix. The
 *     anchor is what closes this: an old pin whose seq exceeds the head you were served is proof
 *     of truncation, which is why the anchor check runs by default.
 *
 * Usage:
 *   npx tsx tools/systema-verify.ts <dir-or-url>  [--rpc <url>] [--no-chain]
 *   npx tsx tools/systema-verify.ts /path/to/published-record
 *   /opt/systema/verifiers/<digest>/bin/systema-verify /var/lib/systema/records/prod
 *     --ruleset-authorization-evidence production
 */

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex")
const ok = (s: string) => console.log(`  ✓ ${s}`)
const bad = (s: string) => console.log(`  ✗ ${s}`)
const note = (s: string) => console.log(`  · ${s}`)

export function chainTerminusOf(events: AnyEventEnvelope[]): { seq: number; height: number; hash: string; effectiveAt: string } | null {
  const event = events.find(e => e.kind === "ATTESTATION" && e.payload.actId === CHAIN_TERMINUS_ACT_ID)
  if (!event || typeof event.payload.record !== "string") return null
  const record = JSON.parse(event.payload.record) as { terminus?: { height?: unknown; hash?: unknown; effectiveAt?: unknown } }
  const t = record.terminus
  if (!t || typeof t.height !== "number" || typeof t.hash !== "string" || typeof t.effectiveAt !== "string") return null
  return { seq: event.seq, height: t.height, hash: t.hash, effectiveAt: t.effectiveAt }
}

function reportChainTerminus(events: AnyEventEnvelope[]): void {
  const t = chainTerminusOf(events)
  if (!t) {
    note("the archived systema-chain terminus is not recorded in this prefix")
    return
  }
  ok(`archived systema-chain terminus: block ${t.height}, ${t.hash.slice(0, 16)}…, recorded at log seq ${t.seq}`)
  note(`the final block timestamp is ${t.effectiveAt}; archive reads remain open, writes are closed`)
}

/**
 * THE ANCHOR, AS THIS TOOL KNOWS IT — deliberately NOT read from the publisher.
 *
 * Taking the contract address from the manifest would leave the whole check circular: a
 * dishonest publisher names a contract they control, writes whatever digest they like into it,
 * and the verifier dutifully agrees. So the address lives HERE, in the thing the stranger
 * downloaded, and the manifest's copy is treated as a claim to be CHECKED rather than a source.
 *
 * Verify this address out of band, once: it is on World Chain mainnet (chain id 480) and every
 * checkpoint transaction is a public `checkpoint(uint256,bytes32)` call to it.
 */
const ANCHOR = {
  chainId: 480,
  contract: "0x0EFa83693F6c64683B6E4a601BfB6dcfb6BCc720",
  /** keccak("headAt(uint256)")[0:4] — the public mapping's getter. Re-derive with
   *  `cast sig 'headAt(uint256)'`; hardcoded so this tool keeps zero dependencies. */
  headAtSelector: "0xc1742a8c",
  defaultRpc: "https://worldchain-mainnet.g.alchemy.com/public",
}

/** One JSON-RPC call. No web3 library: an eth_call is a POST with four fields. */
async function rpc(url: string, method: string, params: unknown[]): Promise<string> {
  const r = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  if (!r.ok) throw new Error(`RPC HTTP ${r.status}`)
  const declared = r.headers.get("content-length")
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 1024 * 1024)) {
    throw new Error("RPC response is excessively large")
  }
  const body = await r.text()
  if (Buffer.byteLength(body) > 1024 * 1024) throw new Error("RPC response is excessively large")
  const j = JSON.parse(body) as { result?: string; error?: { message: string } }
  if (j.error) throw new Error(j.error.message)
  if (typeof j.result !== "string") throw new Error("RPC returned no result")
  return j.result
}

/** What the chain says was pinned at this height. `0x000…0` means nothing was ever pinned there. */
async function anchoredDigest(rpcUrl: string, height: number): Promise<string | null> {
  const chainId = await rpc(rpcUrl, "eth_chainId", [])
  if (parseInt(chainId, 16) !== ANCHOR.chainId) {
    throw new Error(`that RPC serves chain ${parseInt(chainId, 16)}, not World Chain (${ANCHOR.chainId})`)
  }
  const data = ANCHOR.headAtSelector + height.toString(16).padStart(64, "0")
  const raw = await rpc(rpcUrl, "eth_call", [{ to: ANCHOR.contract, data }, "latest"])
  const value = raw.replace(/^0x/, "")
  return /^0+$/.test(value) ? null : value
}

/**
 * THE LAW THIS TOOL IS CARRYING — hashed the same way the checkpoint receipt hashes it.
 *
 * The receipt has always recorded a `codeHash` (which rulebook computed this state) and nothing
 * ever read it. It answers the question that bites hardest here: a verifier whose copy of
 * `src/core/` is even slightly behind the kingdom's will refuse events the kingdom lawfully
 * accepted, and will report that as *the record is INVALID* — blaming the subject for the
 * instrument. Comparing this against the receipt turns that into a legible "your copy of the law
 * is not the one that computed this pin", which is a true statement a stranger can act on.
 */
function ownCodeHash(): string | null {
  for (const dir of [join(__dirname, "src", "core"), join(__dirname, "..", "src", "core")]) {
    if (!existsSync(dir)) continue
    const files = readdirSync(dir).filter(f => f.endsWith(".ts") && !f.startsWith("._")).sort()
    const h = createHash("sha256")
    for (const f of files) h.update(f).update("\0").update(readFileSync(join(dir, f)))
    return h.digest("hex")
  }
  return null
}

/**
 * Is this failure about the RECORD, or about the tool holding the ruler?
 *
 * Two classes are unambiguously the tool's: a fact kind its current reducer does not know, or a
 * rulebook absent from this verifier package — the one a v2 decision ran under, or the one an
 * accepted policy fact makes active ("recorded active ruleset … is unavailable", src/core/verify.ts).
 * The core reaches the second only after the fact that names the ruleset has passed its own
 * signature and decision checks, so the record has done everything right and this copy merely
 * lacks the new ruler. Each means this copy cannot judge the record. A forger gains nothing by
 * triggering it: the verdict is INCONCLUSIVE, not a pass.
 *
 * The second phrasing was missed until 2026-10-06: Amendment 15's ruleset 5c529ff6 became active
 * at seq 16,802, and the published verifier, which predates it, called the kingdom's record
 * INVALID there (exit 1) instead of abstaining.
 *
 * Kept deliberately narrow. Widening this to other refusals would start excusing real findings,
 * which is the same mistake pointed the other way — and far worse in a tool whose whole value is
 * being believed when it says no.
 */
export const staleLaw = (reason?: string): boolean =>
  /unknown event kind|ruleset artifact unavailable|recorded active ruleset [0-9a-f]{64} is unavailable/.test(reason ?? "")

function retainedRulesetRoot(): string {
  for (const root of [join(__dirname, "rulesets"), join(__dirname, "..", "rulesets")]) {
    if (existsSync(join(root, "index.json"))) return root
  }
  throw new Error("this verifier carries no retained-ruleset registry")
}

interface ReplayCapture {
  stateHash: string
  governance: string
}

interface RetainedReplayEvidence {
  verdict: MixedLogVerdict
  captures: Map<number, ReplayCapture>
  transitionCompatibilities: TransitionCompatibility[]
}

function reportV1Execution(execution: MixedLogVerdict["v1Execution"]): void {
  if (!execution) return
  note(
    `protocol-v1 ${execution.claim} ${execution.profile}: executor ` +
    `${execution.rulesetHash.slice(0, 12)}…, genesis ${execution.recordGenesisHash.slice(0, 12)}…, ` +
    `handoff ${execution.through.seq}/${execution.through.hash.slice(0, 12)}…, ` +
    `state-v${execution.through.stateHashV} ${execution.through.stateHash.slice(0, 12)}…`,
  )
}

function reportTransitionCompatibilities(profiles: readonly TransitionCompatibility[]): void {
  for (const profile of profiles) {
    note(
      `closed historical transition compatibility ${profile.profile}: record ` +
      `${profile.recordGenesisHash.slice(0, 12)}…, event ${profile.eventSeq}/${profile.eventHash.slice(0, 12)}…`,
    )
    note(
      `admission ${profile.causeRulesetHash.slice(0, 12)}…; transition ` +
      `${profile.transitionRulesetHash.slice(0, 12)}…; state ` +
      `${profile.preStateHash.slice(0, 12)}… → ${profile.livedPostStateHash.slice(0, 12)}… ` +
      `(strict cause-only result ${profile.strictPostStateHash.slice(0, 12)}…)`,
    )
  }
}

function reportRulesetAuthorization(policy: MixedLogVerdict["rulesetAuthorization"]): void {
  note(
    `protocol-v2 ruleset authorization ${policy.profile}: active ${policy.active.rulesetHash.slice(0, 12)}… ` +
    `(${policy.active.source}${policy.firstPolicySeq === null ? "" : ` since seq ${policy.firstPolicySeq}`})`,
  )
  if (policy.legacyUnboundDecisions) {
    note(
      `${policy.legacyUnboundDecisions} pre-policy v2 decision(s) retain their recorded causes as ` +
      `historical compatibility, not prospective ruleset authorization`,
    )
  }
}

/** One verify-first retained replay, with immutable evidence captured only at requested cuts. */
async function retainedReplayEvidence(
  events: AnyEventEnvelope[],
  snapshot: CoreState | undefined,
  captureSeqs: ReadonlySet<number>,
  maxSeq?: number,
): Promise<RetainedReplayEvidence> {
  const captures = new Map<number, ReplayCapture>()
  const capture = (state: CoreState): void => {
    if (captureSeqs.has(state.seq)) {
      captures.set(state.seq, { stateHash: stateHashOf(state), governance: state.keys.governance })
    }
  }
  try {
    const replay = await replayMixedRecord(events, {
      snapshot,
      rulesetRoot: retainedRulesetRoot(),
      ...(maxSeq === undefined ? {} : { maxSeq }),
      onGenesis: capture,
      onFact: ({ state }) => { capture(state) },
    })
    return {
      verdict: replay.verdict,
      captures,
      transitionCompatibilities: replay.transitionCompatibilities,
    }
  } catch (error) {
    if (error instanceof MixedRecordPreflightError) {
      return {
        verdict: error.verdict,
        captures,
        transitionCompatibilities: error.transitionCompatibilities,
      }
    }
    throw error
  }
}

/** Prove one older prefix when the complete supplied record is beyond this verifier's reach. */
async function retainedStateHashAt(
  events: AnyEventEnvelope[],
  snapshot: CoreState | undefined,
  seq: number,
): Promise<string> {
  const evidence = await retainedReplayEvidence(events, snapshot, new Set([seq]), seq)
  if (!evidence.verdict.valid) {
    throw new Error(`pin prefix is not verifiable at seq ${evidence.verdict.failedAt ?? "?"}: ${evidence.verdict.reason}`)
  }
  const capture = evidence.captures.get(seq)
  if (!capture) throw new Error(`pin seq ${seq} is outside the supplied record`)
  return capture.stateHash
}

/**
 * Say, in one line, how the law in this copy relates to the law that computed the pin — and read
 * the SAME fact in opposite directions depending on whether the fold agreed, because it means
 * opposite things.
 *
 * The kingdom's core legitimately moves between daily pins, so a bare "your law differs" would
 * fire on almost every honest run and become the sort of permanently-amber instrument an operator
 * learns to scroll past. What it is actually worth:
 *
 *   folded fine, same rulebook   → you reproduced their result with their law
 *   folded fine, DIFFERENT       → you reproduced their result with a DIFFERENT law. That is a
 *                                  stronger claim than agreement, not a weaker one: two rulebooks
 *                                  independently arrive at the anchored digest.
 *   fold FAILED, different       → suspect your copy first (reported up in step 2, loudly)
 */
function reportLawDrift(pin: { codeHash?: string; seq: number }, folded: boolean): void {
  const mine = ownCodeHash()
  if (!mine || !pin.codeHash) return
  if (mine === pin.codeHash) {
    ok(`the law this tool carries IS the rulebook that computed that pin (codeHash ${mine.slice(0, 12)}…)`)
  } else if (folded) {
    ok(`re-derived under a DIFFERENT rulebook than the one that pinned it (yours ${mine.slice(0, 12)}…, theirs ${pin.codeHash.slice(0, 12)}…) — two laws, one digest`)
  } else {
    note(`your copy of the law differs from the one that computed this pin (yours ${mine.slice(0, 12)}…, theirs ${pin.codeHash.slice(0, 12)}…) — suspect the instrument before the record`)
  }
}

const DIGEST = /^[0-9a-f]{64}$/
const SIMPLE_ARTIFACT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const VERIFIER_COMPONENT = /^[A-Za-z0-9._-]+$/
const SEGMENT_ARTIFACT = /^seg-([0-9]{10})-([0-9]{10})\.jsonl$/
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const MAX_PUBLICATION_ARTIFACT_BYTES = 256 * 1024 * 1024
const MAX_PLAIN_RECORD_BYTES = 2 * 1024 * 1024 * 1024
const MAX_SEGMENTS = 100_000
// A large artifact on a slow link is not a failure; a link that stops delivering is. Abort only
// after a stall, with a generous overall ceiling so a hung server still cannot hold a run forever.
export interface RemoteFetchTiming {
  stallMs: number
  totalMs: number
}
const REMOTE_FETCH_TIMING: RemoteFetchTiming = { stallMs: 30_000, totalMs: 15 * 60_000 }

type LocalArtifactSource = { kind: "local"; label: string; root: string }
type RemoteArtifactSource = { kind: "remote"; label: string; baseUrl: URL }
type ArtifactSource = LocalArtifactSource | RemoteArtifactSource

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key))
  if (unexpected.length) throw new Error(`${label} has unsupported field(s): ${unexpected.sort().join(", ")}`)
}

function safeInt(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${label} must be a safe integer >= ${minimum}`)
  return Number(value)
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error(`${label} must be a lowercase sha256 digest`)
  return value
}

function artifactName(value: unknown, label: string, expected?: string): string {
  if (typeof value !== "string" || !SIMPLE_ARTIFACT.test(value) || (expected !== undefined && value !== expected)) {
    throw new Error(`${label} must name ${expected ?? "one simple relative artifact"}`)
  }
  return value
}

export function createArtifactSource(base: string): ArtifactSource {
  if (/^https?:\/\//i.test(base)) {
    let parsed: URL
    try { parsed = new URL(base.endsWith("/") ? base : `${base}/`) }
    catch { throw new Error("remote publication target must be an absolute HTTPS directory URL") }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("remote publication target must be a credential-free HTTPS directory URL")
    }
    return { kind: "remote", label: parsed.toString(), baseUrl: parsed }
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(base)) {
    throw new Error("remote publication target must use HTTPS")
  }
  if (!existsSync(base)) throw new Error(`record target is absent: ${base}`)
  const before = lstatSync(base)
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`local record target must be a real directory, not a symlink: ${base}`)
  }
  return { kind: "local", label: base, root: realpathSync(base) }
}

function safeLocalPath(
  source: LocalArtifactSource,
  file: string,
  nested = false,
  allowHiddenVerifierPath = false,
): string {
  const components = file.split("/")
  const unsafeComponent = (component: string): boolean =>
    component === "." || component === ".." ||
    !(allowHiddenVerifierPath ? VERIFIER_COMPONENT : SIMPLE_ARTIFACT).test(component)
  if (!components.length || (!nested && components.length !== 1) ||
      components.some(unsafeComponent)) {
    throw new Error(`unsafe relative artifact path: ${JSON.stringify(file)}`)
  }
  const path = resolve(source.root, ...components)
  if (path !== source.root && !path.startsWith(`${source.root}${sep}`)) {
    throw new Error(`artifact escapes the frozen record root: ${JSON.stringify(file)}`)
  }
  let cursor = source.root
  for (let index = 0; index < components.length - 1; index++) {
    cursor = join(cursor, components[index])
    const info = lstatSync(cursor)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`artifact path has an unsafe directory component: ${file}`)
    }
  }
  return path
}

function readLocalArtifact(
  source: LocalArtifactSource,
  file: string,
  maxBytes: number,
  nested = false,
  allowHiddenVerifierPath = false,
): Buffer {
  const path = safeLocalPath(source, file, nested, allowHiddenVerifierPath)
  let before
  try { before = lstatSync(path) }
  catch { throw new Error(`${file}: not found under ${source.root}`) }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${file}: artifact is not a regular file`)
  if (before.size > maxBytes) throw new Error(`${file}: artifact exceeds the ${maxBytes}-byte safety limit`)
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${file}: artifact changed while it was opened`)
    }
    const bytes = readFileSync(descriptor)
    const after = fstatSync(descriptor)
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || bytes.length !== opened.size) {
      throw new Error(`${file}: artifact changed while it was read`)
    }
    return bytes
  } finally {
    closeSync(descriptor)
  }
}

async function readRemoteArtifact(
  source: RemoteArtifactSource,
  file: string,
  maxBytes: number,
  timing: RemoteFetchTiming = REMOTE_FETCH_TIMING,
): Promise<Buffer> {
  artifactName(file, "remote artifact")
  const target = new URL(file, source.baseUrl)
  if (target.origin !== source.baseUrl.origin || !target.pathname.startsWith(source.baseUrl.pathname)) {
    throw new Error(`${file}: artifact URL escapes the publication origin or path`)
  }
  const stalled = new AbortController()
  const signal = AbortSignal.any([stalled.signal, AbortSignal.timeout(timing.totalMs)])
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const armStall = () => {
    clearTimeout(stallTimer)
    stallTimer = setTimeout(() => {
      stalled.abort()
      // Cancel the body directly as well, so a stream that ignores the signal cannot hang the run.
      activeReader?.cancel().catch(() => undefined)
    }, timing.stallMs)
  }
  const failure = (error: unknown): Error => {
    if (stalled.signal.aborted) return new Error(`${file}: no data received for ${timing.stallMs} ms`)
    if (signal.aborted) return new Error(`${file}: download exceeded ${timing.totalMs} ms`)
    return error instanceof Error ? error : new Error(String(error))
  }
  armStall()
  try {
    let response: Response
    try {
      response = await fetch(target, {
        redirect: "error",
        signal,
        headers: { accept: "application/json, application/x-ndjson, text/plain;q=0.9, */*;q=0.1" },
      })
    } catch (error) {
      throw failure(error)
    }
    if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`)
    const encoded = response.headers.get("content-encoding")
    const declared = response.headers.get("content-length")
    // With a content coding the header describes encoded bytes; the decoded ceiling below still applies.
    if (!encoded && declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
      throw new Error(`${file}: invalid or excessive Content-Length`)
    }
    if (!response.body) throw new Error(`${file}: HTTP response has no body`)
    const chunks: Buffer[] = []
    let length = 0
    const reader = response.body.getReader()
    activeReader = reader
    try {
      while (true) {
        let next: ReadableStreamReadResult<Uint8Array>
        try {
          next = await reader.read()
        } catch (error) {
          throw failure(error)
        }
        if (next.done) {
          // A cancelled body ends as "done"; never mistake a cut-short download for a complete one.
          if (signal.aborted) throw failure(undefined)
          break
        }
        armStall()
        length += next.value.byteLength
        if (length > maxBytes) throw new Error(`${file}: artifact exceeds the ${maxBytes}-byte safety limit`)
        chunks.push(Buffer.from(next.value))
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks, length)
  } finally {
    clearTimeout(stallTimer)
  }
}

export async function readArtifact(
  source: ArtifactSource,
  file: string,
  maxBytes = MAX_PUBLICATION_ARTIFACT_BYTES,
  nested = false,
  timing: RemoteFetchTiming = REMOTE_FETCH_TIMING,
): Promise<Buffer> {
  return source.kind === "local"
    ? readLocalArtifact(source, file, maxBytes, nested)
    : readRemoteArtifact(source, file, maxBytes, timing)
}

export type RulesetAuthorizationEnvironment = "production" | "staging"

export interface InstalledVerifierIdentity {
  distributionManifestSha256: string
  packagedCandidateSha256: string
}

export interface RulesetAuthorizationEvidenceDocument {
  schema: "systema.ruleset-authorization-evidence.v1"
  generatedBy: "tools/systema-verify.ts"
  environment: RulesetAuthorizationEnvironment
  verifier: InstalledVerifierIdentity
  recordCut: {
    genesisHash: string
    head: { seq: number; hash: string }
    stateHashV: 2
    stateHash: string
  }
  rulesetAuthorization: MixedLogVerdict["rulesetAuthorization"]
  verification: { verdict: "VERIFIED"; eventCount: number }
}

interface InstalledVerifierFile {
  mode: string
  sha256: string
}

const VERIFIER_SOURCES_SCHEMA = "systema.verify-package-sources.v3"
const VERIFIER_SOURCES_PATH = "SOURCES.json"
const VERIFIER_FILES_PATH = "FILES.sha256"
const VERIFIER_PROVENANCE_RECIPE =
  "sha256 over UTF-8 lines sorted by path bytes: path + NUL + four-digit octal mode + NUL + (sha256(content) or the declared sentinel for SOURCES.json and FILES.sha256) + LF"
const VERIFIER_SENTINELS = {
  [VERIFIER_FILES_PATH]: "MANIFEST",
  [VERIFIER_SOURCES_PATH]: "SELF",
} as const

function byteSorted(paths: Iterable<string>): string[] {
  return [...paths].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
}

function sameRoster(actual: Iterable<string>, expected: Iterable<string>): boolean {
  return JSON.stringify(byteSorted(actual)) === JSON.stringify(byteSorted(expected))
}

function requireImmutableVerifierTopology(root: string): void {
  for (const path of ["/", "/opt", "/opt/systema", "/opt/systema/verifiers", root]) {
    const info = lstatSync(path)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
      throw new Error(`installed verifier path must have root-owned, non-writable real-directory ancestry: ${path}`)
    }
    if (realpathSync(path) !== path) {
      throw new Error(`installed verifier path has non-canonical ancestry: ${path}`)
    }
  }
}

/** Inventory the installed tree without following a symbolic link at any depth. */
function installedVerifierFiles(
  source: LocalArtifactSource,
  requiredOwnerUid: number | null,
): Map<string, InstalledVerifierFile> {
  const files = new Map<string, InstalledVerifierFile>()
  const walk = (directory: string): void => {
    const absoluteDirectory = directory ? join(source.root, directory) : source.root
    for (const name of readdirSync(absoluteDirectory).sort()) {
      const path = directory ? `${directory}/${name}` : name
      if (path.split("/").some(component =>
        component === "." || component === ".." || !VERIFIER_COMPONENT.test(component))) {
        throw new Error(`installed verifier has an unsupported path: ${path}`)
      }
      const absolute = join(source.root, ...path.split("/"))
      const info = lstatSync(absolute)
      if (info.isSymbolicLink()) throw new Error(`installed verifier contains a symbolic link: ${path}`)
      if (requiredOwnerUid !== null && (info.uid !== requiredOwnerUid || (info.mode & 0o022) !== 0)) {
        throw new Error(`installed verifier path must be owned by uid ${requiredOwnerUid} and non-writable by group/other: ${path}`)
      }
      if (info.isDirectory()) { walk(path); continue }
      if (!info.isFile()) throw new Error(`installed verifier contains a special file: ${path}`)
      const bytes = readLocalArtifact(
        source,
        path,
        MAX_PUBLICATION_ARTIFACT_BYTES,
        true,
        true,
      )
      files.set(path, {
        mode: (info.mode & 0o777).toString(8).padStart(4, "0"),
        sha256: sha256(bytes),
      })
    }
  }
  walk("")
  return files
}

/**
 * Derive identity from the installed verifier itself. The evidence CLI always requires the exact
 * content-addressed /opt leaf owned immutably by root at every depth. The relaxed arguments exist
 * only so deterministic unit fixtures can validate the same traversal under their unprivileged uid.
 */
export function installedVerifierIdentity(
  inputRoot: string,
  requireInstalledLeaf = true,
  requiredOwnerUid: number | null = requireInstalledLeaf ? 0 : null,
): InstalledVerifierIdentity {
  if (requireInstalledLeaf) {
    if (!/^\/opt\/systema\/verifiers\/[0-9a-f]{64}$/.test(inputRoot)) {
      throw new Error("ruleset evidence requires the exact content-addressed installed verifier leaf")
    }
    requireImmutableVerifierTopology(inputRoot)
  }
  const root = realpathSync(inputRoot)
  const info = lstatSync(root)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("verifier distribution root must be a real directory")
  const source: LocalArtifactSource = { kind: "local", label: root, root }
  const filesBytes = readLocalArtifact(source, "FILES.sha256", MAX_MANIFEST_BYTES)
  const distributionManifestSha256 = sha256(filesBytes)
  if (requireInstalledLeaf && root !== `/opt/systema/verifiers/${distributionManifestSha256}`) {
    throw new Error("ruleset evidence requires the exact content-addressed installed verifier leaf")
  }
  if (requiredOwnerUid !== null && (info.uid !== requiredOwnerUid || (info.mode & 0o022) !== 0)) {
    throw new Error(`installed verifier distribution must be owned by uid ${requiredOwnerUid} and non-writable by group/other`)
  }

  const actualFiles = installedVerifierFiles(source, requiredOwnerUid)
  if (actualFiles.get(VERIFIER_FILES_PATH)?.sha256 !== distributionManifestSha256) {
    throw new Error("installed verifier FILES.sha256 changed while its distribution was inventoried")
  }

  const lines = filesBytes.toString("utf8").split("\n")
  if (lines.at(-1) !== "") throw new Error("verifier FILES.sha256 must end with LF")
  lines.pop()
  if (!lines.length) throw new Error("verifier FILES.sha256 is empty")
  const entries = new Map<string, string>()
  let prior = ""
  for (const [index, line] of lines.entries()) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9._/-]+)$/.exec(line)
    if (!match || match[2].split("/").some(part =>
      part === "." || part === ".." || !VERIFIER_COMPONENT.test(part))) {
      throw new Error(`verifier FILES.sha256 entry ${index + 1} is malformed or unsafe`)
    }
    const [, hash, path] = match
    if (path === VERIFIER_FILES_PATH || entries.has(path) ||
        (prior && Buffer.compare(Buffer.from(prior), Buffer.from(path)) >= 0)) {
      throw new Error("verifier FILES.sha256 paths must be byte-sorted, unique, and exclude itself")
    }
    prior = path
    entries.set(path, hash)
  }
  const actualManifestPaths = byteSorted([...actualFiles.keys()].filter(path => path !== VERIFIER_FILES_PATH))
  if (!sameRoster(entries.keys(), actualManifestPaths)) {
    throw new Error("verifier FILES.sha256 is not an exhaustive inventory of the installed distribution")
  }
  for (const [path, expected] of entries) {
    if (actualFiles.get(path)?.sha256 !== expected) {
      throw new Error(`installed verifier ${path} differs from FILES.sha256`)
    }
  }
  const provenanceBytes = readLocalArtifact(source, VERIFIER_SOURCES_PATH, MAX_MANIFEST_BYTES)
  if (sha256(provenanceBytes) !== actualFiles.get(VERIFIER_SOURCES_PATH)?.sha256 ||
      sha256(provenanceBytes) !== entries.get(VERIFIER_SOURCES_PATH)) {
    throw new Error("installed verifier SOURCES.json changed after its distribution was inventoried")
  }
  const provenance = object(JSON.parse(provenanceBytes.toString("utf8")), "verifier SOURCES.json")
  const provenanceFields = [
    "schema", "generatedBy", "generatorSha256", "codeHash", "packageLockSha256",
    "generatedFileCount", "digestRecipe", "distributionDigest", "retainedRulesets",
    "sentinels", "outputs",
  ]
  if (!sameRoster(Object.keys(provenance), provenanceFields)) {
    throw new Error("installed verifier provenance does not have the exact v3 field roster")
  }
  if (provenance.schema !== VERIFIER_SOURCES_SCHEMA ||
      provenance.generatedBy !== "tools/build-verify-pkg.ts") {
    throw new Error("installed verifier provenance has the wrong schema or generator")
  }
  digest(provenance.generatorSha256, "verifier SOURCES.json.generatorSha256")
  const packagedCandidateSha256 = digest(provenance.codeHash, "verifier SOURCES.json.codeHash")
  const packageLockSha256 = digest(provenance.packageLockSha256, "verifier SOURCES.json.packageLockSha256")
  if (actualFiles.get("package-lock.json")?.sha256 !== packageLockSha256) {
    throw new Error("installed verifier package-lock.json differs from its provenance digest")
  }
  const outputCount = safeInt(provenance.generatedFileCount, "verifier SOURCES.json.generatedFileCount", 1)
  if (outputCount !== actualFiles.size) {
    throw new Error("installed verifier provenance file count differs from the installed distribution")
  }
  if (provenance.digestRecipe !== VERIFIER_PROVENANCE_RECIPE) {
    throw new Error("installed verifier provenance has an unsupported digest recipe")
  }
  const distributionDigest = digest(provenance.distributionDigest, "verifier SOURCES.json.distributionDigest")
  const retained = object(provenance.retainedRulesets, "verifier SOURCES.json.retainedRulesets")
  if (!sameRoster(Object.keys(retained), ["artifacts", "unrecoverable"]) ||
      !Number.isSafeInteger(retained.artifacts) || Number(retained.artifacts) < 0 ||
      !Array.isArray(retained.unrecoverable)) {
    throw new Error("installed verifier provenance has malformed retained-ruleset evidence")
  }
  const sentinels = object(provenance.sentinels, "verifier SOURCES.json.sentinels")
  if (!sameRoster(Object.keys(sentinels), Object.keys(VERIFIER_SENTINELS)) ||
      sentinels[VERIFIER_FILES_PATH] !== VERIFIER_SENTINELS[VERIFIER_FILES_PATH] ||
      sentinels[VERIFIER_SOURCES_PATH] !== VERIFIER_SENTINELS[VERIFIER_SOURCES_PATH]) {
    throw new Error("installed verifier provenance has the wrong self-addressing sentinels")
  }
  const outputs = object(provenance.outputs, "verifier SOURCES.json.outputs")
  if (!sameRoster(Object.keys(outputs), actualFiles.keys())) {
    throw new Error("installed verifier provenance output roster differs from the installed distribution")
  }
  const recomputedDistribution = createHash("sha256")
  for (const path of byteSorted(actualFiles.keys())) {
    const evidence = object(outputs[path], `verifier SOURCES.json.outputs[${JSON.stringify(path)}]`)
    if (!sameRoster(Object.keys(evidence), ["mode", "sha256"])) {
      throw new Error(`installed verifier provenance has malformed output evidence for ${path}`)
    }
    const installed = actualFiles.get(path)!
    const generatedMode = path === "bin/systema-verify" ? "0755" : "0644"
    if (typeof evidence.mode !== "string" || evidence.mode !== generatedMode ||
        evidence.mode !== installed.mode) {
      throw new Error(`installed verifier ${path} mode differs from provenance`)
    }
    const sentinel = VERIFIER_SENTINELS[path as keyof typeof VERIFIER_SENTINELS]
    if (sentinel !== undefined) {
      if (evidence.sha256 !== null) {
        throw new Error(`installed verifier provenance must use the ${sentinel} sentinel for ${path}`)
      }
    } else {
      const declared = digest(evidence.sha256, `verifier SOURCES.json output digest for ${path}`)
      if (declared !== installed.sha256 || entries.get(path) !== declared) {
        throw new Error(`installed verifier ${path} differs from provenance`)
      }
    }
    recomputedDistribution.update(path).update("\0").update(installed.mode).update("\0")
      .update(sentinel ?? installed.sha256).update("\n")
  }
  if (recomputedDistribution.digest("hex") !== distributionDigest) {
    throw new Error("installed verifier provenance distribution digest does not reproduce")
  }
  const currentCorePrefix = "src/core/"
  const currentCorePaths = byteSorted([...actualFiles.keys()].filter(path =>
    path.startsWith(currentCorePrefix) && !path.slice(currentCorePrefix.length).includes("/") &&
    path.endsWith(".ts")))
  if (!currentCorePaths.length) throw new Error("installed verifier has no current core source")
  const currentCore = createHash("sha256")
  for (const path of currentCorePaths) {
    const bytes = readLocalArtifact(source, path, MAX_PUBLICATION_ARTIFACT_BYTES, true, true)
    if (sha256(bytes) !== actualFiles.get(path)?.sha256) {
      throw new Error(`installed verifier ${path} changed after its distribution was inventoried`)
    }
    currentCore.update(path.slice(currentCorePrefix.length)).update("\0").update(bytes)
  }
  if (currentCore.digest("hex") !== packagedCandidateSha256) {
    throw new Error("installed verifier current core does not reproduce its packaged candidate address")
  }
  if (requireInstalledLeaf) requireImmutableVerifierTopology(root)
  return { distributionManifestSha256, packagedCandidateSha256 }
}

export function buildRulesetAuthorizationEvidence(input: {
  environment: RulesetAuthorizationEnvironment
  verifier: InstalledVerifierIdentity
  events: readonly AnyEventEnvelope[]
  foldedState: CoreState
  verdict: MixedLogVerdict
}): RulesetAuthorizationEvidenceDocument {
  const { environment, verifier, events, foldedState, verdict } = input
  if (environment !== "production" && environment !== "staging") throw new Error("unsupported evidence environment")
  digest(verifier.distributionManifestSha256, "verifier distribution manifest")
  digest(verifier.packagedCandidateSha256, "packaged candidate")
  if (!verdict.valid) throw new Error("ruleset evidence requires a successful retained replay")
  if (!events.length) throw new Error("ruleset evidence requires a non-empty complete record")
  const genesis = events[0]
  const head = events[events.length - 1]
  if (genesis.seq !== 0 || events.length !== head.seq + 1 || verdict.events !== events.length || foldedState.seq !== head.seq) {
    throw new Error("ruleset evidence requires the complete zero-based record and its final folded state")
  }
  digest(genesis.hash, "record genesis hash")
  digest(head.hash, "record head hash")
  const policy = verdict.rulesetAuthorization
  if (policy.profile !== "systema.protocol-v2-ruleset-authorization.v1") {
    throw new Error("ruleset authorization has an unsupported profile")
  }
  digest(policy.legacyFallback, "legacy fallback ruleset")
  digest(policy.active.rulesetHash, "next-command ruleset")
  if (!Number.isSafeInteger(policy.legacyUnboundDecisions) || policy.legacyUnboundDecisions < 0 ||
      policy.legacyUnboundDecisions > verdict.events) {
    throw new Error("ruleset authorization has an invalid legacy-unbound decision count")
  }
  if (policy.active.source === "legacy-fallback") {
    if (policy.firstPolicySeq !== null || policy.active.rulesetHash !== policy.legacyFallback) {
      throw new Error("legacy-fallback authorization is internally inconsistent")
    }
  } else if (policy.active.source === "recorded-dial") {
    if (!Number.isSafeInteger(policy.firstPolicySeq) || policy.firstPolicySeq === null ||
        policy.firstPolicySeq < 1 || policy.firstPolicySeq > head.seq) {
      throw new Error("recorded-dial authorization has no valid policy event")
    }
  } else {
    throw new Error("ruleset authorization has an unsupported source")
  }
  return {
    schema: "systema.ruleset-authorization-evidence.v1",
    generatedBy: "tools/systema-verify.ts",
    environment,
    verifier: { ...verifier },
    recordCut: {
      genesisHash: genesis.hash,
      head: { seq: head.seq, hash: head.hash },
      stateHashV: 2,
      stateHash: stateHashOf(foldedState),
    },
    rulesetAuthorization: {
      profile: policy.profile,
      legacyFallback: policy.legacyFallback,
      legacyUnboundDecisions: policy.legacyUnboundDecisions,
      firstPolicySeq: policy.firstPolicySeq,
      active: { ...policy.active },
    },
    verification: { verdict: "VERIFIED", eventCount: verdict.events },
  }
}

function verifierDistributionRoot(): string {
  const root = realpathSync(__dirname)
  if (existsSync(join(root, "SOURCES.json")) && existsSync(join(root, "FILES.sha256"))) return root
  throw new Error("ruleset evidence is available only from an installed standalone verifier distribution")
}

async function emitRulesetAuthorizationEvidence(
  base: string,
  environment: RulesetAuthorizationEnvironment,
): Promise<void> {
  const verifier = installedVerifierIdentity(verifierDistributionRoot())
  const source = createArtifactSource(base)
  if (source.kind !== "local") throw new Error("ruleset evidence requires the local canonical record root")
  const expectedRecordRoot = environment === "production"
    ? "/var/lib/systema/records/prod"
    : "/var/lib/systema/records/staging"
  if (source.root !== expectedRecordRoot) {
    throw new Error(`${environment} ruleset evidence requires ${expectedRecordRoot}`)
  }
  if (existsSync(safeLocalPath(source, "manifest.json"))) {
    throw new Error("ruleset evidence refuses a publication prefix; use the complete canonical record root")
  }
  const recordBytes = await readArtifact(source, "events.jsonl", MAX_PLAIN_RECORD_BYTES)
  const events = recordBytes.toString("utf8").split("\n").filter(line => line.trim())
    .map(line => JSON.parse(line) as AnyEventEnvelope)
  if (!events.length) throw new Error("events.jsonl contains zero events")
  const snapshotPath = safeLocalPath(source, "genesis-state.json")
  const snapshotBytes = existsSync(snapshotPath)
    ? await readArtifact(source, "genesis-state.json", MAX_PUBLICATION_ARTIFACT_BYTES)
    : null
  const replay = await replayMixedRecord(events, {
    snapshot: snapshotBytes ? stateFromJson(snapshotBytes.toString("utf8")) : undefined,
    rulesetRoot: retainedRulesetRoot(),
  })
  const evidence = buildRulesetAuthorizationEvidence({
    environment,
    verifier,
    events,
    foldedState: replay.state,
    verdict: replay.verdict,
  })
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
}

export interface Manifest {
  v: 1
  head: { seq: number; hash: string; ts: string }
  firstSeq: number
  segmentEvents: number
  totalEvents: number
  genesis: { file: string; bytes: number; sha256: string } | null
  bedrock?: { file: string; schema: string; bytes: number; sha256: string; archiveThroughBlock: number; eventGenesisHash: string } | null
  research?: { file: string; schema: string; bytes: number; sha256: string; headSeq: number; stateHash: string } | null
  segments: { file: string; fromSeq: number; toSeq: number; events: number; bytes: number; sha256: string }[]
  tail: { file: string; fromSeq: number; toSeq: number; events: number; bytes: number; sha256: string }
  pin: {
    seq: number; digest: string; stateHash: string; logHash: string; v?: number; recipe?: string
    height?: number
    codeHash?: string
    anchor?: { chainId?: number; contract?: string }
  } | null
  note?: string
}

function artifactEntry(value: unknown, label: string, expectedFile?: string): { file: string; bytes: number; sha256: string } {
  const entry = object(value, label)
  const file = artifactName(entry.file, `${label}.file`, expectedFile)
  const bytes = safeInt(entry.bytes, `${label}.bytes`)
  const hash = digest(entry.sha256, `${label}.sha256`)
  return { file, bytes, sha256: hash }
}

/** Parse only the one publication layout this verifier understands, before following any name. */
export function parsePublicationManifest(value: unknown): Manifest {
  const raw = object(value, "publication manifest")
  exactKeys(raw, [
    "v", "head", "firstSeq", "segmentEvents", "totalEvents", "genesis", "bedrock",
    "research", "segments", "tail", "pin", "note",
  ], "publication manifest")
  if (raw.v !== 1) throw new Error("publication manifest version is unsupported")
  const firstSeq = safeInt(raw.firstSeq, "manifest.firstSeq")
  const segmentEvents = safeInt(raw.segmentEvents, "manifest.segmentEvents", 1)
  const totalEvents = safeInt(raw.totalEvents, "manifest.totalEvents", 1)
  const headRaw = object(raw.head, "manifest.head")
  exactKeys(headRaw, ["seq", "hash", "ts"], "manifest.head")
  if (typeof headRaw.ts !== "string" || !Number.isFinite(Date.parse(headRaw.ts))) {
    throw new Error("manifest.head.ts must be a timestamp")
  }
  const head = {
    seq: safeInt(headRaw.seq, "manifest.head.seq"),
    hash: digest(headRaw.hash, "manifest.head.hash"),
    ts: headRaw.ts,
  }
  if (head.seq < firstSeq || totalEvents !== head.seq - firstSeq + 1) {
    throw new Error("manifest head, firstSeq, and totalEvents do not describe one contiguous cut")
  }
  if (!Array.isArray(raw.segments) || raw.segments.length > MAX_SEGMENTS) {
    throw new Error(`manifest.segments must be an array of at most ${MAX_SEGMENTS} entries`)
  }
  const names = new Set<string>(["manifest.json"])
  let expectedSeq = firstSeq
  const segments = raw.segments.map((value, index) => {
    const label = `manifest.segments[${index}]`
    const entry = object(value, label)
    exactKeys(entry, ["file", "fromSeq", "toSeq", "events", "bytes", "sha256"], label)
    const common = artifactEntry(entry, label)
    const match = SEGMENT_ARTIFACT.exec(common.file)
    const fromSeq = safeInt(entry.fromSeq, `${label}.fromSeq`)
    const toSeq = safeInt(entry.toSeq, `${label}.toSeq`)
    const events = safeInt(entry.events, `${label}.events`, 1)
    if (!match || Number(match[1]) !== fromSeq || Number(match[2]) !== toSeq ||
        fromSeq !== expectedSeq || toSeq !== fromSeq + segmentEvents - 1 || events !== segmentEvents) {
      throw new Error(`${label} has a malformed filename, range, or event count`)
    }
    if (names.has(common.file)) throw new Error(`manifest names artifact more than once: ${common.file}`)
    names.add(common.file)
    expectedSeq = toSeq + 1
    return { ...common, fromSeq, toSeq, events }
  })

  const tailRaw = object(raw.tail, "manifest.tail")
  exactKeys(tailRaw, ["file", "fromSeq", "toSeq", "events", "bytes", "sha256"], "manifest.tail")
  const tailCommon = artifactEntry(tailRaw, "manifest.tail", "tail.jsonl")
  const tail = {
    ...tailCommon,
    fromSeq: safeInt(tailRaw.fromSeq, "manifest.tail.fromSeq"),
    toSeq: safeInt(tailRaw.toSeq, "manifest.tail.toSeq"),
    events: safeInt(tailRaw.events, "manifest.tail.events"),
  }
  if (tail.fromSeq !== expectedSeq || tail.toSeq !== head.seq ||
      tail.events !== Math.max(0, tail.toSeq - tail.fromSeq + 1) ||
      segments.reduce((sum, entry) => sum + entry.events, 0) + tail.events !== totalEvents) {
    throw new Error("manifest.tail does not complete the declared contiguous record cut")
  }
  names.add(tail.file)

  let genesis: Manifest["genesis"] = null
  if (raw.genesis !== null) {
    const entry = object(raw.genesis, "manifest.genesis")
    exactKeys(entry, ["file", "bytes", "sha256"], "manifest.genesis")
    genesis = artifactEntry(entry, "manifest.genesis", "genesis-state.json")
    if (names.has(genesis.file)) throw new Error(`manifest names artifact more than once: ${genesis.file}`)
    names.add(genesis.file)
  }

  let bedrock: Manifest["bedrock"] = null
  if (raw.bedrock !== null && raw.bedrock !== undefined) {
    const entry = object(raw.bedrock, "manifest.bedrock")
    exactKeys(entry, [
      "file", "schema", "bytes", "sha256", "archiveThroughBlock", "eventGenesisHash",
    ], "manifest.bedrock")
    const common = artifactEntry(entry, "manifest.bedrock")
    if (entry.schema !== BEDROCK_SCHEMA) throw new Error("manifest.bedrock has an unsupported schema")
    bedrock = {
      ...common,
      schema: entry.schema,
      archiveThroughBlock: safeInt(entry.archiveThroughBlock, "manifest.bedrock.archiveThroughBlock"),
      eventGenesisHash: digest(entry.eventGenesisHash, "manifest.bedrock.eventGenesisHash"),
    }
    if (names.has(bedrock.file)) throw new Error(`manifest names artifact more than once: ${bedrock.file}`)
    names.add(bedrock.file)
  }

  let research: Manifest["research"] = null
  if (raw.research !== null && raw.research !== undefined) {
    const entry = object(raw.research, "manifest.research")
    exactKeys(entry, ["file", "schema", "bytes", "sha256", "headSeq", "stateHash"], "manifest.research")
    const common = artifactEntry(entry, "manifest.research", "research-v1.json")
    if (entry.schema !== "systema.research-snapshot.v1") throw new Error("manifest.research has an unsupported schema")
    research = {
      ...common,
      schema: entry.schema,
      headSeq: safeInt(entry.headSeq, "manifest.research.headSeq"),
      stateHash: digest(entry.stateHash, "manifest.research.stateHash"),
    }
    if (research.headSeq !== head.seq) throw new Error("manifest.research names a different head")
    if (names.has(research.file)) throw new Error(`manifest names artifact more than once: ${research.file}`)
    names.add(research.file)
  }
  if (bedrock && !genesis) throw new Error("manifest.bedrock requires the genesis sidecar it attests")

  let pin: Manifest["pin"] = null
  if (raw.pin !== null) {
    const entry = object(raw.pin, "manifest.pin")
    exactKeys(entry, [
      "height", "seq", "digest", "stateHash", "logHash", "v", "recipe", "codeHash",
      "anchor", "txHash",
    ], "manifest.pin")
    const seq = safeInt(entry.seq, "manifest.pin.seq")
    if (seq < firstSeq || seq > head.seq) throw new Error("manifest.pin.seq is outside the published record")
    if (entry.v !== undefined && entry.v !== 1 && entry.v !== 2) throw new Error("manifest.pin.v is unsupported")
    if (entry.recipe !== undefined && typeof entry.recipe !== "string") throw new Error("manifest.pin.recipe must be a string")
    if (entry.codeHash !== undefined) digest(entry.codeHash, "manifest.pin.codeHash")
    let anchor: { chainId?: number; contract?: string } | undefined
    if (entry.anchor !== null && entry.anchor !== undefined) {
      const claim = object(entry.anchor, "manifest.pin.anchor")
      exactKeys(claim, ["chain", "chainId", "contract", "method"], "manifest.pin.anchor")
      if (claim.chain !== undefined && typeof claim.chain !== "string") throw new Error("manifest.pin.anchor.chain must be a string")
      if (claim.method !== undefined && typeof claim.method !== "string") throw new Error("manifest.pin.anchor.method must be a string")
      if (claim.chainId !== undefined) safeInt(claim.chainId, "manifest.pin.anchor.chainId")
      if (claim.contract !== undefined && (typeof claim.contract !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(claim.contract))) {
        throw new Error("manifest.pin.anchor.contract must be an EVM address")
      }
      anchor = {
        ...(claim.chainId === undefined ? {} : { chainId: Number(claim.chainId) }),
        ...(claim.contract === undefined ? {} : { contract: claim.contract as string }),
      }
    }
    if (entry.txHash !== undefined && entry.txHash !== null &&
        (typeof entry.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(entry.txHash))) {
      throw new Error("manifest.pin.txHash must be a transaction hash")
    }
    pin = {
      seq,
      digest: digest(entry.digest, "manifest.pin.digest"),
      stateHash: digest(entry.stateHash, "manifest.pin.stateHash"),
      logHash: digest(entry.logHash, "manifest.pin.logHash"),
      ...(entry.height === undefined ? {} : { height: safeInt(entry.height, "manifest.pin.height") }),
      ...(entry.v === undefined ? {} : { v: entry.v }),
      ...(entry.recipe === undefined ? {} : { recipe: entry.recipe as string }),
      ...(entry.codeHash === undefined ? {} : { codeHash: entry.codeHash as string }),
      ...(anchor === undefined ? {} : { anchor }),
    }
  }
  if (raw.note !== undefined && typeof raw.note !== "string") throw new Error("manifest.note must be a string")
  return {
    v: 1, head, firstSeq, segmentEvents, totalEvents, genesis, bedrock, research,
    segments, tail, pin, ...(raw.note === undefined ? {} : { note: raw.note }),
  }
}

type BedrockPublicationBinding = Pick<NonNullable<Manifest["bedrock"]>, "archiveThroughBlock" | "eventGenesisHash">

/**
 * Validate the archive/event seam named by the exact bedrock bytes and bind it back to the
 * publication manifest. The seam is realm-specific (production and staging have different
 * archive histories), so a verifier must not substitute one realm's well-known block number for
 * the authenticated manifest it is actually checking.
 */
export function bedrockSeamFailures(
  bedrock: BedrockManifest,
  binding: BedrockPublicationBinding,
): string[] {
  const failures: string[] = []
  const seamBlock = bedrock.seam.archiveThrough.block
  const terminusBlock = bedrock.source.archive.terminus.block
  const verifiedHeight = bedrock.source.archive.verify.height
  const nextBlock = bedrock.seam.nextArchiveBlock

  if (!Number.isSafeInteger(seamBlock) || seamBlock < 0) {
    failures.push("bedrock seam does not name a safe non-negative archive block")
    return failures
  }
  if (binding.archiveThroughBlock !== seamBlock) {
    failures.push(
      `bedrock seam block ${seamBlock} differs from publication manifest ${binding.archiveThroughBlock}`,
    )
  }
  if (binding.eventGenesisHash !== bedrock.source.eventGenesis.hash) {
    failures.push("bedrock event genesis differs from the publication manifest")
  }
  if (!Number.isSafeInteger(terminusBlock) || terminusBlock < seamBlock) {
    failures.push("bedrock archive terminus is before or does not validly contain its seam")
  }
  if (bedrock.source.archive.verify.valid !== true || !Number.isSafeInteger(verifiedHeight) ||
      verifiedHeight !== terminusBlock) {
    failures.push("bedrock archive verification does not bind its exact terminus")
  }
  if (terminusBlock === seamBlock && nextBlock !== null) {
    failures.push("bedrock seam names a next archive block beyond its terminus")
  } else if (terminusBlock > seamBlock) {
    if (nextBlock === null || !Number.isSafeInteger(nextBlock.block) || nextBlock.block !== seamBlock + 1) {
      failures.push("bedrock seam does not name the immediately following archive block")
    }
  }
  return failures
}

function checkBedrock(
  bedrock: BedrockManifest,
  bedrockHash: string,
  binding: BedrockPublicationBinding,
  events: AnyEventEnvelope[],
  snapshotBytes: Buffer,
  governanceAtCommit: string | undefined,
): number {
  let failures = 0
  if (bedrock.schema !== BEDROCK_SCHEMA || bedrock.reconciliation.deltaBase !== "0") {
    bad("bedrock manifest is not the exact reconciled v1 schema"); return 1
  }
  const seamFailures = bedrockSeamFailures(bedrock, binding)
  for (const failure of seamFailures) { bad(failure); failures++ }
  const seamBlock = bedrock.seam.archiveThrough.block
  if (!Number.isSafeInteger(seamBlock) || seamBlock < 0) return failures
  if (bedrock.source.eventGenesis.hash !== events[0].hash) { bad("bedrock manifest names a different event genesis"); failures++ }
  const genesisBinding = verifyBedrockGenesisBinding(bedrock.source.genesisSnapshot, snapshotBytes)
  for (const failure of genesisBinding.failures) { bad(failure); failures++ }
  // Do not reconcile lots or derive the governance key from bytes the attested manifest did not
  // name exactly. Those follow-on checks would make an unbound snapshot look authoritative.
  if (!genesisBinding.snapshot || genesisBinding.failures.length) return failures
  const snapshot = genesisBinding.snapshot
  const lotIds = new Set<string>()
  let total = 0n
  for (const entity of bedrock.entities) {
    const actor = snapshot.actors[entity.fingerprint]
    const sum = sumBedrockLots(entity.lots)
    if (!actor || actor.balanceBase !== sum || BigInt(entity.importedGenesisBalanceBase) !== sum) {
      bad(`bedrock lots do not equal genesis balance for ${entity.fingerprint}`); failures++
    }
    for (const lot of entity.lots) {
      if (lot.block > seamBlock || lotIds.has(lot.id)) {
        bad(`invalid or duplicate bedrock lot ${lot.id}`); failures++
      }
      lotIds.add(lot.id)
    }
    total += sum
  }
  if (total.toString() !== bedrock.reconciliation.archiveLotsBalanceBase ||
      total.toString() !== bedrock.reconciliation.importedGenesisBalanceBase) {
    bad("bedrock global lot total does not equal the imported genesis total"); failures++
  }
  const attestation = events.find(event =>
    event.kind === "ATTESTATION" && event.payload.actId === BEDROCK_ATTESTATION_ID && event.payload.actHash === bedrockHash)
  if (!attestation) { bad("event log does not contain the bedrock manifest commitment"); failures++ }
  else {
    if (!governanceAtCommit) { bad("retained replay did not capture governance before the bedrock commitment"); failures++ }
    else if (attestation.actor !== governanceAtCommit) { bad("bedrock manifest commitment was not made by the governance key"); failures++ }
  }
  if (!failures) ok(`${bedrock.reconciliation.lotCount} bedrock lots exactly reconcile ${total} base units at archive block ${seamBlock}; governance committed ${bedrockHash.slice(0, 16)}…`)
  return failures
}

export interface AnchorCheckResult {
  failures: number
  rederived: boolean
  chainChecked: boolean
  chainMatched: boolean
  legacyV1: boolean
}

/** Step 3, shared by both directory shapes: re-derive the pin, then ask the chain. */
export async function checkAnchor(
  p: NonNullable<Manifest["pin"]>,
  recomputed: { stateHash: string; logHash: string },
  opts: { rpcUrl: string | null },
): Promise<AnchorCheckResult> {
  let failures = 0
  const legacyV1 = (p.v ?? 1) < 2
  let rederived = false
  if (legacyV1) {
    note(`pin at seq ${p.seq} is v1 (recipe ${p.recipe}); its digest mixed in a historical code hash and cannot be re-derived by a later reducer`)
  } else {
    const digest = sha256(`${recomputed.stateHash}|${recomputed.logHash}|${p.seq}`)
    if (recomputed.stateHash !== p.stateHash) { bad(`state hash differs from the pin (${recomputed.stateHash.slice(0, 16)}… vs ${p.stateHash.slice(0, 16)}…)`); failures++ }
    else if (recomputed.logHash !== p.logHash) { bad("log hash differs from the pin"); failures++ }
    else if (digest !== p.digest) { bad("recomputed digest differs from the pin"); failures++ }
    else { ok(`folded state re-derives the pinned digest at seq ${p.seq}`); rederived = true }
  }
  // Keyed on the PIN, not on the log: "two laws, one digest" is only a true and useful thing to
  // say when this law actually reached that digest.
  reportLawDrift(p, rederived)

  // The publisher may not redirect us to an anchor of their choosing.
  if (p.anchor?.contract && p.anchor.contract.toLowerCase() !== ANCHOR.contract.toLowerCase()) {
    bad(`this record names anchor ${p.anchor.contract} — not Systema's (${ANCHOR.contract}). REFUSING to check it there.`)
    return { failures: failures + 1, rederived, chainChecked: false, chainMatched: false, legacyV1 }
  }
  if (p.anchor?.chainId !== undefined && p.anchor.chainId !== ANCHOR.chainId) {
    bad(`this record names anchor chain ${p.anchor.chainId} — not World Chain (${ANCHOR.chainId})`)
    return { failures: failures + 1, rederived, chainChecked: false, chainMatched: false, legacyV1 }
  }

  const height = p.height ?? null
  if (!opts.rpcUrl) {
    note("external chain check was explicitly disabled (--no-chain)")
    return { failures, rederived, chainChecked: false, chainMatched: false, legacyV1 }
  }
  if (height === null || !Number.isSafeInteger(height) || height < 0) {
    bad("this record does not name a valid anchor height")
    return { failures: failures + 1, rederived, chainChecked: false, chainMatched: false, legacyV1 }
  }
  // Network, RPC, and wrong-chain errors deliberately escape to main's operational-error exit 2.
  // An unavailable witness is not a bad record, but it is never a successful verification.
  const onChain = await anchoredDigest(opts.rpcUrl, height)
  if (onChain === null) {
    bad(`nothing is anchored at height ${height} — this pin was never witnessed`)
    failures++
    return { failures, rederived, chainChecked: true, chainMatched: false, legacyV1 }
  }
  if (onChain.toLowerCase() !== p.digest.toLowerCase()) {
    bad(`THE CHAIN DISAGREES at height ${height}: anchored ${onChain.slice(0, 16)}…, this record claims ${p.digest.slice(0, 16)}…`)
    failures++
    return { failures, rederived, chainChecked: true, chainMatched: false, legacyV1 }
  }
  ok(`World Chain agrees: ${ANCHOR.contract.slice(0, 10)}… headAt(${height}) = the digest above`)
  note("that finalized value is an independently readable prior commitment the keeper cannot erase; it does not make the keeper's sequencing, custody, or personhood assertions independent.")
  return { failures, rederived, chainChecked: true, chainMatched: true, legacyV1 }
}

/** An operator/mirror directory: no manifest to check the bytes against, so the record itself
 *  and the anchor carry the whole proof. Everything after step 1 is identical, because it is
 *  the same law folding the same events. */
async function verifyPlainDir(source: LocalArtifactSource, opts: { rpcUrl: string | null }): Promise<never> {
  let failures = 0
  console.log("1. bytes\n  – no manifest here (an operator/mirror directory); the record and the anchor carry the proof")
  const recordBytes = await readArtifact(source, "events.jsonl", MAX_PLAIN_RECORD_BYTES)
  const events = recordBytes.toString("utf8").split("\n").filter(l => l.trim())
    .map(l => JSON.parse(l) as AnyEventEnvelope)
  if (!events.length) throw new Error("events.jsonl contains zero events")
  const sidecarPath = safeLocalPath(source, "genesis-state.json")
  const snapshotBytes = existsSync(sidecarPath)
    ? await readArtifact(source, "genesis-state.json", MAX_PUBLICATION_ARTIFACT_BYTES)
    : null
  const snap = () => snapshotBytes ? stateFromJson(snapshotBytes.toString("utf8")) : undefined
  const head = events[events.length - 1]
  ok(`read ${events.length} events, head seq ${head.seq} @ ${head.ts}`)

  console.log("\n2. the record, the law, the signatures")
  const ckDir = safeLocalPath(source, "checkpoints")
  let receiptFiles: string[] = []
  if (existsSync(ckDir)) {
    const info = lstatSync(ckDir)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("checkpoints must be a real directory")
    receiptFiles = readdirSync(ckDir).filter(file => file.endsWith(".json")).sort()
  }
  const pins: { file: string; pin: NonNullable<Manifest["pin"]> }[] = []
  for (const file of receiptFiles) {
    artifactName(file, "checkpoint receipt")
    const parsed = object(
      JSON.parse((await readArtifact(source, `checkpoints/${file}`, MAX_MANIFEST_BYTES, true)).toString("utf8")),
      `checkpoint receipt ${file}`,
    )
    const pin: NonNullable<Manifest["pin"]> = {
      seq: safeInt(parsed.seq, `${file}.seq`),
      digest: digest(parsed.digest, `${file}.digest`),
      stateHash: digest(parsed.stateHash, `${file}.stateHash`),
      logHash: digest(parsed.logHash, `${file}.logHash`),
      ...(parsed.height === undefined ? {} : { height: safeInt(parsed.height, `${file}.height`) }),
      ...(parsed.v === undefined ? {} : { v: safeInt(parsed.v, `${file}.v`, 1) }),
      ...(typeof parsed.recipe === "string" ? { recipe: parsed.recipe } : {}),
      ...(typeof parsed.codeHash === "string" ? { codeHash: digest(parsed.codeHash, `${file}.codeHash`) } : {}),
    }
    if (pin.v !== undefined && pin.v !== 1 && pin.v !== 2) throw new Error(`${file}.v is unsupported`)
    if (parsed.anchor !== null && parsed.anchor !== undefined) {
      const claim = object(parsed.anchor, `${file}.anchor`)
      if (claim.contract !== undefined &&
          (typeof claim.contract !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(claim.contract))) {
        throw new Error(`${file}.anchor.contract must be an EVM address`)
      }
      pin.anchor = {
        ...(claim.chainId === undefined ? {} : { chainId: safeInt(claim.chainId, `${file}.anchor.chainId`) }),
        ...(claim.contract === undefined ? {} : { contract: claim.contract }),
      }
    }
    pins.push({ file, pin })
  }
  const evidence = await retainedReplayEvidence(events, snap(), new Set(pins.map(({ pin }) => pin.seq)))
  const v = evidence.verdict
  let inconclusive: string | null = null
  if (!v.valid && staleLaw(v.reason)) {
    // Same abstention as the published path — an operator checking their own mirror deserves the
    // same distinction between "your copy of the record is bad" and "your copy of the law is old".
    inconclusive = `${v.reason} (at seq ${v.failedAt})`
    bad(`cannot fold this record: ${v.reason}`)
    note("This says the TOOL is out of date, not that the record is bad — update and re-run.")
  } else if (!v.valid) { bad(`INVALID at seq ${v.failedAt}: ${v.reason}`); failures++ }
  else {
    ok(
      `hash chain, puddles, envelope hashes, reducer validity and signatures: ${v.events} events ` +
      `(${v.commandAuthProfile})`,
    )
    reportV1Execution(v.v1Execution)
    reportTransitionCompatibilities(evidence.transitionCompatibilities)
    reportRulesetAuthorization(v.rulesetAuthorization)
    reportChainTerminus(events)
  }

  console.log("\n3. the anchor")
  let latestAnchor: AnchorCheckResult | null = null
  const latestPinSeq = pins.length ? Math.max(...pins.map(({ pin }) => pin.seq)) : null
  if (!pins.length) {
    if (opts.rpcUrl) {
      bad("no checkpoint receipts are present; full verification requires an outside witness")
      failures++
    } else note("no checkpoint receipts are present; external verification was explicitly disabled")
  }
  for (const { pin: p } of pins) {
    if (!v.valid && p.seq >= (v.failedAt ?? Infinity)) {
      console.log(`  – pin at seq ${p.seq} skipped: past an event this tool cannot fold`)
      continue
    }
    const bounded = events.filter(e => e.seq <= p.seq)
    let stateHash = evidence.captures.get(p.seq)?.stateHash
    if (!stateHash) {
      try { stateHash = await retainedStateHashAt(events, snap(), p.seq) }
      catch (error) { bad(error instanceof Error ? error.message : String(error)); failures++; continue }
    }
    if (!bounded.length) { bad(`pin seq ${p.seq} is outside the supplied record`); failures++; continue }
    const anchor = await checkAnchor(p, { stateHash, logHash: bounded[bounded.length - 1].hash }, opts)
    failures += anchor.failures
    if (p.seq === latestPinSeq) latestAnchor = anchor
  }

  console.log("\nwhat this run did NOT prove:")
  console.log("  · the genesis SNAPSHOT — vouched for, not replayed; one named seam in the custodial system.")
  console.log("  · that this copy is COMPLETE. Only an anchor newer than your head can catch a short copy.")
  if (inconclusive) {
    console.log(`\nINCONCLUSIVE — this copy of the verifier is older than the record it was asked to check.`)
    console.log(`  ${inconclusive}`)
    process.exit(3)
  }
  if (!failures && opts.rpcUrl && latestAnchor?.legacyV1 && latestAnchor.chainMatched) {
    console.log("\nINCONCLUSIVE — the newest on-chain pin is v1 and cannot be re-derived by this reducer.")
    process.exit(3)
  }
  if (!failures && opts.rpcUrl && (!latestAnchor?.chainMatched || !latestAnchor.rederived)) {
    bad("the newest checkpoint did not complete both local re-derivation and external comparison")
    failures++
  }
  const verdict = failures
    ? `\nFAILED — ${failures} problem(s).`
    : opts.rpcUrl ? "\nVERIFIED." : "\nLOCAL REPLAY VERIFIED — external anchoring was not requested."
  console.log(verdict)
  process.exit(failures ? 1 : 0)
}

export async function main(args = process.argv.slice(2)): Promise<never> {
  const base = args[0]
  // The chain check is ON by default. It was opt-in once, which meant the one step that breaks
  // the circle was the one step most people would never run.
  if (!base || base.startsWith("--")) {
    console.error(
      "usage: systema-verify <dir-or-url> [--rpc <url> | --no-chain] " +
      "[--ruleset-authorization-evidence production|staging]",
    )
    process.exit(2)
  }
  let rpcUrl: string | null = ANCHOR.defaultRpc
  let sawRpc = false
  let sawNoChain = false
  let evidenceEnvironment: RulesetAuthorizationEnvironment | null = null
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--no-chain") {
      if (sawNoChain || sawRpc) {
        console.error("--no-chain is mutually exclusive with --rpc and may appear only once")
        process.exit(2)
      }
      sawNoChain = true
      rpcUrl = null
    } else if (arg === "--rpc") {
      if (sawRpc || sawNoChain || !args[index + 1] || args[index + 1].startsWith("--")) {
        console.error("--rpc requires exactly one URL and is mutually exclusive with --no-chain")
        process.exit(2)
      }
      sawRpc = true
      rpcUrl = args[++index]
      let parsed: URL
      try { parsed = new URL(rpcUrl) }
      catch { console.error("--rpc must be an absolute http(s) URL"); process.exit(2) }
      if (!/^https?:$/.test(parsed!.protocol) || parsed!.username || parsed!.password || parsed!.hash) {
        console.error("--rpc must be an absolute credential-free http(s) URL")
        process.exit(2)
      }
    } else if (arg === "--ruleset-authorization-evidence") {
      const environment = args[index + 1]
      if (evidenceEnvironment || (environment !== "production" && environment !== "staging")) {
        console.error("--ruleset-authorization-evidence requires exactly one production|staging value")
        process.exit(2)
      }
      evidenceEnvironment = environment
      index++
    } else {
      console.error(`unknown verifier option: ${arg}`)
      process.exit(2)
    }
  }

  if (evidenceEnvironment) {
    if (sawRpc || sawNoChain) {
      console.error("--ruleset-authorization-evidence is mutually exclusive with chain options")
      process.exit(2)
    }
    await emitRulesetAuthorizationEvidence(base, evidenceEnvironment)
    process.exit(0)
  }

  const source = createArtifactSource(base)
  console.log(`systema-verify — ${source.label}\n`)
  let failures = 0
  /** Set when the fold stops for a reason that is about THIS TOOL, not the record. */
  let inconclusive: string | null = null

  // TWO SHAPES, one tool. A PUBLISHED directory has a manifest and segments; an OPERATOR (or
  // mirrored) directory is a plain events.jsonl + genesis-state.json. `mirror.ts` produces the
  // second, so a verifier that only understood the first would tell every mirror operator their
  // copy was unverifiable — which is exactly backwards, since checking your own copy is the
  // whole point of holding one.
  const published = source.kind === "remote" || existsSync(safeLocalPath(source, "manifest.json"))
  if (!published) return verifyPlainDir(source, { rpcUrl })

  // ── 1. BYTES ──────────────────────────────────────────────────────────────
  console.log("1. bytes")
  const manifest = parsePublicationManifest(
    JSON.parse((await readArtifact(source, "manifest.json", MAX_MANIFEST_BYTES)).toString("utf8")),
  )
  const pieces: Buffer[] = []
  for (const s of manifest.segments) {
    const b = await readArtifact(source, s.file)
    if (b.length !== s.bytes || sha256(b) !== s.sha256) { bad(`${s.file} does not match its manifest bytes and hash`); failures++ }
    pieces.push(b)
  }
  const tail = await readArtifact(source, manifest.tail.file)
  if (tail.length !== manifest.tail.bytes || sha256(tail) !== manifest.tail.sha256) { bad("tail.jsonl does not match its manifest bytes and hash"); failures++ }
  pieces.push(tail)
  ok(`${manifest.segments.length} sealed segment(s) + tail match their published hashes`)

  if (manifest.research) {
    const b = await readArtifact(source, manifest.research.file)
    const parsed = JSON.parse(b.toString()) as {
      schema?: string
      source?: { record?: { head?: { seq?: number; hash?: string } }; foldedState?: { seq?: number; stateHash?: string } }
    }
    if (b.length !== manifest.research.bytes || sha256(b) !== manifest.research.sha256) { bad("research snapshot does not match its manifest bytes and hash"); failures++ }
    else if (parsed.schema !== "systema.research-snapshot.v1" || parsed.schema !== manifest.research.schema) {
      bad("research snapshot schema does not match its manifest entry"); failures++
    } else if (parsed.source?.record?.head?.seq !== manifest.head.seq || parsed.source.record.head.hash !== manifest.head.hash ||
               parsed.source?.foldedState?.seq !== manifest.head.seq || parsed.source.foldedState.stateHash !== manifest.research.stateHash) {
      bad("research snapshot does not name this manifest's record cut"); failures++
    } else ok(`research snapshot matches (${(b.length / 1e6).toFixed(1)} MB at head ${manifest.research.headSeq})`)
  }

  let snapshotBytes: Buffer | null = null
  if (manifest.genesis) {
    const g = await readArtifact(source, manifest.genesis.file)
    if (g.length !== manifest.genesis.bytes || sha256(g) !== manifest.genesis.sha256) { bad("genesis-state.json does not match its manifest bytes and hash"); failures++ }
    else ok(`genesis sidecar matches (${(g.length / 1e6).toFixed(1)} MB)`)
    snapshotBytes = g
    stateFromJson(snapshotBytes.toString("utf8"))
  }
  let bedrock: BedrockManifest | null = null
  let bedrockHash: string | null = null
  if (manifest.bedrock) {
    const b = await readArtifact(source, manifest.bedrock.file)
    bedrockHash = sha256(b)
    if (b.length !== manifest.bedrock.bytes || bedrockHash !== manifest.bedrock.sha256) { bad("bedrock provenance does not match its manifest bytes and hash"); failures++ }
    else ok(`bedrock provenance matches (${(b.length / 1e6).toFixed(1)} MB)`)
    bedrock = JSON.parse(b.toString()) as BedrockManifest
  }
  if (failures) { console.log("\nREFUSING to continue: the bytes are not what was promised."); process.exit(1) }

  const events = pieces.map(b => b.toString()).join("").split("\n").filter(l => l.trim())
    .map(l => JSON.parse(l) as AnyEventEnvelope)
  if (events.length !== manifest.totalEvents) {
    bad(`assembled ${events.length} events, manifest promised ${manifest.totalEvents}`); failures++
  }
  const head = events[events.length - 1]
  if (head.seq !== manifest.head.seq || head.hash !== manifest.head.hash) {
    bad("assembled head does not match the manifest head"); failures++
  } else ok(`assembled ${events.length} events, head seq ${head.seq} @ ${head.ts}`)

  // ── 2-4. RECORD, LAW, SIGNATURES ──────────────────────────────────────────
  console.log("\n2. the record, the law, the signatures")
  const bedrockAttestation = bedrockHash ? events.find(event =>
    event.kind === "ATTESTATION" && event.payload.actId === BEDROCK_ATTESTATION_ID && event.payload.actHash === bedrockHash) : undefined
  const captureSeqs = new Set<number>()
  if (manifest.pin) captureSeqs.add(manifest.pin.seq)
  if (bedrockAttestation && bedrockAttestation.seq > 0) captureSeqs.add(bedrockAttestation.seq - 1)
  // Reparse the same bytes verified in step 1. A remote publisher must not be able to swap a
  // sidecar between repeated requests after its first response passed the manifest hash.
  const evidence = await retainedReplayEvidence(
    events,
    snapshotBytes ? stateFromJson(snapshotBytes.toString("utf8")) : undefined,
    captureSeqs,
  )
  const v = evidence.verdict
  if (!v.valid && staleLaw(v.reason)) {
    // NOT A FINDING. AN ABSTENTION.
    //
    // An unknown event kind is a statement about THIS TOOL and can never be a statement about
    // the record: the kingdom's sequencer accepted that event under a rulebook that knows the
    // kind, and this copy of the reducer does not. Reporting it as INVALID would be a published
    // accusation, made by the keeper's own tool, against the record it exists to defend — read
    // by the one audience with no way to tell the instrument from the subject.
    //
    // This is the failure mode that cannot be repaired after publication: clones already in the
    // wild go stale on their own, silently, the next time a new kind is ratified. So the verdict
    // has three values, not two. Nothing here is a pass — INCONCLUSIVE exits non-zero (3) and no
    // forger gains anything by it, because no record can reach VERIFIED this way.
    inconclusive = `${v.reason} (at seq ${v.failedAt})`
    bad(`cannot fold this record: ${v.reason}`)
    note("This says the TOOL is out of date, not that the record is bad. The kingdom accepted that")
    note("event under a rulebook that knows the kind; this copy does not, so it is not entitled to")
    note("an opinion about it.  Update and re-run:  git pull && npm ci")
  } else if (!v.valid) {
    bad(`INVALID at seq ${v.failedAt}: ${v.reason}`); failures++
    const mine = ownCodeHash()
    if (manifest.pin?.codeHash && mine && mine !== manifest.pin.codeHash) {
      note("BUT your copy of the law is NOT the one that computed this record's pin — update this")
      note("tool before reading the line above as a finding about the kingdom.")
    }
  } else {
    ok(
      `hash chain, puddles, envelope hashes, reducer validity and signatures: ${v.events} events ` +
      `(${v.commandAuthProfile})`,
    )
    reportV1Execution(v.v1Execution)
    reportTransitionCompatibilities(evidence.transitionCompatibilities)
    reportRulesetAuthorization(v.rulesetAuthorization)
    reportChainTerminus(events)
    if (bedrock && bedrockHash && snapshotBytes && manifest.bedrock) {
      const governanceAtCommit = bedrockAttestation?.seq
        ? evidence.captures.get(bedrockAttestation.seq - 1)?.governance
        : undefined
      failures += checkBedrock(bedrock, bedrockHash, manifest.bedrock, events, snapshotBytes, governanceAtCommit)
    }
  }

  // ── 5. ANCHOR ─────────────────────────────────────────────────────────────
  console.log("\n3. the anchor")
  let anchor: AnchorCheckResult | null = null
  if (!manifest.pin) {
    if (rpcUrl) {
      bad("no checkpoint is published; full verification requires an outside witness")
      failures++
    } else note("no checkpoint is published; external verification was explicitly disabled")
  } else if (inconclusive && manifest.pin.seq >= (v.failedAt ?? Infinity)) {
    // The pin sits at or past the event this tool cannot read, so folding to it would throw. Not
    // a failure to report — a question this copy is not equipped to ask.
    console.log("  – skipped: the pin is at seq " + manifest.pin.seq + ", past an event this tool cannot fold")
  } else {
    const p = manifest.pin
    const bounded = events.filter(e => e.seq <= p.seq)
    let stateHash = evidence.captures.get(p.seq)?.stateHash
    if (!stateHash) {
      try {
        stateHash = await retainedStateHashAt(
          events,
          snapshotBytes ? stateFromJson(snapshotBytes.toString("utf8")) : undefined,
          p.seq,
        )
      } catch (error) {
        bad(error instanceof Error ? error.message : String(error))
        failures++
      }
    }
    if (stateHash) {
      if (!bounded.length) {
        bad(`pin seq ${p.seq} is outside the supplied record`)
        failures++
      } else {
        anchor = await checkAnchor(p, { stateHash, logHash: bounded[bounded.length - 1].hash }, { rpcUrl })
        failures += anchor.failures
      }
    }
  }

  // ── what remains vouched for ──────────────────────────────────────────────
  console.log("\nwhat this run did NOT prove:")
  if (manifest.genesis) {
    if (bedrock) {
      console.log("  · the sealed archive's signatures were not replayed in this run. The published bedrock")
      console.log("    lots reconcile genesis exactly and are governance-committed; rebuild them from the")
      console.log("    archive with tools/build-bedrock-provenance.ts to independently prove their ancestry.")
    } else {
      console.log("  · the genesis SNAPSHOT. Its bytes are pinned, but what it asserts about the pre-log")
      console.log("    chain era is vouched for, not replayed; it is one named seam in the custodial system.")
    }
  }
  console.log("  · that you were served the whole record. A publisher can always show a short prefix;")
  console.log("    only an anchor older than the head you hold can catch that. Check the pin on-chain.")

  // THREE VERDICTS. 0 verified · 1 the record failed · 2 the run broke · 3 this tool abstains.
  // The third exists because the second is an accusation, and a tool that has fallen behind the
  // law has not earned one.
  if (inconclusive) {
    console.log(`\nINCONCLUSIVE — this copy of the verifier is older than the record it was asked to check.`)
    console.log(`  ${inconclusive}`)
    console.log("  Nothing above is a finding against the kingdom, and nothing above is a pass.")
    process.exit(3)
  }
  if (!failures && rpcUrl && anchor?.legacyV1 && anchor.chainMatched) {
    console.log("\nINCONCLUSIVE — the published on-chain pin is v1 and cannot be re-derived by this reducer.")
    process.exit(3)
  }
  if (!failures && rpcUrl && (!anchor?.chainMatched || !anchor.rederived)) {
    bad("the checkpoint did not complete both local re-derivation and external comparison")
    failures++
  }
  const verdict = failures
    ? `\nFAILED — ${failures} problem(s).`
    : rpcUrl ? "\nVERIFIED." : "\nLOCAL REPLAY VERIFIED — external anchoring was not requested."
  console.log(verdict)
  process.exit(failures ? 1 : 0)
}

// Executability is structural, never controlled by ambient test variables. The generated bin
// imports this module (so its own shim is `require.main`) and invokes `main` explicitly.
if (require.main === module) {
  main().catch(e => { console.error(`\nerror: ${e instanceof Error ? e.message : e}`); process.exit(2) })
}
