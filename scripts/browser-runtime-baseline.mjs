import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { cpus, hostname, platform, release, totalmem } from "node:os"
import { dirname, resolve } from "node:path"
import { chromium } from "playwright-core"

const configuredBaseUrl = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "")
const baseUrl = configuredBaseUrl.replace(/\/api$/i, "")
const origin = process.env.WEB_ORIGIN?.split(",")[0]?.trim() || baseUrl
const durationMs = positiveInteger(process.env.BROWSER_PERF_DURATION_MS, 10_000)
const warmupMs = positiveInteger(process.env.BROWSER_PERF_WARMUP_MS, 1_500)
const heartbeatIntervalMs = positiveInteger(process.env.BROWSER_PERF_HEARTBEAT_INTERVAL_MS, 5_000)
const minimumFps = positiveNumber(process.env.BROWSER_PERF_MIN_FPS, 30)
const maximumHeapGrowthBytes = positiveNumber(process.env.BROWSER_PERF_MAX_HEAP_GROWTH_MB, 256) * 1024 * 1024
const formalMinimumDurationMs = positiveInteger(process.env.BROWSER_PERF_FORMAL_MIN_DURATION_MS, 30 * 60 * 1_000)
const requireFormalScale = process.env.BROWSER_PERF_REQUIRE_FORMAL_SCALE === "true"
const requireLongRun = process.env.BROWSER_PERF_REQUIRE_LONG_RUN === "true"
const requireRunningSession = process.env.BROWSER_PERF_REQUIRE_RUNNING_SESSION === "true"
const disableMapForDiagnostics = process.env.BROWSER_PERF_DISABLE_MAP === "true"
const disableStreamForDiagnostics = process.env.BROWSER_PERF_DISABLE_STREAM === "true"
const heapSnapshotEnabled = process.env.BROWSER_PERF_HEAP_SNAPSHOT === "true"
const heapSnapshotDirectory = resolve(process.env.BROWSER_PERF_HEAP_SNAPSHOT_DIR ?? "artifacts/performance/heap-snapshots")
const targetLabel = process.env.BROWSER_PERF_TARGET_LABEL?.trim() || process.env.ACCEPTANCE_TARGET_LABEL?.trim() || "local-docker"
const outputPath = resolve(argument("output") ?? process.env.BROWSER_PERF_OUTPUT?.trim() ?? `artifacts/performance/browser-runtime-${timestamp()}.json`)
const screenshotDirectory = resolve(process.env.BROWSER_PERF_SCREENSHOT_DIR ?? dirname(outputPath))
const requestedScene = process.env.RUNTIME_SCENE?.trim() || "ALL"
const projectIdOverride = process.env.RUNTIME_PROJECT_ID?.trim() || ""
const executablePath = browserExecutable()
const sceneDefinitions = {
  CITY_SHOW: {
    stageCode: "SHOW_RUNTIME",
    stageLabel: "表演运行",
    workspaceSelector: ".show-runtime-workspace",
    streamSelector: ".runtime-stream-status.live",
    workspacePath: (projectId) => `/api/v3/show-projects/${projectId}/runtime`
  },
  CITY_LOGISTICS: {
    homeTab: "物流",
    stageCode: "LOGISTICS_DELIVERY_RUNTIME",
    stageLabel: "配送运行",
    workspaceSelector: ".logistics-runtime-workspace",
    streamSelector: ".runtime-stream-status.live",
    workspacePath: (projectId) => `/api/v3/logistics-projects/${projectId}/runtime-workspace`
  },
  VTOL_INSPECTION: {
    homeTab: "巡检",
    stageCode: "VTL_RUNTIME",
    stageLabel: "巡检运行",
    workspaceSelector: ".vtl-runtime-workspace",
    streamSelector: ".stream-state.live",
    workspacePath: (projectId) => `/api/v3/vtl-projects/${projectId}/runtime`
  }
}
const scenes = requestedScene === "ALL" ? Object.keys(sceneDefinitions) : [requestedScene]

const browser = await chromium.launch({
  executablePath,
  headless: process.env.HEADLESS !== "false",
  args: ["--enable-precise-memory-info", "--ignore-gpu-blocklist"]
})
const results = []

try {
  await mkdir(screenshotDirectory, { recursive: true })
  for (const sceneType of scenes) results.push(await measureScene(sceneType))
} finally {
  await browser.close()
}

const report = {
  format: "wurenji-browser-runtime-baseline",
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: {
    targetLabel,
    hostname: hostname(),
    platform: platform(),
    release: release(),
    cpuModel: cpus()[0]?.model ?? "unknown",
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    browser: await browserVersion(executablePath),
    executablePath,
    baseUrl,
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 }
  },
  configuration: {
    durationMs,
    warmupMs,
    heartbeatIntervalMs,
    minimumFps,
    maximumHeapGrowthBytes,
    formalMinimumDurationMs,
    requireFormalScale,
    requireLongRun,
    requireRunningSession,
    heapSnapshotEnabled,
    heapSnapshotDirectory: heapSnapshotEnabled ? heapSnapshotDirectory : null,
    requestedScene,
    projectIdOverride: projectIdOverride || null
  },
  results
}
report.summary = {
  passed: results.length > 0 && results.every((item) => item.checks.functionalPassed),
  formalScalePassed: results.length > 0 && results.every((item) => item.checks.formalScaleQualified),
  longRunPassed: results.length > 0 && results.every((item) => item.checks.longRunQualified),
  formalAcceptancePassed: results.length > 0 && results.every((item) => item.checks.formalAcceptancePassed),
  failedScenes: results.filter((item) => !item.checks.functionalPassed).map((item) => item.sceneType),
  scaleGaps: results.filter((item) => !item.checks.formalScaleQualified).map((item) => ({ sceneType: item.sceneType, actual: item.scale.actual, required: item.scale.required })),
  longRunGaps: results.filter((item) => !item.checks.longRunQualified).map((item) => ({
    sceneType: item.sceneType,
    durationMs: item.rendering.durationMs,
    requiredDurationMs: formalMinimumDurationMs,
    streamStayedLive: item.checks.streamStayedLive,
    memoryGrowthWithinLimit: item.checks.memoryGrowthWithinLimit,
    runningSessionQualified: item.checks.runningSessionQualified
  }))
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify(report.summary)}\nReport ${outputPath}\n`)
if (!report.summary.passed || (requireFormalScale && !report.summary.formalScalePassed) || (requireLongRun && !report.summary.longRunPassed)) process.exitCode = 1

async function measureScene(sceneType) {
  const scene = sceneDefinitions[sceneType]
  if (!scene) throw new Error(`不支持的运行场景：${sceneType}`)
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const pageErrors = []
  const consoleErrors = []
  const failedRequests = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("requestfailed", (request) => {
    failedRequests.push({ method: request.method(), url: request.url(), errorText: request.failure()?.errorText ?? "unknown" })
  })

  try {
    const login = await context.request.post(`${baseUrl}/api/auth/login`, {
      headers: { Origin: origin },
      data: {
        email: process.env.RUNTIME_STUDENT_EMAIL ?? "student@demo.local",
        password: process.env.RUNTIME_STUDENT_PASSWORD ?? process.env.DEMO_STUDENT_PASSWORD ?? ""
      }
    })
    if (!login.ok()) throw new Error(`学生登录失败：${login.status()} ${await login.text()}`)

    const projectsPath = projectIdOverride ? "/api/v3/my-projects?includeInternalData=true" : "/api/v3/my-projects"
    const projectsResponse = await context.request.get(`${baseUrl}${projectsPath}`)
    if (!projectsResponse.ok()) throw new Error(`读取学生项目失败：${projectsResponse.status()}`)
    const projects = await projectsResponse.json()
    const project = selectProject(projects, sceneType)
    if (!project) throw new Error(`${sceneType} 没有可访问的已运行项目，请设置 RUNTIME_PROJECT_ID`)

    const workspacePath = scene.workspacePath(project.id)
    const workspaceResponse = await context.request.get(`${baseUrl}${workspacePath}`)
    if (!workspaceResponse.ok()) throw new Error(`读取运行工作台失败：${workspaceResponse.status()} ${await workspaceResponse.text()}`)
    let workspace = await workspaceResponse.json()
    if (workspace.session?.status === "PAUSED") {
      const controlPath = sceneType === "CITY_SHOW"
        ? `/api/v3/show-projects/${project.id}/runtime/clock-rate`
        : sceneType === "CITY_LOGISTICS"
          ? `/api/v3/logistics-projects/${project.id}/runtime/clock-rate`
          : `/api/v3/vtl-projects/${project.id}/runtime/clock-rate`
      const resumeResponse = await context.request.post(`${baseUrl}${controlPath}`, {
        headers: { Origin: origin },
        data: { expectedRevision: workspace.session.revision, rate: workspace.clockRate, status: "RUNNING" }
      })
      if (!resumeResponse.ok()) throw new Error(`恢复运行夹具失败：${resumeResponse.status()} ${await resumeResponse.text()}`)
      workspace = await resumeResponse.json()
    }
    const snapshotResponse = await context.request.get(`${baseUrl}/api/v3/assignments/${project.assignmentSnapshotId}/snapshot`)
    const assignmentSnapshot = snapshotResponse.ok() ? await snapshotResponse.json() : null

    const diagnosticParams = new URLSearchParams()
    if (disableMapForDiagnostics && sceneType === "CITY_SHOW") diagnosticParams.set("disableMap", "1")
    if (disableStreamForDiagnostics && sceneType === "CITY_SHOW") diagnosticParams.set("disableStream", "1")
    const diagnosticQuery = diagnosticParams.toString() ? `?${diagnosticParams.toString()}` : ""
    await page.goto(`${baseUrl}${diagnosticQuery}`, { waitUntil: "domcontentloaded" })
    if (projectIdOverride) {
      await page.waitForTimeout(500)
      const demoLogin = page.getByRole("button", { name: "学生演示", exact: true })
      if (await demoLogin.count() && await demoLogin.first().isVisible()) {
        const loginResponse = page.waitForResponse((response) => response.url().endsWith("/api/auth/login") && response.status() === 201, { timeout: 15_000 })
        await demoLogin.first().click()
        await loginResponse
      }
      await page.locator(".platform-shell").waitFor({ timeout: 30_000 })
      const skip = page.getByRole("button", { name: "跳过引导", exact: true })
      if (await skip.count() && await skip.first().isVisible()) await skip.first().click()
      const internalDataToggle = page.locator(".student-task-toolbar .el-checkbox")
      if (await internalDataToggle.count() && await internalDataToggle.first().isVisible() && !(await internalDataToggle.first().locator("input").isChecked())) {
        const projectsReloaded = page.waitForResponse((response) => response.url().includes("/v3/my-projects?includeInternalData=true") && response.status() === 200)
        await internalDataToggle.first().click()
        await projectsReloaded
      }
    }
    if (scene.homeTab) await page.locator(".home-scene-segment button").filter({ hasText: scene.homeTab }).click()
    if (projectIdOverride) {
      const projectSearch = page.locator(".student-task-search input")
      if (await projectSearch.count() && await projectSearch.first().isVisible()) {
        await projectSearch.first().fill(project.title)
        await page.waitForTimeout(250)
      }
    }
    const projectButton = page.locator(".v3-home-project-list > button").filter({ hasText: project.title })
    const projectButtonReady = async () => (await projectButton.count()) > 0 && await projectButton.first().isVisible()
    const waitUntilProjectVisible = async () => {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        if (await projectButtonReady()) return true
        const loadMore = page.getByRole("button", { name: /加载更多/ })
        if (await loadMore.count() && await loadMore.first().isVisible()) {
          await loadMore.first().click()
          await page.waitForTimeout(150)
        } else {
          await page.waitForTimeout(250)
        }
      }
      return false
    }
    if (!await waitUntilProjectVisible()) {
      await page.reload({ waitUntil: "domcontentloaded" })
      await page.locator(".platform-shell").waitFor({ timeout: 30_000 })
      const internalDataToggle = page.locator(".student-task-toolbar .el-checkbox")
      if (await internalDataToggle.count() && await internalDataToggle.first().isVisible() && !(await internalDataToggle.first().locator("input").isChecked())) {
        const projectsReloaded = page.waitForResponse((response) => response.url().includes("/v3/my-projects?includeInternalData=true") && response.status() === 200, { timeout: 15_000 })
        await internalDataToggle.first().click()
        await projectsReloaded
      }
      const projectSearch = page.locator(".student-task-search input")
      if (await projectSearch.count() && await projectSearch.first().isVisible()) {
        await projectSearch.first().fill(project.title)
        await page.waitForTimeout(250)
      }
      if (!await waitUntilProjectVisible()) throw new Error(`学生任务列表未加载验收项目：${project.title}`)
    }
    await projectButton.first().click()
    await page.locator(".v3-stage-nav > button").filter({ hasText: scene.stageLabel }).click()

    const workspaceSelector = scene.workspaceSelector
    await page.locator(workspaceSelector).waitFor({ timeout: 15_000 })
    if (!disableMapForDiagnostics) await page.locator(`${workspaceSelector} canvas`).waitFor({ timeout: 15_000 })
    if (!disableStreamForDiagnostics) await page.locator(`${workspaceSelector} ${scene.streamSelector}`).waitFor({ timeout: 15_000 })
    await page.waitForTimeout(warmupMs)
    if (disableMapForDiagnostics) {
      await page.locator(`${workspaceSelector} .show-runtime-map-shell, ${workspaceSelector} .logistics-runtime-map-shell, ${workspaceSelector} .vtl-runtime-map-shell`).evaluateAll((elements) => {
        for (const element of elements) element.setAttribute("style", "display: none !important")
      })
    }

    const cdp = await context.newCDPSession(page)
    await cdp.send("Performance.enable")
    await cdp.send("HeapProfiler.enable")
    const heapSnapshots = {}
    if (heapSnapshotEnabled) {
      heapSnapshots.before = await takeHeapSnapshot(cdp, resolve(heapSnapshotDirectory, `${sceneType.toLowerCase()}-${project.id}-before.heapsnapshot`))
    }
    await cdp.send("HeapProfiler.collectGarbage")
    const beforeMetrics = metricMap(await cdp.send("Performance.getMetrics"))
    const beforeHeap = await cdp.send("Runtime.getHeapUsage")
    const renderingPromise = page.evaluate(async ({ sampleDurationMs, workspaceSelector }) => {
      const longTasks = []
      let observer = null
      if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push({ startTime: entry.startTime, duration: entry.duration })
        })
        observer.observe({ entryTypes: ["longtask"] })
      }
      const frameTimes = []
      const startedAt = performance.now()
      let previous = startedAt
      await new Promise((resolveFrameSample) => {
        const sample = (now) => {
          frameTimes.push(now - previous)
          previous = now
          if (now - startedAt >= sampleDurationMs) resolveFrameSample()
          else requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      })
      observer?.disconnect()
      const sorted = frameTimes.slice(1).sort((left, right) => left - right)
      const duration = Math.max(previous - startedAt, 1)
      const percentile = (ratio) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0
      const canvas = document.querySelector(`${workspaceSelector} canvas`)
      const canvasRect = canvas?.getBoundingClientRect()
      const workspaceElement = document.querySelector(workspaceSelector)
      const workspaceRect = workspaceElement?.getBoundingClientRect()
      const memory = performance.memory
      return {
        durationMs: duration,
        frames: sorted.length,
        averageFps: sorted.length * 1000 / duration,
        p50FrameTimeMs: percentile(0.5),
        p95FrameTimeMs: percentile(0.95),
        p99FrameTimeMs: percentile(0.99),
        framesOver50Ms: sorted.filter((value) => value > 50).length,
        longTaskCount: longTasks.length,
        longTaskTotalMs: longTasks.reduce((sum, item) => sum + item.duration, 0),
        maxLongTaskMs: Math.max(0, ...longTasks.map((item) => item.duration)),
        domNodeCount: document.getElementsByTagName("*").length,
        canvasCount: document.querySelectorAll("canvas").length,
        canvas: canvasRect ? { width: canvas.width, height: canvas.height, boundingWidth: canvasRect.width, boundingHeight: canvasRect.height } : null,
        workspace: workspaceRect ? { width: workspaceRect.width, height: workspaceRect.height } : null,
        performanceMemory: memory ? { jsHeapSizeLimit: memory.jsHeapSizeLimit, totalJSHeapSize: memory.totalJSHeapSize, usedJSHeapSize: memory.usedJSHeapSize } : null
      }
    }, { sampleDurationMs: durationMs, workspaceSelector })
    const heartbeatSamples = []
    const heartbeatStartedAt = Date.now()
    while (Date.now() - heartbeatStartedAt < durationMs) {
      await sleep(Math.min(heartbeatIntervalMs, Math.max(1, durationMs - (Date.now() - heartbeatStartedAt))))
      try {
        await cdp.send("HeapProfiler.collectGarbage")
        const [heap, metrics, liveCount] = await Promise.all([
          cdp.send("Runtime.getHeapUsage"),
          cdp.send("Performance.getMetrics"),
          page.locator(`${workspaceSelector} ${scene.streamSelector}`).count()
        ])
        const metricValues = metricMap(metrics)
        heartbeatSamples.push({
          elapsedMs: Date.now() - heartbeatStartedAt,
          streamLive: liveCount === 1,
          usedSize: heap.usedSize,
          totalSize: heap.totalSize,
          jsHeapUsedSize: metricValues.JSHeapUsedSize ?? null
        })
      } catch (error) {
        heartbeatSamples.push({
          elapsedMs: Date.now() - heartbeatStartedAt,
          streamLive: false,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    const rendering = await renderingPromise
    const afterMetrics = metricMap(await cdp.send("Performance.getMetrics"))
    await cdp.send("HeapProfiler.collectGarbage")
    const afterHeap = await cdp.send("Runtime.getHeapUsage")
    if (heapSnapshotEnabled) {
      heapSnapshots.after = await takeHeapSnapshot(cdp, resolve(heapSnapshotDirectory, `${sceneType.toLowerCase()}-${project.id}-after.heapsnapshot`))
    }
    const finalWorkspaceResponse = await context.request.get(`${baseUrl}${workspacePath}`)
    const finalWorkspace = finalWorkspaceResponse.ok() ? await finalWorkspaceResponse.json() : null
    const screenshot = resolve(screenshotDirectory, `${sceneType.toLowerCase()}-${project.id}.png`)
    await page.screenshot({ path: screenshot, fullPage: true })

    const scale = scaleEvidence(sceneType, workspace)
    const usedSizeSamples = [beforeHeap.usedSize, ...heartbeatSamples.map((item) => item.usedSize).filter(Number.isFinite), afterHeap.usedSize]
    const peakUsedSize = Math.max(...usedSizeSamples)
    const peakGrowthBytes = peakUsedSize - beforeHeap.usedSize
    const expectedHeartbeatSamples = Math.max(1, Math.floor(durationMs / heartbeatIntervalMs * 0.75))
    const checks = {
      workspaceVisible: Boolean(rendering.workspace?.width && rendering.workspace?.height),
      canvasVisible: Boolean(rendering.canvas?.boundingWidth && rendering.canvas?.boundingHeight),
      streamLive: await page.locator(`${workspaceSelector} ${scene.streamSelector}`).count() === 1,
      streamStayedLive: heartbeatSamples.length >= expectedHeartbeatSamples && heartbeatSamples.every((item) => item.streamLive),
      heartbeatCoverage: heartbeatSamples.length >= expectedHeartbeatSamples,
      sampledDuration: rendering.durationMs >= durationMs * 0.95,
      minimumFps: rendering.averageFps >= minimumFps,
      memoryGrowthWithinLimit: peakGrowthBytes <= maximumHeapGrowthBytes,
      runningSessionQualified: !requireRunningSession || (workspace.session.status === "RUNNING" && finalWorkspace?.session?.status === "RUNNING"),
      noPageErrors: pageErrors.length === 0,
      noConsoleErrors: consoleErrors.length === 0,
      scaleConsistency: scale.consistent,
      formalScaleQualified: scale.qualified
    }
    checks.functionalPassed = checks.workspaceVisible
      && checks.canvasVisible
      && checks.streamLive
      && checks.streamStayedLive
      && checks.heartbeatCoverage
      && checks.sampledDuration
      && checks.minimumFps
      && checks.memoryGrowthWithinLimit
      && checks.scaleConsistency
      && checks.noPageErrors
      && checks.noConsoleErrors
    checks.longRunQualified = checks.functionalPassed
      && rendering.durationMs >= formalMinimumDurationMs
      && checks.runningSessionQualified
    checks.formalAcceptancePassed = checks.longRunQualified && checks.formalScaleQualified

    return {
      sceneType,
      project: {
        id: project.id,
        title: project.title,
        runtimeStageStatus: project.runtimeStage.status,
        sessionStatus: workspace.session.status,
        finalSessionStatus: finalWorkspace?.session?.status ?? null,
        initialRevision: workspace.session.revision,
        finalRevision: finalWorkspace?.session?.revision ?? null
      },
      scale,
      resources: assignmentSnapshot?.resourceRefs ?? [],
      rendering: roundNumbers(rendering),
      browserMemory: {
        before: { usedSize: beforeHeap.usedSize, totalSize: beforeHeap.totalSize, jsHeapUsedSize: beforeMetrics.JSHeapUsedSize ?? null },
        after: { usedSize: afterHeap.usedSize, totalSize: afterHeap.totalSize, jsHeapUsedSize: afterMetrics.JSHeapUsedSize ?? null },
        delta: { usedSize: afterHeap.usedSize - beforeHeap.usedSize, totalSize: afterHeap.totalSize - beforeHeap.totalSize, jsHeapUsedSize: (afterMetrics.JSHeapUsedSize ?? 0) - (beforeMetrics.JSHeapUsedSize ?? 0) },
        peakUsedSize,
        peakGrowthBytes,
        maximumGrowthBytes: maximumHeapGrowthBytes,
        samples: heartbeatSamples
      },
      heapSnapshots,
      errors: { page: pageErrors, console: consoleErrors, failedRequests },
      screenshot,
      checks
    }
  } finally {
    await context.close()
  }
}

function selectProject(projects, sceneType) {
  const runtimeStageCode = sceneDefinitions[sceneType]?.stageCode
  if (!runtimeStageCode) return null
  return projects.flatMap((project) => {
    if (project.sceneType !== sceneType || (projectIdOverride && project.id !== projectIdOverride)) return []
    const runtimeStage = project.stages?.find((stage) => stage.stageCode === runtimeStageCode)
    if (!runtimeStage || !["IN_PROGRESS", "ACCEPTED"].includes(runtimeStage.status)) return []
    return [{ ...project, runtimeStage }]
  })[0] ?? null
}

function scaleEvidence(sceneType, workspace) {
  if (sceneType === "CITY_SHOW") {
    const actual = {
      aircraft: Number(workspace.totals?.plannedCount ?? 0),
      groups: Number(workspace.groups?.length ?? 0),
      groupAircraft: Number(workspace.groups?.reduce((sum, group) => sum + Number(group.plannedCount ?? 0), 0) ?? 0)
    }
    const required = { aircraft: 3000 }
    const consistent = actual.aircraft > 0 && actual.groups > 0 && actual.groupAircraft === actual.aircraft
    return { actual, required, consistent, qualified: actual.aircraft === required.aircraft && consistent }
  }
  if (sceneType === "VTOL_INSPECTION") {
    const actual = {
      aircraft: Number(workspace.summary?.totalAircraft ?? 0),
      aircraftObjects: Number(workspace.aircraft?.length ?? 0),
      groups: Number(workspace.groups?.length ?? 0),
      groupAircraft: Number(workspace.groups?.reduce((sum, group) => sum + Number(group.aircraftCount ?? 0), 0) ?? 0),
      taskObjects: Number(workspace.summary?.totalTaskObjects ?? 0)
    }
    const required = { aircraft: 20 }
    const consistent = actual.aircraft === actual.aircraftObjects && actual.aircraft === actual.groupAircraft && actual.groups > 0
    return { actual, required, consistent, qualified: actual.aircraft === required.aircraft && consistent }
  }
  const actual = {
    aircraft: Number(workspace.summary?.totalAircraft ?? 0),
    aircraftObjects: Number(workspace.aircraft?.length ?? 0),
    orders: Number(workspace.summary?.totalOrders ?? 0),
    orderObjects: Number(workspace.orders?.length ?? 0),
    tasks: Number(workspace.tasks?.length ?? 0),
    scheduleItems: Number(workspace.scheduleItems?.length ?? 0)
  }
  const required = { aircraft: 50, orders: 100 }
  const consistent = actual.aircraft === actual.aircraftObjects
    && actual.orders === actual.orderObjects
    && actual.orders === actual.tasks
    && actual.orders === actual.scheduleItems
  return { actual, required, consistent, qualified: actual.aircraft === required.aircraft && actual.orders === required.orders && consistent }
}

function metricMap(value) {
  return Object.fromEntries((value.metrics ?? []).map((item) => [item.name, item.value]))
}

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

function roundNumbers(value) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === "number" ? Math.round(item * 1000) / 1000 : item]))
}

function browserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ].filter(Boolean)
  const selected = candidates.find((candidate) => existsSync(candidate))
  if (!selected) throw new Error("未找到 Chrome 或 Edge；可通过 CHROME_PATH 指定浏览器路径")
  return selected
}

async function browserVersion(path) {
  const probe = await chromium.launch({ executablePath: path, headless: true })
  try { return probe.version() } finally { await probe.close() }
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("浏览器采样时长必须为正整数")
  return parsed
}

function positiveNumber(value, fallback) {
  const parsed = Number(value ?? fallback)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("浏览器最低帧率必须为正数")
  return parsed
}

function sleep(duration) { return new Promise((resolveSleep) => setTimeout(resolveSleep, duration)) }

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
}
