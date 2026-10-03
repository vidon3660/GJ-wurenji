import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { cpus, hostname, platform, release, totalmem } from "node:os"
import { dirname, resolve } from "node:path"
import { chromium } from "playwright-core"

const baseUrl = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "").replace(/\/api$/i, "")
const origin = process.env.WEB_ORIGIN?.split(",")[0]?.trim() || baseUrl
const durationMs = positiveInteger(process.env.BROWSER_STATIC_DURATION_MS, 120_000)
const heartbeatIntervalMs = positiveInteger(process.env.BROWSER_STATIC_HEARTBEAT_INTERVAL_MS, 5_000)
const heapSnapshotEnabled = process.env.BROWSER_STATIC_HEAP_SNAPSHOT === "true"
const heapSnapshotDirectory = resolve(process.env.BROWSER_STATIC_HEAP_SNAPSHOT_DIR ?? "artifacts/performance/heap-snapshots")
const outputPath = resolve(process.env.BROWSER_STATIC_OUTPUT?.trim() ?? `artifacts/performance/browser-static-${timestamp()}.json`)
const browserPath = browserExecutable()
const browser = await chromium.launch({
  executablePath: browserPath,
  headless: process.env.HEADLESS !== "false",
  args: ["--enable-precise-memory-info", "--ignore-gpu-blocklist"]
})

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const pageErrors = []
  const consoleErrors = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })

  const login = await context.request.post(`${baseUrl}/api/auth/login`, {
    headers: { Origin: origin },
    data: {
      email: process.env.RUNTIME_STUDENT_EMAIL ?? "student@demo.local",
      password: process.env.RUNTIME_STUDENT_PASSWORD ?? process.env.DEMO_STUDENT_PASSWORD ?? ""
    }
  })
  if (!login.ok()) throw new Error(`学生登录失败：${login.status()} ${await login.text()}`)

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" })
  await page.locator(".platform-shell").waitFor({ timeout: 30_000 })
  const skip = page.getByRole("button", { name: "跳过引导", exact: true })
  if (await skip.count() && await skip.first().isVisible()) await skip.first().click()
  await page.waitForTimeout(1_000)

  const cdp = await context.newCDPSession(page)
  await cdp.send("Performance.enable")
  await cdp.send("HeapProfiler.enable")
  const heapSnapshots = {}
  if (heapSnapshotEnabled) heapSnapshots.before = await takeHeapSnapshot(cdp, resolve(heapSnapshotDirectory, "static-before.heapsnapshot"))
  await cdp.send("HeapProfiler.collectGarbage")
  const before = await cdp.send("Runtime.getHeapUsage")
  const startedAt = Date.now()
  const samples = []
  while (Date.now() - startedAt < durationMs) {
    await sleep(Math.min(heartbeatIntervalMs, durationMs - (Date.now() - startedAt)))
    await cdp.send("HeapProfiler.collectGarbage")
    const heap = await cdp.send("Runtime.getHeapUsage")
    samples.push({ elapsedMs: Date.now() - startedAt, usedSize: heap.usedSize, totalSize: heap.totalSize })
  }
  await cdp.send("HeapProfiler.collectGarbage")
  const after = await cdp.send("Runtime.getHeapUsage")
  if (heapSnapshotEnabled) heapSnapshots.after = await takeHeapSnapshot(cdp, resolve(heapSnapshotDirectory, "static-after.heapsnapshot"))
  const state = await page.evaluate(() => ({
    platformShell: Boolean(document.querySelector(".platform-shell")),
    runtimeWorkspaceCount: document.querySelectorAll(".show-runtime-workspace, .logistics-runtime-workspace, .vtl-runtime-workspace").length,
    canvasCount: document.querySelectorAll("canvas").length,
    domNodeCount: document.getElementsByTagName("*").length
  }))
  const peakUsedSize = Math.max(before.usedSize, after.usedSize, ...samples.map((sample) => sample.usedSize))
  const report = {
    format: "wurenji-browser-static-baseline",
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      hostname: hostname(), platform: platform(), release: release(), cpuModel: cpus()[0]?.model ?? "unknown",
      cpuCount: cpus().length, totalMemoryBytes: totalmem(), browser: browser.version(), executablePath: browserPath,
      baseUrl, viewport: { width: 1440, height: 900, deviceScaleFactor: 1 }
    },
    configuration: { durationMs, heartbeatIntervalMs },
    heapSnapshots,
    state,
    browserMemory: {
      before, after, peakUsedSize,
      deltaUsedSize: after.usedSize - before.usedSize,
      peakGrowthBytes: peakUsedSize - before.usedSize,
      samples
    },
    errors: { page: pageErrors, console: consoleErrors },
    checks: {
      sampledDuration: samples.at(-1)?.elapsedMs >= durationMs * 0.95,
      platformShellVisible: state.platformShell,
      noRuntimeWorkspaceMounted: state.runtimeWorkspaceCount === 0,
      noPageErrors: pageErrors.length === 0,
      noConsoleErrors: consoleErrors.length === 0
    }
  }
  report.summary = { passed: Object.values(report.checks).every(Boolean), peakGrowthBytes: report.browserMemory.peakGrowthBytes }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  process.stdout.write(`${JSON.stringify(report.summary)}\nReport ${outputPath}\n`)
  if (!report.summary.passed) process.exitCode = 1
  await context.close()
} finally {
  await browser.close()
}

function browserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome", "/usr/bin/chromium"
  ].filter(Boolean)
  const selected = candidates.find((candidate) => existsSync(candidate))
  if (!selected) throw new Error("未找到 Chrome 或 Edge；可通过 CHROME_PATH 指定浏览器路径")
  return selected
}

function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("采样时长必须为正整数")
  return parsed
}

function sleep(duration) { return new Promise((resolveSleep) => setTimeout(resolveSleep, duration)) }
function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") }

async function takeHeapSnapshot(cdp, path) {
  await mkdir(dirname(path), { recursive: true })
  const chunks = []
  const onChunk = ({ chunk }) => chunks.push(chunk)
  cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk)
  try {
    await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false })
  } finally {
    cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk)
  }
  await writeFile(path, chunks.join(""), "utf8")
  return path
}
