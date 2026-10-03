import { cpus, freemem, hostname, platform, release, totalmem } from "node:os"
import { performance } from "node:perf_hooks"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { computeLogisticsRuntimeProjection, generateLogisticsOrders } from "@wurenji/simulation"

const aircraftCount = positiveInteger(process.env.LOGISTICS_PERF_AIRCRAFT, 50)
const orderCount = positiveInteger(process.env.LOGISTICS_PERF_ORDERS, 100)
const durationMs = positiveInteger(process.env.LOGISTICS_PERF_DURATION_MS, 30 * 60 * 1_000)
const tickIntervalMs = positiveInteger(process.env.LOGISTICS_PERF_TICK_INTERVAL_MS, 1_000)
const p95LimitMs = positiveNumber(process.env.LOGISTICS_PERF_P95_LIMIT_MS, 50)
const peakHeapGrowthLimitBytes = positiveInteger(process.env.LOGISTICS_PERF_HEAP_LIMIT_BYTES, 256 * 1024 * 1024)
const outputPath = resolve(process.env.LOGISTICS_PERF_OUTPUT ?? "artifacts/performance/logistics-50-100-baseline.json")

const fixture = logisticsFixture(aircraftCount, orderCount)
const control = {
  eventImpacts: [{
    eventId: "performance-weather",
    category: "WEATHER_ENVIRONMENT",
    severity: "WARNING",
    affectedAircraftIds: fixture.aircraft.slice(0, Math.min(10, aircraftCount)).map((item) => item.id),
    affectedOrderIds: fixture.orders.slice(0, Math.min(20, orderCount)).map((item) => item.id),
    affectedRouteIds: fixture.routes.slice(0, 4).map((item) => item.id)
  }],
  delayOffsetsMs: Object.fromEntries(fixture.scheduleItems.slice(0, Math.min(20, orderCount)).map((item) => [item.id, 30_000]))
}
const expectedTicks = Math.floor(durationMs / tickIntervalMs) + 1
const beforeMemory = process.memoryUsage()
const beforeCpu = process.cpuUsage()
const samples = []
let peakHeapBytes = beforeMemory.heapUsed
let peakRssBytes = beforeMemory.rss
let projectionBytes = 0
let integrityPassed = true
let finalProjection = null
const startedAt = performance.now()

for (let tick = 0; tick < expectedTicks; tick += 1) {
  const simulationTimeMs = Math.min(durationMs, tick * tickIntervalMs)
  const tickStartedAt = performance.now()
  const projection = computeLogisticsRuntimeProjection({
    simulationTimeMs,
    sessionStatus: simulationTimeMs >= durationMs ? "COMPLETED" : "RUNNING",
    totalAircraft: aircraftCount,
    orders: fixture.orders,
    aircraft: fixture.aircraft,
    routes: fixture.routes,
    scheduleItems: fixture.scheduleItems,
    initialEnvironment: fixture.initialEnvironment,
    control
  })
  const elapsedMs = performance.now() - tickStartedAt
  samples.push(elapsedMs)
  finalProjection = projection
  if (tick === 0) projectionBytes = Buffer.byteLength(JSON.stringify(projection))
  const memory = process.memoryUsage()
  peakHeapBytes = Math.max(peakHeapBytes, memory.heapUsed)
  peakRssBytes = Math.max(peakRssBytes, memory.rss)
  integrityPassed = integrityPassed
    && projection.aircraft.length === aircraftCount
    && projection.orders.length === orderCount
    && projection.tasks.length === orderCount
    && projection.aircraft.every((item) => Number.isFinite(item.position.longitude) && Number.isFinite(item.position.latitude) && Number.isFinite(item.batteryPercent))
    && projection.tasks.every((item) => item.aircraftId && item.orderId && Number.isFinite(item.plannedTakeoffTimeMs))
}

const afterMemory = process.memoryUsage()
const cpu = process.cpuUsage(beforeCpu)
const elapsedMs = performance.now() - startedAt
const sortedSamples = [...samples].sort((left, right) => left - right)
const peakHeapGrowthBytes = Math.max(0, peakHeapBytes - beforeMemory.heapUsed)
const peakRssGrowthBytes = Math.max(0, peakRssBytes - beforeMemory.rss)
const scaleExact = aircraftCount === 50 && orderCount === 100 && fixture.aircraft.length === 50 && fixture.orders.length === 100 && fixture.scheduleItems.length === 100
const longRunQualified = durationMs >= 30 * 60 * 1_000 && samples.length === expectedTicks
const performanceQualified = percentile(sortedSamples, 0.95) <= p95LimitMs
const resourceQualified = peakHeapGrowthBytes <= peakHeapGrowthLimitBytes
const report = {
  format: "wurenji-logistics-performance-baseline",
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: {
    hostname: hostname(),
    platform: platform(),
    release: release(),
    node: process.version,
    cpuModel: cpus()[0]?.model ?? "unknown",
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem()
  },
  configuration: { aircraftCount, orderCount, durationMs, tickIntervalMs, expectedTicks, p95LimitMs, peakHeapGrowthLimitBytes },
  scale: { aircraft: fixture.aircraft.length, orders: fixture.orders.length, tasks: fixture.scheduleItems.length, routes: fixture.routes.length, projectionBytes },
  runtime: {
    elapsedMs: round(elapsedMs),
    ticks: samples.length,
    averageTickMs: round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
    p50TickMs: round(percentile(sortedSamples, 0.5)),
    p95TickMs: round(percentile(sortedSamples, 0.95)),
    p99TickMs: round(percentile(sortedSamples, 0.99)),
    maxTickMs: round(sortedSamples.at(-1) ?? 0),
    ticksPerSecond: round(samples.length / Math.max(elapsedMs / 1_000, 0.001)),
    finalAvailableAircraft: finalProjection?.summary.availableAircraft ?? 0,
    finalCompletedOrders: finalProjection?.summary.completedOrders ?? 0
  },
  resources: {
    heapBeforeBytes: beforeMemory.heapUsed,
    heapAfterBytes: afterMemory.heapUsed,
    heapDeltaBytes: afterMemory.heapUsed - beforeMemory.heapUsed,
    peakHeapBytes,
    peakHeapGrowthBytes,
    rssBeforeBytes: beforeMemory.rss,
    rssAfterBytes: afterMemory.rss,
    peakRssBytes,
    peakRssGrowthBytes,
    cpuUserMs: round(cpu.user / 1_000),
    cpuSystemMs: round(cpu.system / 1_000),
    gcExposed: typeof global.gc === "function"
  },
  checks: {
    scaleExact,
    longRunQualified,
    integrityPassed,
    performanceQualified,
    resourceQualified
  }
}
report.summary = {
  passed: Object.values(report.checks).every(Boolean),
  failedChecks: Object.entries(report.checks).filter(([, passed]) => !passed).map(([name]) => name)
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify({ summary: report.summary, p95TickMs: report.runtime.p95TickMs, peakHeapGrowthBytes: report.resources.peakHeapGrowthBytes, outputPath }, null, 2)}\n`)
if (!report.summary.passed) process.exitCode = 1

function logisticsFixture(aircraftTotal, orderTotal) {
  const destinationIds = Array.from({ length: 12 }, (_, index) => `delivery-${index + 1}`)
  const orders = generateLogisticsOrders({ orderCount: orderTotal, releaseMode: "STAGED", priorityProfile: "BALANCED", timeWindowMinutes: 180, seed: "performance-50-100" }, destinationIds)
    .map((order, index) => ({ ...order, id: `order-${index + 1}`, status: "SCHEDULED" }))
  const aircraft = Array.from({ length: aircraftTotal }, (_, index) => ({ id: `aircraft-${index + 1}`, code: `UAV-${String(index + 1).padStart(3, "0")}`, modelCode: "LOGISTICS-STD", initialBatteryPercent: 95 + index % 6, availableAtMs: 0, status: "READY" }))
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
    orders,
    aircraft,
    routes,
    scheduleItems,
    initialEnvironment: { windDirection: "SW", windForceState: "NORMAL", gustState: "NONE", rainState: "NONE", positioningState: "NORMAL", communicationState: "NORMAL" }
  }
}

function route(id, destinationNodeId, direction, longitude, latitude) {
  const start = { longitude: 114.04, latitude: 22.53 }
  const destination = { longitude, latitude }
  const positions = direction === "OUTBOUND" ? [start, destination] : [destination, start]
  return { id, versionId: "performance-version", versionNo: 1, distanceMeters: 1500, flightTimeMs: 90_000, batteryConsumptionPercent: 18, route: { id, name: id, destinationNodeId, direction, role: "PRIMARY", groupCode: "G1", departureNodeId: direction === "OUTBOUND" ? "airport" : destinationNodeId, arrivalNodeId: direction === "OUTBOUND" ? destinationNodeId : "airport", protectionRadiusMeters: 30, waitingNodeIds: [], alternateLandingNodeIds: [], emergencyAreaNodeIds: [], entryDirectionDegrees: null, exitDirectionDegrees: null, waypoints: positions.map((position, index) => ({ id: `${id}-${index}`, name: `${id}-${index}`, position, altitudeMeters: index === 0 ? 0 : 80, segmentAltitudeMeters: 80, speedMps: 15, nodeId: null, locked: true })) } }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("性能参数必须为正整数")
  return parsed
}

function positiveNumber(value, fallback) {
  const parsed = Number(value ?? fallback)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("性能阈值必须为正数")
  return parsed
}

function percentile(sorted, ratio) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0
}

function round(value) {
  return Math.round(value * 1_000) / 1_000
}
