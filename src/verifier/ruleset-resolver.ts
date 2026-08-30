import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { require as requireTs } from "tsx/cjs/api"
import type { CommandEnvelopeV2, CoreState, DecisionV2 } from "../core/types"
import type { DecisionVerifierV2, RulesetResolverV2 } from "../core/verify"

interface RulesetIndex {
  format: 1
  artifacts: { rulesetHash: string; path: string; protocols: number[] }[]
}

interface RulesetManifest {
  format: 1
  rulesetHash: string
  protocols: number[]
  files: Record<string, string>
}

const sha256 = (value: Buffer): string => createHash("sha256").update(value).digest("hex")

export type DecisionFunctionV2 = (
  stateBefore: CoreState,
  command: CommandEnvelopeV2,
  ts: string,
) => DecisionV2

export type RetainedDecisionResolverV2 = (
  rulesetHash: string,
) => DecisionFunctionV2 | null | Promise<DecisionFunctionV2 | null>

interface LoadedRulesetV2 {
  supportsV2: boolean
  reason?: string
  decideV2?: DecisionFunctionV2
  verifyDecisionV2?: DecisionVerifierV2
}

type RulesetLoaderV2 = (rulesetHash: string) => Promise<LoadedRulesetV2 | null>

/**
 * Resolve decision proof code only after proving the retained artifact's complete core directory
 * still hashes to the address named by the event. The registry chooses availability, never a
 * path: artifact bytes are always read from `<root>/<lowercase sha256>`.
 */
export function createRetainedRulesetResolver(root: string): RulesetResolverV2 {
  const load = createRetainedRulesetLoader(root)
  return async (rulesetHash: string) => {
    const loaded = await load(rulesetHash)
    if (!loaded) return null
    if (!loaded.supportsV2) {
      return async () => ({ valid: false, reason: loaded.reason })
    }
    return loaded.verifyDecisionV2!
  }
}

/** Resolve the exact pure decision function needed by the durable writer during recovery. */
export function createRetainedDecisionResolver(root: string): RetainedDecisionResolverV2 {
  const load = createRetainedRulesetLoader(root)
  return async (rulesetHash: string) => {
    const loaded = await load(rulesetHash)
    if (!loaded) return null
    if (!loaded.supportsV2) throw new Error(loaded.reason)
    return loaded.decideV2!
  }
}

function createRetainedRulesetLoader(root: string): RulesetLoaderV2 {
  const absoluteRoot = resolve(/* turbopackIgnore: true */ root)
  const indexPath = join(/* turbopackIgnore: true */ absoluteRoot, "index.json")
  if (!existsSync(indexPath)) throw new Error(`ruleset registry not found: ${indexPath}`)
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as RulesetIndex
  if (index.format !== 1 || !Array.isArray(index.artifacts)) throw new Error("unsupported ruleset registry")
  const cache = new Map<string, Promise<LoadedRulesetV2 | null>>()

  return (rulesetHash: string) => {
    const prior = cache.get(rulesetHash)
    if (prior) return prior
    const loading = load(rulesetHash)
    cache.set(rulesetHash, loading)
    return loading
  }

  async function load(rulesetHash: string): Promise<LoadedRulesetV2 | null> {
    if (!/^[0-9a-f]{64}$/.test(rulesetHash)) throw new Error(`invalid ruleset address: ${rulesetHash}`)
    const entry = index.artifacts.find(candidate => candidate.rulesetHash === rulesetHash)
    if (!entry) return null
    if (entry.path !== `rulesets/${rulesetHash}`) throw new Error(`ruleset registry path mismatch for ${rulesetHash}`)

    const artifact = join(/* turbopackIgnore: true */ absoluteRoot, rulesetHash)
    const manifestPath = join(artifact, "manifest.json")
    if (!existsSync(manifestPath)) throw new Error(`retained ruleset ${rulesetHash} has no manifest`)
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RulesetManifest
    if (manifest.format !== 1 || manifest.rulesetHash !== rulesetHash) {
      throw new Error(`retained ruleset ${rulesetHash} manifest does not match its address`)
    }

    const core = join(artifact, "src", "core")
    // Filesystem metadata is not law. Keep this filter identical to build-ruleset-artifact.ts;
    // Docker excludes AppleDouble sidecars and a host verifier must see the same roster.
    const files = readdirSync(core).filter(file => file.endsWith(".ts") && !file.startsWith("._")).sort()
    const aggregate = createHash("sha256")
    const expectedFiles = Object.keys(manifest.files).sort()
    const actualFiles = files.map(file => `src/core/${file}`)
    if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
      throw new Error(`retained ruleset ${rulesetHash} manifest file roster differs from disk`)
    }
    for (const file of files) {
      const bytes = readFileSync(join(core, file))
      const rel = `src/core/${file}`
      if (sha256(bytes) !== manifest.files[rel]) throw new Error(`retained ruleset ${rulesetHash} changed ${rel}`)
      aggregate.update(file).update("\0").update(bytes)
    }
    if (aggregate.digest("hex") !== rulesetHash) throw new Error(`retained ruleset ${rulesetHash} aggregate hash mismatch`)

    if (!entry.protocols.includes(2) || !manifest.protocols.includes(2)) {
      return { supportsV2: false, reason: `retained ruleset ${rulesetHash} does not support protocol 2` }
    }
    const sourcePath = join(core, "protocol-v2.ts")
    // Retained artifacts are deliberately source, not a second compiled implementation of law.
    // Both the standalone verifier and the Next server therefore use the same scoped TS loader.
    const loaded = requireTs(sourcePath, indexPath) as {
      decideV2?: DecisionFunctionV2
      verifyDecisionV2?: DecisionVerifierV2
    }
    if (typeof loaded.decideV2 !== "function") throw new Error(`retained ruleset ${rulesetHash} exports no v2 decision function`)
    if (typeof loaded.verifyDecisionV2 !== "function") throw new Error(`retained ruleset ${rulesetHash} exports no v2 decision verifier`)
    return { supportsV2: true, decideV2: loaded.decideV2, verifyDecisionV2: loaded.verifyDecisionV2 }
  }
}
