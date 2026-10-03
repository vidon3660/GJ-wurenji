import { readFile } from "node:fs/promises"

const healthPath = process.env.WORKER_HEALTH_FILE?.trim() || "/tmp/wurenji-worker-health.json"
const maximumAgeMs = normalizeMaximumAge(process.env.WORKER_HEALTH_MAX_AGE_MS)

try {
  const value = JSON.parse(await readFile(healthPath, "utf8")) as { status?: unknown; lastSuccessfulCycleAt?: unknown }
  const checkedAt = typeof value.lastSuccessfulCycleAt === "string" ? Date.parse(value.lastSuccessfulCycleAt) : Number.NaN
  if (value.status !== "ready" || !Number.isFinite(checkedAt) || Date.now() - checkedAt > maximumAgeMs) process.exitCode = 1
} catch {
  process.exitCode = 1
}

function normalizeMaximumAge(value: string | undefined): number {
  const result = Number(value ?? 120_000)
  return Number.isInteger(result) && result >= 1_000 ? result : 120_000
}
