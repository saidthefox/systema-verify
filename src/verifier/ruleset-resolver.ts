import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { require as requireTs } from "tsx/cjs/api"
import type { CommandEnvelopeV2, CoreState, DecisionV2, EventEnvelope, EventEnvelopeV2, Outcome } from "../core/types"
import type {
  DecisionVerifierV2,
  FactEvolverV1,
  FactEvolverV2,
  RulesetResolverV2,
  StateInitializerV1,
} from "../core/verify"

interface RulesetIndex {
  format: 1
  artifacts: {
    rulesetHash: string
    path: string
    status: "candidate" | "compatibility-baseline" | "unrecoverable"
    protocols: number[]
    unrecoverable?: { reason: string; missingFiles: string[] }
  }[]
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

export interface RetainedExecutionV2 {
  decideV2: DecisionFunctionV2
  evolveFactV2: FactEvolverV2
}

export type RetainedExecutionResolverV2 = (
  rulesetHash: string,
) => RetainedExecutionV2 | null | Promise<RetainedExecutionV2 | null>

/** Raw protocol-v1 functions loaded from one fully integrity-checked retained artifact. */
export interface RetainedExecutionV1 {
  initState: StateInitializerV1
  admitFactV1: FactEvolverV1
  evolveFactV1: FactEvolverV1
}

export type RetainedExecutionResolverV1 = (
  rulesetHash: string,
) => RetainedExecutionV1 | null | Promise<RetainedExecutionV1 | null>

interface LoadedRuleset {
  supportsV1: boolean
  supportsV2: boolean
  reasonV1?: string
  reasonV2?: string
  initState?: StateInitializerV1
  admitFactV1?: FactEvolverV1
  evolveFactV1?: FactEvolverV1
  decideV2?: DecisionFunctionV2
  verifyDecisionV2?: DecisionVerifierV2
  evolveFactV2?: FactEvolverV2
}

type RulesetLoader = (rulesetHash: string) => Promise<LoadedRuleset | null>

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
      return {
        verifyDecisionV2: async () => ({ valid: false, reason: loaded.reasonV2 }),
        evolveFactV2: () => { throw new Error(loaded.reasonV2) },
      }
    }
    return { verifyDecisionV2: loaded.verifyDecisionV2!, evolveFactV2: loaded.evolveFactV2! }
  }
}

/** Resolve the exact pure decision function needed by the durable writer during recovery. */
export function createRetainedDecisionResolver(root: string): RetainedDecisionResolverV2 {
  const load = createRetainedRulesetLoader(root)
  return async (rulesetHash: string) => {
    const loaded = await load(rulesetHash)
    if (!loaded) return null
    if (!loaded.supportsV2) throw new Error(loaded.reasonV2)
    return loaded.decideV2!
  }
}

/** Resolve the inseparable admission and transition pair used by the durable writer. */
export function createRetainedExecutionResolver(root: string): RetainedExecutionResolverV2 {
  const load = createRetainedRulesetLoader(root)
  return async (rulesetHash: string) => {
    const loaded = await load(rulesetHash)
    if (!loaded) return null
    if (!loaded.supportsV2) throw new Error(loaded.reasonV2)
    return { decideV2: loaded.decideV2!, evolveFactV2: loaded.evolveFactV2! }
  }
}

/** Resolve all v1 execution functions from the same complete content-addressed artifact. */
export function createRetainedExecutionResolverV1(root: string): RetainedExecutionResolverV1 {
  const load = createRetainedRulesetLoader(root)
  return async (rulesetHash: string) => {
    const loaded = await load(rulesetHash)
    if (!loaded) return null
    if (!loaded.supportsV1) throw new Error(loaded.reasonV1)
    return {
      initState: loaded.initState!,
      admitFactV1: loaded.admitFactV1!,
      evolveFactV1: loaded.evolveFactV1!,
    }
  }
}

function createRetainedRulesetLoader(root: string): RulesetLoader {
  const absoluteRoot = resolve(/* turbopackIgnore: true */ root)
  const indexPath = join(/* turbopackIgnore: true */ absoluteRoot, "index.json")
  if (!existsSync(indexPath)) throw new Error(`ruleset registry not found: ${indexPath}`)
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as RulesetIndex
  if (index.format !== 1 || !Array.isArray(index.artifacts)) throw new Error("unsupported ruleset registry")
  const cache = new Map<string, Promise<LoadedRuleset | null>>()

  return (rulesetHash: string) => {
    const prior = cache.get(rulesetHash)
    if (prior) return prior
    const loading = load(rulesetHash)
    cache.set(rulesetHash, loading)
    return loading
  }

  async function load(rulesetHash: string): Promise<LoadedRuleset | null> {
    if (!/^[0-9a-f]{64}$/.test(rulesetHash)) throw new Error(`invalid ruleset address: ${rulesetHash}`)
    const entry = index.artifacts.find(candidate => candidate.rulesetHash === rulesetHash)
    if (!entry) return null
    if (entry.path !== `rulesets/${rulesetHash}`) throw new Error(`ruleset registry path mismatch for ${rulesetHash}`)
    if (!["candidate", "compatibility-baseline", "unrecoverable"].includes(entry.status)) {
      throw new Error(`ruleset registry has unsupported status for ${rulesetHash}: ${String(entry.status)}`)
    }

    const artifact = join(/* turbopackIgnore: true */ absoluteRoot, rulesetHash)
    const manifestPath = join(artifact, "manifest.json")
    if (!existsSync(manifestPath)) throw new Error(`retained ruleset ${rulesetHash} has no manifest`)
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RulesetManifest
    if (manifest.format !== 1 || manifest.rulesetHash !== rulesetHash) {
      throw new Error(`retained ruleset ${rulesetHash} manifest does not match its address`)
    }

    const core = join(artifact, "src", "core")
    const expectedFiles = Object.keys(manifest.files).sort()

    if (entry.status === "unrecoverable") {
      const unavailable = entry.unrecoverable
      if (!unavailable || typeof unavailable.reason !== "string" || unavailable.reason.trim() !== unavailable.reason
        || unavailable.reason.length === 0 || !Array.isArray(unavailable.missingFiles)
        || unavailable.missingFiles.some(file => typeof file !== "string")) {
        throw new Error(`unrecoverable ruleset ${rulesetHash} has invalid registry metadata`)
      }
      const missingFiles = [...unavailable.missingFiles]
      if (missingFiles.length === 0 || new Set(missingFiles).size !== missingFiles.length
        || JSON.stringify([...missingFiles].sort()) !== JSON.stringify(missingFiles)
        || missingFiles.some(file => !/^src\/core\/[^/]+\.ts$/.test(file))) {
        throw new Error(`unrecoverable ruleset ${rulesetHash} has invalid missing-file roster`)
      }
      const files = readdirSync(core).filter(file => file.endsWith(".ts")).sort()
      const actualFiles = files.map(file => `src/core/${file}`)
      const unexpected = actualFiles.filter(file => !(file in manifest.files))
      if (unexpected.length) {
        throw new Error(`unrecoverable ruleset ${rulesetHash} has unmanifested source: ${unexpected.join(", ")}`)
      }
      const actuallyMissing = expectedFiles.filter(file => !actualFiles.includes(file))
      if (JSON.stringify(actuallyMissing) !== JSON.stringify(missingFiles)) {
        throw new Error(`unrecoverable ruleset ${rulesetHash} missing-file roster differs from disk`)
      }
      for (const file of files) {
        const bytes = readFileSync(join(core, file))
        const rel = `src/core/${file}`
        if (sha256(bytes) !== manifest.files[rel]) throw new Error(`retained ruleset ${rulesetHash} changed ${rel}`)
      }
      return {
        supportsV1: false,
        supportsV2: false,
        reasonV1: `ruleset artifact unavailable: ${rulesetHash}. ${unavailable.reason} Missing manifest files: ${missingFiles.join(", ")}`,
        reasonV2: `ruleset artifact unavailable: ${rulesetHash}. ${unavailable.reason} Missing manifest files: ${missingFiles.join(", ")}`,
      }
    }

    if (entry.unrecoverable !== undefined) {
      throw new Error(`usable ruleset ${rulesetHash} carries unrecoverable registry metadata`)
    }
    // Filesystem metadata is not law. Keep this filter identical to build-ruleset-artifact.ts;
    // Docker excludes AppleDouble sidecars and a host verifier must see the same roster.
    const files = readdirSync(core).filter(file => file.endsWith(".ts") && !file.startsWith("._")).sort()
    const aggregate = createHash("sha256")
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

    const supportsV1 = entry.protocols.includes(1) && manifest.protocols.includes(1)
    const supportsV2 = entry.protocols.includes(2) && manifest.protocols.includes(2)
    if (!supportsV1 && !supportsV2) {
      return {
        supportsV1: false,
        supportsV2: false,
        reasonV1: `retained ruleset ${rulesetHash} does not support protocol 1`,
        reasonV2: `retained ruleset ${rulesetHash} does not support protocol 2`,
      }
    }

    // Retained artifacts are deliberately source, not a second compiled implementation of law.
    // Both the standalone verifier and the Next server therefore use the same scoped TS loader.
    const retainedReducer = requireTs(join(core, "reducer.ts"), indexPath) as {
      initState?: StateInitializerV1
      applyEvent?: FactEvolverV1
      evolveV1?: (state: CoreState, event: EventEnvelope) => Outcome
      factualEvent?: (event: EventEnvelopeV2) => EventEnvelope
    }
    if (typeof retainedReducer.evolveV1 !== "function" ||
        (supportsV1 && (typeof retainedReducer.initState !== "function" || typeof retainedReducer.applyEvent !== "function"))) {
      throw new Error(`retained ruleset ${rulesetHash} exports no factual state transition`)
    }

    let decideV2: DecisionFunctionV2 | undefined
    let verifyDecisionV2: DecisionVerifierV2 | undefined
    let evolveFactV2: FactEvolverV2 | undefined
    if (supportsV2) {
      const sourcePath = join(core, "protocol-v2.ts")
      const loaded = requireTs(sourcePath, indexPath) as {
        decideV2?: DecisionFunctionV2
        verifyDecisionV2?: DecisionVerifierV2
      }
      if (typeof loaded.decideV2 !== "function") throw new Error(`retained ruleset ${rulesetHash} exports no v2 decision function`)
      if (typeof loaded.verifyDecisionV2 !== "function") throw new Error(`retained ruleset ${rulesetHash} exports no v2 decision verifier`)
      decideV2 = loaded.decideV2
      verifyDecisionV2 = loaded.verifyDecisionV2
      evolveFactV2 = (state, event) => {
        // The earliest v2 artifact predates the named adapter export. Its writer used this exact
        // envelope-only conversion; later artifacts bind the adapter inside the retained core.
        const factual = typeof retainedReducer.factualEvent === "function"
          ? retainedReducer.factualEvent(event)
          : { ...event, sig: event.cause.command.sig }
        return retainedReducer.evolveV1!(state, factual)
      }
    }
    return {
      supportsV1,
      supportsV2,
      ...(supportsV1 ? {
        initState: retainedReducer.initState!,
        admitFactV1: retainedReducer.applyEvent!,
        evolveFactV1: retainedReducer.evolveV1!,
      } : { reasonV1: `retained ruleset ${rulesetHash} does not support protocol 1` }),
      ...(supportsV2 ? {
        decideV2,
        verifyDecisionV2,
      } : { reasonV2: `retained ruleset ${rulesetHash} does not support protocol 2` }),
      evolveFactV2,
    }
  }
}
