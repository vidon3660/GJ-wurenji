import assert from "node:assert/strict"
import test from "node:test"
import { browserLongRunQualification, browserScaleQualification, classConcurrencyFormalQualification } from "./delivery-qualification.mjs"

test("class concurrency remains pending below the formal student count", () => {
  const result = classConcurrencyFormalQualification({ summary: { failed: 0, functionalPassed: true }, configuration: { studentCount: 2, rounds: 30 }, load: { latency: { p95Ms: 200 } } })
  assert.equal(result.status, "PENDING")
})

test("environment-blocked class concurrency remains pending", () => {
  const result = classConcurrencyFormalQualification({ status: "BLOCKED", reason: "fetch failed", summary: { failed: 0, functionalPassed: false } })
  assert.equal(result.status, "PENDING")
})

test("class concurrency passes only when scale, rounds and latency qualify", () => {
  const result = classConcurrencyFormalQualification({ summary: { failed: 0, functionalPassed: true }, configuration: { studentCount: 30, rounds: 20 }, load: { latency: { p95Ms: 450 } } })
  assert.equal(result.status, "PASS")
})

test("browser long run does not promote a short formal-scale sample", () => {
  const value = { results: [{ sceneType: "CITY_SHOW", scale: { qualified: true, consistent: true, actual: { aircraft: 3000 } }, rendering: { durationMs: 60_000 }, checks: { functionalPassed: true, streamStayedLive: true, memoryGrowthWithinLimit: true }, browserMemory: { peakGrowthBytes: 1024 } }] }
  assert.equal(browserLongRunQualification(value, "CITY_SHOW").status, "PENDING")
})

test("browser long run passes sustained formal-scale evidence", () => {
  const value = { results: [{ sceneType: "CITY_LOGISTICS", scale: { qualified: true, consistent: true, actual: { aircraft: 50, orders: 100 } }, rendering: { durationMs: 30 * 60_000 }, checks: { functionalPassed: true, streamStayedLive: true, memoryGrowthWithinLimit: true }, browserMemory: { peakGrowthBytes: 64 * 1024 * 1024 } }] }
  assert.equal(browserLongRunQualification(value, "CITY_LOGISTICS").status, "PASS")
})

test("VTL long run uses the same formal duration and scale gate", () => {
  const value = { results: [{ sceneType: "VTOL_INSPECTION", scale: { qualified: true, consistent: true, actual: { aircraft: 20 } }, rendering: { durationMs: 30 * 60_000 }, checks: { functionalPassed: true, streamStayedLive: true, memoryGrowthWithinLimit: true }, browserMemory: { peakGrowthBytes: 32 * 1024 * 1024 } }] }
  assert.equal(browserLongRunQualification(value, "VTOL_INSPECTION").status, "PASS")
})

test("declared qualification cannot hide the wrong observed scale", () => {
  const value = { results: [{ sceneType: "CITY_SHOW", scale: { qualified: true, consistent: true, actual: { aircraft: 2999 } }, checks: { functionalPassed: true } }] }
  assert.equal(browserScaleQualification(value, "CITY_SHOW").status, "PENDING")
})
