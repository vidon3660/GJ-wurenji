import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const beforeArgument = argument("before")
const afterArgument = argument("after")
if (!beforeArgument || !afterArgument) throw new Error("用法：node scripts/analyze-heap-snapshots.mjs --before <文件> --after <文件> [--match <正则>] [--output <文件>]")
const beforePath = resolve(beforeArgument)
const afterPath = resolve(afterArgument)
const outputArgument = argument("output")
const outputPath = outputArgument ? resolve(outputArgument) : null
const pattern = new RegExp(argument("match") ?? "runtime|workspace|snapshot|eventsource|vue|effect|reactive|timer|aircraft|group", "i")
const minimumDeltaBytes = Number(argument("min-delta") ?? 1_024)

const [before, after] = await Promise.all([loadSnapshot(beforePath), loadSnapshot(afterPath)])
const beforeSummary = summarize(before, pattern)
const afterSummary = summarize(after, pattern)
const keys = new Set([...beforeSummary.keys(), ...afterSummary.keys()])
const groups = [...keys].map((key) => {
  const left = beforeSummary.get(key) ?? emptySummary()
  const right = afterSummary.get(key) ?? emptySummary()
  return {
    key,
    before: left,
    after: right,
    delta: { count: right.count - left.count, selfSize: right.selfSize - left.selfSize }
  }
}).filter((item) => item.delta.count !== 0 || Math.abs(item.delta.selfSize) >= minimumDeltaBytes)
  .sort((left, right) => right.delta.selfSize - left.delta.selfSize)

const report = {
  format: "wurenji-heap-snapshot-diff",
  formatVersion: 1,
  before: beforePath,
  after: afterPath,
  match: pattern.source,
  minimumDeltaBytes,
  groups: groups.slice(0, 200)
}

if (outputPath) await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify({ groups: groups.length, largest: groups.slice(0, 20), output: outputPath })}\n`)

async function loadSnapshot(path) {
  return JSON.parse(await readFile(path, "utf8"))
}

function summarize(snapshot, matcher) {
  const fields = snapshot.snapshot.meta.node_fields
  const typeIndex = fields.indexOf("type")
  const nameIndex = fields.indexOf("name")
  const sizeIndex = fields.indexOf("self_size")
  const types = snapshot.snapshot.meta.node_types[typeIndex]
  const result = new Map()
  for (let index = 0; index < snapshot.nodes.length; index += fields.length) {
    const type = types[snapshot.nodes[index + typeIndex]]
    const name = snapshot.strings[snapshot.nodes[index + nameIndex]]
    if (!matcher.test(name) || type === "string" || type === "code") continue
    const key = `${type}:${name}`
    const current = result.get(key) ?? emptySummary()
    current.count += 1
    current.selfSize += snapshot.nodes[index + sizeIndex]
    result.set(key, current)
  }
  return result
}

function emptySummary() {
  return { count: 0, selfSize: 0 }
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}
