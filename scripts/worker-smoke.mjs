import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import pg from "pg"

const { Client } = pg
const databaseUrl = argument("database-url") ?? process.env.DATABASE_URL ?? "postgresql://wurenji@localhost:55432/wurenji"
const outputPath = resolve(argument("output") ?? `artifacts/worker/worker-smoke-${timestamp()}.json`)
const timeoutMs = positiveInteger(argument("timeout-ms") ?? process.env.WORKER_SMOKE_TIMEOUT_MS, 15_000)
const scene = normalizeScene(argument("scene") ?? process.env.WORKER_SMOKE_SCENE ?? "CITY_SHOW")
const jobType = scene === "VTOL_INSPECTION" ? "VTL_REPORT_GENERATE" : "SHOW_REPORT_GENERATE"
const aggregateType = scene === "VTOL_INSPECTION" ? "VTL_PROJECT" : "SHOW_PROJECT"
const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 })
const startedAt = new Date()

let report
let completedEventId = null
try {
  await client.connect()
  const project = await findCandidate(client, scene)
  if (!project) throw new Error(`未找到已发布且已有最终报告的${scene === "VTOL_INSPECTION" ? "垂起巡检" : "表演"}项目`)
  const before = await reportState(client, project.projectId)
  const eventId = randomUUID()
  const correlationId = randomUUID()
  await client.query(`
    INSERT INTO "outbox_events" (
      "id", "eventType", "jobType", "aggregateType", "aggregateId", "status", "payload",
      "priority", "attempts", "maxAttempts", "availableAt", "correlationId", "createdAt", "updatedAt"
    ) VALUES ($1, 'WORKER_ACCEPTANCE', $2, $3, $4, 'PENDING', $5::jsonb, 100, 0, 3, now(), $6, now(), now())
  `, [eventId, jobType, aggregateType, project.projectId, JSON.stringify({ projectId: project.projectId, actorId: project.actorId, format: "PDF", acceptance: true }), correlationId])
  const job = await waitForJob(client, eventId, timeoutMs)
  completedEventId = eventId
  const after = await reportState(client, project.projectId)
  const passed = job.status === "SUCCEEDED"
    && job.outboxStatus === "PUBLISHED"
    && before.assetId === after.assetId
    && before.format === after.format
    && before.availableAssetCount === after.availableAssetCount
  report = {
    format: "wurenji-worker-smoke",
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    summary: { passed },
    projectId: project.projectId,
    eventId,
    before,
    job,
    after,
    checks: {
      outboxPublished: job.outboxStatus === "PUBLISHED",
      jobSucceeded: job.status === "SUCCEEDED",
      singleAttempt: job.attempts === 1,
      reportAssetUnchanged: before.assetId === after.assetId,
      reportFormatUnchanged: before.format === after.format,
      availableAssetCountUnchanged: before.availableAssetCount === after.availableAssetCount
    }
  }
} catch (error) {
  report = {
    format: "wurenji-worker-smoke",
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    summary: { passed: false },
    error: error instanceof Error ? error.message : String(error)
  }
} finally {
  if (completedEventId) {
    await client.query(`DELETE FROM "jobs" WHERE "sourceOutboxEventId" = $1`, [completedEventId]).catch(() => undefined)
    await client.query(`DELETE FROM "outbox_events" WHERE "id" = $1`, [completedEventId]).catch(() => undefined)
    if (report) report.cleanup = { queueRecordsRemoved: true }
  }
  await client.end().catch(() => undefined)
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify({ summary: report.summary, output: outputPath })}\n`)
if (!report.summary.passed) process.exitCode = 1

async function findCandidate(database, sceneType) {
  const result = await database.query(`
    SELECT project."id" AS "projectId", evaluation."reviewedById" AS "actorId"
    FROM "student_projects" project
    JOIN "assignment_snapshots" snapshot ON snapshot."id" = project."snapshotId"
    JOIN "assignment_drafts" draft ON draft."id" = snapshot."draftId"
    JOIN "project_evaluations" evaluation ON evaluation."projectId" = project."id"
    JOIN "show_project_reports" report ON report."projectId" = project."id"
    JOIN "file_assets" asset ON asset."id" = report."assetId"
    WHERE draft."sceneType" = $1 AND evaluation."status" = 'PUBLISHED'
      AND evaluation."reviewedById" IS NOT NULL AND report."status" = 'FINAL' AND asset."status" = 'AVAILABLE'
    ORDER BY evaluation."publishedAt" DESC NULLS LAST
    LIMIT 1
  `, [sceneType])
  return result.rows[0] ?? null
}

async function reportState(database, projectId) {
  const result = await database.query(`
    SELECT report."assetId", report."format", report."contentHash",
      count(asset."id")::integer AS "availableAssetCount"
    FROM "show_project_reports" report
    LEFT JOIN "file_assets" asset ON asset."ownerId" = report."projectId"
      AND asset."category" = 'FINAL_REPORT' AND asset."status" = 'AVAILABLE'
    WHERE report."projectId" = $1
    GROUP BY report."assetId", report."format", report."contentHash"
  `, [projectId])
  if (!result.rows[0]) throw new Error("候选项目缺少最终报告状态")
  return result.rows[0]
}

async function waitForJob(database, eventId, maximumWaitMs) {
  const deadline = Date.now() + maximumWaitMs
  while (Date.now() < deadline) {
    const result = await database.query(`
      SELECT job."id", job."status", job."attempts", job."result", job."lastError",
        event."status" AS "outboxStatus"
      FROM "outbox_events" event
      LEFT JOIN "jobs" job ON job."sourceOutboxEventId" = event."id"
      WHERE event."id" = $1
    `, [eventId])
    const value = result.rows[0]
    if (value?.status === "SUCCEEDED" || value?.status === "DEAD_LETTER") return value
    await delay(250)
  }
  throw new Error(`Worker 在 ${maximumWaitMs}ms 内未完成作业`)
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function positiveInteger(value, fallback) {
  const result = Number(value ?? fallback)
  return Number.isInteger(result) && result > 0 ? result : fallback
}

function delay(milliseconds) { return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)) }
function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") }

function normalizeScene(value) {
  const normalized = String(value).trim().toUpperCase()
  if (normalized !== "CITY_SHOW" && normalized !== "VTOL_INSPECTION") throw new Error(`不支持的验收场景：${value}`)
  return normalized
}
