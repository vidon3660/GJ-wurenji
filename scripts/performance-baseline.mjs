import { performance } from "node:perf_hooks"
import { cpus, freemem, hostname, platform, release, totalmem } from "node:os"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
  computeLogisticsRuntimeProjection,
  computeShowRuntimeProjection,
  generateLogisticsOrders
} from "@wurenji/simulation"

const outputPath = resolve(argument("output") ?? `artifacts/performance/baseline-${timestamp()}.json`)
const showIterations = positiveInteger(process.env.PERF_SHOW_ITERATIONS, 1000)
const logisticsIterations = positiveInteger(process.env.PERF_LOGISTICS_ITERATIONS, 500)
const apiRequests = positiveInteger(process.env.PERF_API_REQUESTS, 100)
const apiConcurrency = positiveInteger(process.env.PERF_API_CONCURRENCY, 20)
const skipApi = process.env.PERF_SKIP_API === "true"
const baseUrl = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "")
const origin = process.env.WEB_ORIGIN?.split(",")[0]?.trim() || baseUrl

const memoryBefore = process.memoryUsage().heapUsed
const show = benchmarkShow(showIterations)
const logistics = benchmarkLogistics(logisticsIterations)
const api = skipApi ? skippedApiResult(apiRequests, apiConcurrency) : await benchmarkApi(apiRequests, apiConcurrency)
const memoryAfter = process.memoryUsage().heapUsed
const report = {
  format: "wurenji-performance-baseline",
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: {
    hostname: hostname(), platform: platform(), release: release(), node: process.version,
    cpuModel: cpus()[0]?.model ?? "unknown", cpuCount: cpus().length,
    totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), baseUrl
  },
  configuration: { showIterations, logisticsIterations, apiRequests, apiConcurrency },
  memory: { heapBeforeBytes: memoryBefore, heapAfterBytes: memoryAfter, heapDeltaBytes: memoryAfter - memoryBefore },
  results: { show, logistics, api },
  thresholds: {
    showP95Ms: { target: 20, passed: show.p95Ms <= 20 },
    logisticsP95Ms: { target: 50, passed: logistics.p95Ms <= 50 },
    apiP95Ms: { target: 1000, passed: skipApi ? true : api.p95Ms <= 1000, skipped: skipApi },
    apiErrorRate: { target: 0, passed: skipApi ? true : api.errorRate === 0, skipped: skipApi }
  }
}
const requiredThresholds = Object.entries(report.thresholds).filter(([, item]) => !item.skipped)
report.summary = {
  passed: requiredThresholds.every(([, item]) => item.passed),
  complete: !skipApi && requiredThresholds.every(([, item]) => item.passed),
  partial: skipApi,
  failedThresholds: requiredThresholds.filter(([, item]) => !item.passed).map(([name]) => name)
}
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify({ summary: report.summary, showP95Ms: show.p95Ms, logisticsP95Ms: logistics.p95Ms, apiP95Ms: api.p95Ms, apiErrorRate: api.errorRate, apiSkipped: skipApi })}\nReport ${outputPath}\n`)
if (!report.summary.passed) process.exitCode = 1

function benchmarkShow(iterations) {
  const config = { totalAircraft: 3000, groupCount: 30, durationMs: 600_000, maximumHeightMeters: 120, performanceCenter: { longitude: 114.0579, latitude: 22.5431 }, performanceRadiusMeters: 260 }
  const samples = []
  let outputBytes = 0
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now()
    const result = computeShowRuntimeProjection(config, index % 600_001, { aborted: false, earlyLandedCount: 0, takeoffLimitCount: null, eventImpacts: index % 5 === 0 ? [{ category: "COMMUNICATION_CONTROL", severity: "ERROR", affectedCount: 80, affectedGroupIds: ["G01"] }] : [] })
    samples.push(performance.now() - startedAt)
    if (index === 0) outputBytes = Buffer.byteLength(JSON.stringify(result))
    if (result.groups.length !== 30 || result.groups.reduce((sum, item) => sum + item.plannedCount, 0) !== 3000) throw new Error("3000 架聚合投影结果无效")
  }
  return summarize(samples, { totalAircraft: 3000, groups: 30, outputBytes })
}

function benchmarkLogistics(iterations) {
  const fixture = logisticsFixture()
  const samples = []
  let outputBytes = 0
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now()
    const result = computeLogisticsRuntimeProjection({ ...fixture, simulationTimeMs: (index * 1379) % 1_200_000, sessionStatus: "RUNNING", totalAircraft: 50, control: index % 5 === 0 ? fixture.eventControl : undefined })
    samples.push(performance.now() - startedAt)
    if (index === 0) outputBytes = Buffer.byteLength(JSON.stringify(result))
    if (result.aircraft.length !== 50 || result.orders.length !== 100 || result.tasks.length !== 100) throw new Error("50 架/100 单物流投影结果无效")
  }
  return summarize(samples, { totalAircraft: 50, orders: 100, tasks: 100, routes: fixture.routes.length, outputBytes })
}

async function benchmarkApi(total, concurrency) {
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: process.env.PERF_STUDENT_EMAIL ?? "student@demo.local", password: process.env.PERF_STUDENT_PASSWORD ?? process.env.DEMO_STUDENT_PASSWORD ?? "" }) })
  if (!login.ok) throw new Error(`性能基线登录失败：${login.status}`)
  const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0]
  const samples = []
  let errors = 0
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (true) {
      const index = next++
      if (index >= total) return
      const startedAt = performance.now()
      try {
        const response = await fetch(`${baseUrl}/api/v3/my-projects`, { headers: { Cookie: cookie } })
        await response.arrayBuffer()
        if (!response.ok) errors += 1
      } catch {
        errors += 1
      } finally {
        samples.push(performance.now() - startedAt)
      }
    }
  })
  await Promise.all(workers)
  return summarize(samples, { requests: total, concurrency, errors, errorRate: errors / total })
}

function skippedApiResult(total, concurrency) {
  return { skipped: true, requests: total, concurrency, errors: null, errorRate: null, iterations: 0, averageMs: null, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null, throughputPerSecond: null }
}

function logisticsFixture() {
  const destinationIds = Array.from({ length: 12 }, (_, index) => `delivery-${index + 1}`)
  const orders = generateLogisticsOrders({ orderCount: 100, releaseMode: "STAGED", priorityProfile: "BALANCED", timeWindowMinutes: 180, seed: "performance-50-100", initialUnavailableAircraftCount: 0, initialLowBatteryAircraftCount: 0 }, destinationIds)
    .map((order, index) => ({ ...order, id: `order-${index + 1}`, status: "SCHEDULED" }))
  const aircraft = Array.from({ length: 50 }, (_, index) => ({ id: `aircraft-${index + 1}`, code: `UAV-${String(index + 1).padStart(3, "0")}`, modelCode: "LOGISTICS-STD", initialBatteryPercent: 95 + index % 6, availableAtMs: 0, status: "READY" }))
  const routes = destinationIds.flatMap((destinationId, index) => [
    route(`route-${index + 1}-out`, destinationId, "OUTBOUND", 114.05 + index * 0.001, 22.54 + index * 0.0005),
    route(`route-${index + 1}-return`, destinationId, "RETURN", 114.05 + index * 0.001, 22.54 + index * 0.0005)
  ])
  const scheduleItems = orders.map((order, index) => {
    const aircraftItem = aircraft[index % aircraft.length]
    const destinationIndex = destinationIds.indexOf(order.destinationNodeId)
    const takeoff = Math.floor(index / aircraft.length) * 360_000 + (index % aircraft.length) * 2_000
    return { id: `task-${index + 1}`, orderId: order.id, aircraftId: aircraftItem.id, outboundRouteId: `route-${destinationIndex + 1}-out`, returnRouteId: `route-${destinationIndex + 1}-return`, plannedTakeoffTimeMs: takeoff, orderCode: `ORD-${String(index + 1).padStart(3, "0")}`, aircraftCode: aircraftItem.code, destinationNodeId: order.destinationNodeId, arrivalTimeMs: takeoff + 90_000, returnStartTimeMs: takeoff + 120_000, landingTimeMs: takeoff + 210_000, nextAvailableTimeMs: takeoff + 240_000, batteryAfterMissionPercent: 60 }
  })
  return {
    orders, aircraft, routes, scheduleItems,
    eventControl: { eventImpacts: [{ eventId: "event-weather", category: "WEATHER_ENVIRONMENT", severity: "WARNING", affectedAircraftIds: aircraft.slice(0, 10).map((item) => item.id), affectedOrderIds: orders.slice(0, 20).map((item) => item.id), affectedRouteIds: routes.slice(0, 4).map((item) => item.id) }], delayOffsetsMs: Object.fromEntries(scheduleItems.slice(0, 20).map((item) => [item.id, 30_000])) }
  }
}

function route(id, destinationNodeId, direction, longitude, latitude) {
  const start = { longitude: 114.04, latitude: 22.53 }
  const destination = { longitude, latitude }
  const positions = direction === "OUTBOUND" ? [start, destination] : [destination, start]
  return { id, versionId: "performance-version", versionNo: 1, distanceMeters: 1500, flightTimeMs: 90_000, batteryConsumptionPercent: 18, route: { id, name: id, destinationNodeId, direction, role: "PRIMARY", groupCode: "G1", departureNodeId: direction === "OUTBOUND" ? "airport" : destinationNodeId, arrivalNodeId: direction === "OUTBOUND" ? destinationNodeId : "airport", protectionRadiusMeters: 30, waitingNodeIds: [], alternateLandingNodeIds: [], emergencyAreaNodeIds: [], entryDirectionDegrees: null, exitDirectionDegrees: null, waypoints: positions.map((position, index) => ({ id: `${id}-${index}`, name: `${id}-${index}`, position, altitudeMeters: index === 0 ? 0 : 80, segmentAltitudeMeters: 80, speedMps: 15, nodeId: null, locked: true })) } }
}

function summarize(samples, details) {
  const sorted = [...samples].sort((left, right) => left - right)
  const total = samples.reduce((sum, value) => sum + value, 0)
  return { ...details, iterations: samples.length, averageMs: round(total / samples.length), p50Ms: round(percentile(sorted, 0.5)), p95Ms: round(percentile(sorted, 0.95)), p99Ms: round(percentile(sorted, 0.99)), maxMs: round(sorted.at(-1) ?? 0), throughputPerSecond: round(samples.length / Math.max(total / 1000, 0.001)) }
}

function percentile(sorted, ratio) { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0 }
function round(value) { return Math.round(value * 1000) / 1000 }
function positiveInteger(value, fallback) { const parsed = Number(value ?? fallback); if (!Number.isInteger(parsed) || parsed < 1) throw new Error("性能迭代参数必须为正整数"); return parsed }
function argument(name) { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : undefined }
function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") }
