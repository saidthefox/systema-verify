import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { AnyEventEnvelope } from "../core/types"
import { replaceDurableFile } from "../record/store"

/**
 * A witness that replays whatever record it is handed proves that record is internally valid,
 * not that it is the SAME record it vouched for before. Each event's hash commits to its
 * predecessor, so "this record still holds hash H at seq S" proves the whole prefix through S is
 * unchanged. A witness checks that against two heads it already trusts, and refuses otherwise:
 *
 *  - the last on-chain checkpoint (`latestSeq`, `recordHeadHashAt(latestSeq)`), which the next
 *    checkpoint's signatures bind as their predecessor. Without this, a host that rewrote history
 *    below the pin still collected both signatures (Opus 5.5 analysis, 2026-10-05, S-2);
 *  - the last head this witness itself replayed and accepted, kept beside its output, which also
 *    covers candidates signed but never posted and witnesses running with no deployment.
 */
export interface WitnessedHead {
  schema: "systema.witnessed-head.v1"
  environment: string
  recordGenesisHash: string
  seq: number
  hash: string
}

const WITNESSED_HEAD = "witnessed-head.json"

function bare(hash: string): string {
  return hash.toLowerCase().replace(/^0x/, "")
}

function eventAt(events: readonly AnyEventEnvelope[], seq: number): AnyEventEnvelope | undefined {
  const guess = events[seq - (events[0]?.seq ?? 0)]
  return guess?.seq === seq ? guess : events.find(event => event.seq === seq)
}

/** Throws unless `events` holds exactly `hash` at `seq`. `what` names the head for the operator. */
export function assertRecordExtends(
  events: readonly AnyEventEnvelope[],
  seq: number,
  hash: string,
  what: string,
): void {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error(`${what} names an invalid seq ${seq}`)
  const event = eventAt(events, seq)
  if (!event) {
    throw new Error(`record does not extend ${what}: it stops at seq ${events.at(-1)?.seq ?? "none"}, before ${seq}`)
  }
  if (bare(event.hash) !== bare(hash)) {
    throw new Error(
      `record does not extend ${what}: seq ${seq} is ${bare(event.hash).slice(0, 16)}…, ` +
      `${what} is ${bare(hash).slice(0, 16)}…`,
    )
  }
}

export function readWitnessedHead(outputDir: string): WitnessedHead | null {
  const path = join(outputDir, WITNESSED_HEAD)
  if (!existsSync(path)) return null
  const head = JSON.parse(readFileSync(path, "utf8")) as WitnessedHead
  if (head?.schema !== "systema.witnessed-head.v1" || !Number.isSafeInteger(head.seq) ||
    typeof head.hash !== "string" || typeof head.recordGenesisHash !== "string") {
    throw new Error(`${path} is not a witnessed-head record; refusing to guess what this witness accepted`)
  }
  return head
}

/** The witness's own memory. A different genesis is refused, not re-learned: a deliberately
 * re-founded staging record needs its operator to remove the file, which is the point. */
export function assertExtendsWitnessedHead(
  events: readonly AnyEventEnvelope[],
  environment: string,
  outputDir: string,
): void {
  const head = readWitnessedHead(outputDir)
  if (!head) return
  const genesis = events[0]?.hash
  if (head.environment !== environment || !genesis || bare(head.recordGenesisHash) !== bare(genesis)) {
    throw new Error(
      `this witness last accepted a ${head.environment} record with genesis ${bare(head.recordGenesisHash).slice(0, 16)}…; ` +
      `it was handed ${environment} genesis ${genesis ? bare(genesis).slice(0, 16) : "none"}… ` +
      `(remove ${join(outputDir, WITNESSED_HEAD)} only if that record was deliberately re-founded)`,
    )
  }
  assertRecordExtends(events, head.seq, head.hash, `the head this witness last accepted (seq ${head.seq})`)
}

export function recordWitnessedHead(outputDir: string, environment: string, events: readonly AnyEventEnvelope[]): void {
  const head = events.at(-1)
  if (!head) return
  const record: WitnessedHead = {
    schema: "systema.witnessed-head.v1",
    environment,
    recordGenesisHash: `0x${bare(events[0].hash)}`,
    seq: head.seq,
    hash: `0x${bare(head.hash)}`,
  }
  replaceDurableFile(join(outputDir, WITNESSED_HEAD), `${JSON.stringify(record, null, 2)}\n`)
}
