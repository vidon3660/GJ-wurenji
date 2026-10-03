import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { chromium } from "playwright-core"

const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")
const fixturePath = resolve(process.env.SHOW_GROUP_FIXTURE ?? "artifacts/performance/p0-long-fixture-current.json")
const outputPath = resolve(process.env.SHOW_GROUP_BROWSER_OUTPUT ?? "artifacts/show-runtime/show-group-map-browser-acceptance-latest.json")
const screenshotPath = resolve(process.env.SHOW_GROUP_BROWSER_SCREENSHOT ?? "artifacts/show-runtime/show-group-map-browser-acceptance-latest.png")
const fixtureDocument = JSON.parse(await readFile(fixturePath, "utf8"))
const fixture = fixtureDocument.projects?.CITY_SHOW ?? fixtureDocument
if (!fixture.projectId || !fixture.title || fixture.isAcceptanceData !== true) throw new Error("城市表演编队点选夹具无效")

const browser = await chromium.launch({ executablePath: browserExecutable(), headless: process.env.HEADLESS !== "false" })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const page = await context.newPage()
const errors = []
const failedRequests = []
const mapRequests = []
page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("401 (Unauthorized)")) errors.push(message.text())
})
page.on("requestfailed", (request) => {
  if (request.url().includes("/api/") && !request.url().includes("/runtime/stream")) failedRequests.push(`${request.method()} ${request.url()}`)
})
page.on("request", (request) => {
  if (isMapResourceRequest(request.url(), request.resourceType())) mapRequests.push({ url: request.url(), resourceType: request.resourceType(), at: Date.now() })
})

let result
try {
  await page.goto(appUrl, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: "学生演示", exact: true }).click()
  await page.locator(".platform-shell").waitFor({ timeout: 15_000 })
  const skip = page.getByRole("button", { name: "跳过引导", exact: true })
  if (await skip.count() && await skip.first().isVisible()) await skip.first().click()
  const internalDataToggle = page.locator(".student-task-toolbar .el-checkbox")
  if (await internalDataToggle.count() && await internalDataToggle.first().isVisible() && !(await internalDataToggle.first().locator("input").isChecked())) {
    const projectsReloaded = page.waitForResponse((response) => response.url().includes("/v3/my-projects?includeInternalData=true") && response.status() === 200)
    await internalDataToggle.first().click()
    await projectsReloaded
  }
  await page.locator(".home-scene-segment button").filter({ hasText: "表演" }).click()
  await page.locator(".student-task-search input").fill(fixture.title)
  const project = page.locator(".v3-home-project-list > button").filter({ hasText: fixture.title }).first()
  await project.waitFor({ timeout: 15_000 })
  await project.click()
  await page.locator(".v3-project-shell").waitFor({ timeout: 15_000 })
  await page.locator(".v3-stage-nav > button").filter({ hasText: /表演运行/ }).click()
  await page.locator(".show-runtime-workspace").waitFor({ timeout: 15_000 })
  await page.locator(".show-runtime-map-shell canvas").waitFor({ timeout: 15_000 })
  await page.locator(".runtime-groups-list li").first().waitFor({ timeout: 15_000 })
  await page.waitForFunction(() => {
    const shell = document.querySelector(".show-runtime-map-shell")
    return Number.isFinite(Number(shell?.getAttribute("data-camera-ground-range-meters")))
      && Number.isFinite(Number(shell?.getAttribute("data-camera-ground-longitude")))
      && Number(shell?.getAttribute("data-camera-height-meters")) < 100_000
  })

  const cdp = await context.newCDPSession(page)
  const heapBefore = await cdp.send("Runtime.getHeapUsage")
  const cameraBefore = await readCamera(page)
  const canvas = page.locator(".show-runtime-map-shell canvas")
  await canvas.hover()
  for (let index = 0; index < 10; index += 1) {
    await page.mouse.wheel(0, -800)
    await page.waitForTimeout(80)
  }
  await page.waitForTimeout(1_200)
  const cameraAfterNegativeWheel = await readCamera(page)
  await page.getByRole("button", { name: "回到教学区域", exact: true }).click()
  await page.waitForTimeout(600)
  await canvas.hover()
  for (let index = 0; index < 10; index += 1) {
    await page.mouse.wheel(0, 800)
    await page.waitForTimeout(80)
  }
  await page.waitForTimeout(1_200)
  const cameraAfterPositiveWheel = await readCamera(page)
  await page.waitForFunction(() => {
    const shell = document.querySelector(".show-runtime-map-shell")
    const height = Number(shell?.getAttribute("data-camera-height-meters"))
    const longitude = Number(shell?.getAttribute("data-camera-ground-longitude"))
    const latitude = Number(shell?.getAttribute("data-camera-ground-latitude"))
    return Number.isFinite(height) && height >= 0 && Number.isFinite(longitude) && Number.isFinite(latitude)
  }, { timeout: 3_000 }).catch(() => undefined)
  const cameraNearLimit = cameraAfterNegativeWheel.heightMeters <= cameraAfterPositiveWheel.heightMeters ? cameraAfterNegativeWheel : cameraAfterPositiveWheel
  const cameraFarLimit = cameraAfterNegativeWheel.heightMeters > cameraAfterPositiveWheel.heightMeters ? cameraAfterNegativeWheel : cameraAfterPositiveWheel
  await page.getByRole("button", { name: "回到教学区域", exact: true }).click()
  await page.waitForTimeout(600)
  const cameraBeforeRotation = await readCamera(page)

  await page.getByRole("button", { name: "视角左旋", exact: true }).click()
  await page.waitForTimeout(250)
  const cameraAfterLeft = await readCamera(page)
  await page.getByRole("button", { name: "视角右旋", exact: true }).click()
  await page.waitForTimeout(250)
  const cameraAfterRight = await readCamera(page)

  const frameRate = await sampleFrameRate(page, 2_000)
  await page.waitForTimeout(1_000)
  const settledRequestCount = mapRequests.length
  await page.waitForTimeout(2_000)
  const sustainedRequestCount = mapRequests.length - settledRequestCount
  const heapAfter = await cdp.send("Runtime.getHeapUsage")
  const performance = {
    frameRate,
    heapBeforeBytes: heapBefore.usedSize,
    heapAfterBytes: heapAfter.usedSize,
    heapGrowthBytes: heapAfter.usedSize - heapBefore.usedSize,
    mapRequestCount: mapRequests.length,
    sustainedRequestCount
  }
  const camera = {
    before: cameraBefore,
    afterNegativeWheel: cameraAfterNegativeWheel,
    afterPositiveWheel: cameraAfterPositiveWheel,
    nearLimit: cameraNearLimit,
    farLimit: cameraFarLimit,
    beforeRotation: cameraBeforeRotation,
    afterLeft: cameraAfterLeft,
    afterRight: cameraAfterRight,
    zoomOutRangeConstrained: cameraFarLimit.heightMeters <= cameraFarLimit.maximumRangeMeters * 1.05,
    zoomInRangeConstrained: cameraNearLimit.heightMeters >= cameraNearLimit.minimumRangeMeters * 0.7,
    leftRotationChangedHeading: angularDistance(cameraBeforeRotation.headingRadians, cameraAfterLeft.headingRadians) >= 0.08,
    oppositeRotationRestoredHeading: angularDistance(cameraBeforeRotation.headingRadians, cameraAfterRight.headingRadians) <= 0.08,
    rotationCenterStable: coordinateDistance(cameraBeforeRotation, cameraAfterRight) <= 0.01
  }

  const groupItems = page.locator(".runtime-groups-list li")
  const groupCount = await groupItems.count()
  if (groupCount < 2) throw new Error(`城市表演运行分组不足 2 个：${groupCount}`)
  await groupItems.nth(1).click()
  await page.waitForFunction(() => {
    const item = document.querySelectorAll(".runtime-groups-list li")[1]
    const mapId = document.querySelector(".show-runtime-map-shell")?.getAttribute("data-selected-group-id")
    return Boolean(item?.classList.contains("selected") && mapId)
  })
  const initial = await readSelection(page)
  const box = await canvas.boundingBox()
  if (!box) throw new Error("城市表演运行地图 Canvas 不可见")
  let clickCount = 0
  let changed = false
  for (let row = 1; row < 42 && !changed; row += 1) {
    for (let column = 1; column < 62 && !changed; column += 1) {
      const x = box.x + box.width * column / 62
      const y = box.y + box.height * row / 42
      await page.mouse.click(x, y)
      clickCount += 1
      await page.waitForTimeout(30)
      const current = await readSelection(page)
      if (current.mapSelectedGroupId && current.mapSelectedGroupId !== initial.mapSelectedGroupId) {
        changed = true
        result = { initial, selected: current, clickCount, click: { x: Math.round(x), y: Math.round(y) } }
      }
    }
  }
  const layout = await page.evaluate(() => ({
    noHorizontalOverflow: document.body.scrollWidth <= document.body.clientWidth,
    canvasWidth: document.querySelector(".show-runtime-map-shell canvas")?.getBoundingClientRect().width ?? 0,
    canvasHeight: document.querySelector(".show-runtime-map-shell canvas")?.getBoundingClientRect().height ?? 0
  }))
  const checks = {
    mapClickChangedSelection: changed,
    mapAndListAgree: Boolean(result?.selected.mapSelectedGroupId) && result?.selected.mapSelectedGroupId === result?.selected.listSelectedGroupId,
    canvasUsable: layout.canvasWidth > 0 && layout.canvasHeight > 0,
    noHorizontalOverflow: layout.noHorizontalOverflow,
    cameraDiagnosticsAvailable: Object.values(cameraBefore).every(Number.isFinite),
    zoomOutRangeConstrained: camera.zoomOutRangeConstrained,
    zoomInRangeConstrained: camera.zoomInRangeConstrained,
    leftRotationChangedHeading: camera.leftRotationChangedHeading,
    oppositeRotationRestoredHeading: camera.oppositeRotationRestoredHeading,
    rotationCenterStable: camera.rotationCenterStable,
    frameRateAcceptable: performance.frameRate >= 24,
    heapGrowthBounded: performance.heapGrowthBytes <= 32 * 1024 * 1024,
    noSustainedMapRequestChurn: performance.sustainedRequestCount <= 4,
    noUnexpectedErrors: errors.length === 0 && failedRequests.length === 0
  }
  await mkdir(dirname(screenshotPath), { recursive: true })
  await page.screenshot({ path: screenshotPath, fullPage: true })
  result = { ...result, fixture: { projectId: fixture.projectId, title: fixture.title }, camera, performance, layout, screenshotPath, errors, failedRequests, checks, passed: Object.values(checks).every(Boolean) }
} finally {
  await context.close()
  await browser.close()
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify({ format: "wurenji-show-group-map-browser-acceptance", formatVersion: 1, generatedAt: new Date().toISOString(), appUrl, result }, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify({ passed: result?.passed ?? false, outputPath, checks: result?.checks ?? {} }, null, 2)}\n`)
if (!result?.passed) process.exitCode = 1

async function readSelection(currentPage) {
  return currentPage.evaluate(() => ({
    mapSelectedGroupId: document.querySelector(".show-runtime-map-shell")?.getAttribute("data-selected-group-id") ?? "",
    listSelectedGroupId: document.querySelector(".runtime-groups-list li.selected")?.querySelector("span")?.textContent?.trim() ?? ""
  }))
}

async function readCamera(currentPage) {
  return currentPage.locator(".show-runtime-map-shell").evaluate((element) => ({
    longitude: Number(element.getAttribute("data-camera-longitude")),
    latitude: Number(element.getAttribute("data-camera-latitude")),
    heightMeters: Number(element.getAttribute("data-camera-height-meters")),
    headingRadians: Number(element.getAttribute("data-camera-heading-radians")),
    pitchRadians: Number(element.getAttribute("data-camera-pitch-radians")),
    groundLongitude: Number(element.getAttribute("data-camera-ground-longitude")),
    groundLatitude: Number(element.getAttribute("data-camera-ground-latitude")),
    groundRangeMeters: Number(element.getAttribute("data-camera-ground-range-meters")),
    minimumRangeMeters: Number(element.getAttribute("data-camera-minimum-range-meters")),
    maximumRangeMeters: Number(element.getAttribute("data-camera-maximum-range-meters"))
  }))
}

async function sampleFrameRate(currentPage, durationMs) {
  return currentPage.evaluate((duration) => new Promise((resolveFrameRate) => {
    let frames = 0
    const startedAt = performance.now()
    const sample = (now) => {
      frames += 1
      if (now - startedAt >= duration) {
        resolveFrameRate(frames * 1_000 / (now - startedAt))
        return
      }
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  }), durationMs)
}

function angularDistance(left, right) {
  const delta = Math.abs(left - right) % (Math.PI * 2)
  return Math.min(delta, Math.PI * 2 - delta)
}

function coordinateDistance(left, right) {
  return Math.hypot(left.groundLongitude - right.groundLongitude, left.groundLatitude - right.groundLatitude)
}

function isMapResourceRequest(url, resourceType) {
  if (resourceType === "image") return true
  return /(?:tiles?|terrain|imagery|cesium\.com|arcgis|openstreetmap|mapbox)/i.test(url) && !url.includes("/api/")
}

function browserExecutable() {
  const candidates = [process.env.CHROME_PATH, process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe` : undefined, process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined, "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean)
  const value = candidates.find((candidate) => existsSync(candidate))
  if (!value) throw new Error("未找到 Chrome，请通过 CHROME_PATH 指定浏览器路径")
  return value
}
