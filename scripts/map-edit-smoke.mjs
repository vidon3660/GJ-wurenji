import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { chromium } from "playwright-core"

const candidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
  process.env["ProgramFiles(x86)"] ? `${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe` : undefined
].filter(Boolean)
const executablePath = candidates.find((candidate) => existsSync(candidate))
if (!executablePath) throw new Error("未找到 Chrome；可通过 CHROME_PATH 指定浏览器路径")

const baseUrl = process.env.APP_URL ?? "http://localhost:3000"
const outputDirectory = process.env.VISUAL_OUTPUT_DIR ?? "/tmp/wurenji-map-edit"
const expectReality = process.env.EXPECT_REALITY === "true"
const blockMapTiles = process.env.BLOCK_MAP_TILES !== "false"
const blockTerrainEndpoint = process.env.BLOCK_TERRAIN_ENDPOINT === "true"
await mkdir(outputDirectory, { recursive: true })

const browser = await chromium.launch({ executablePath, headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const page = await context.newPage()
let studentContext = null
const pageErrors = []
page.on("pageerror", (error) => pageErrors.push(error.message))
if (blockMapTiles) await page.route("https://tile.openstreetmap.org/**", (route) => route.abort())
if (blockTerrainEndpoint) await page.route("https://api.cesium.com/v1/assets/1/endpoint**", (route) => route.abort())

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: "教师演示" }).click()
  await page.getByRole("button", { name: "V2 仿真工作台" }).click()
  await page.locator(".app-shell").waitFor()
  const deliveryTaskButton = page.getByRole("button", { name: /配送点 D-02/ })
  const ensureLogisticsPractice = async () => {
    if (await deliveryTaskButton.count() > 0) return
    const practiceSelect = page.locator(".practice-heading .el-select")
    if (await practiceSelect.count() > 0) {
      await practiceSelect.click()
      const logisticsOption = page.locator(".el-select-dropdown:visible .el-select-dropdown__item").filter({ hasText: "城市物流配送实验" })
      await logisticsOption.waitFor({ state: "visible", timeout: 5000 })
      await logisticsOption.click()
      await deliveryTaskButton.waitFor({ state: "visible", timeout: 10000 })
    }
  }
  await ensureLogisticsPractice()
  await page.locator(".cesium-map canvas").waitFor()
  await page.getByRole("button", { name: "2D 精确规划视角" }).click()
  await page.locator('.cesium-map[data-scene-mode="2d"]').waitFor({ timeout: 5000 })
  await page.waitForTimeout(1000)
  await page.waitForFunction(() => {
    const map = document.querySelector(".cesium-map")
    return map?.getAttribute("data-imagery-state") !== "loading"
      && map?.getAttribute("data-terrain-state") !== "loading"
      && map?.getAttribute("data-buildings-state") !== "loading"
  }, undefined, { timeout: 30000 }).catch(() => undefined)
  const mapData = await page.locator(".cesium-map").evaluate((element) => ({
    imagery: element.getAttribute("data-imagery-state"),
    terrain: element.getAttribute("data-terrain-state"),
    buildings: element.getAttribute("data-buildings-state")
  }))
  if (expectReality && (mapData.imagery !== "ready" || mapData.terrain !== "ready" || mapData.buildings !== "ready")) {
    throw new Error(`实景图层未就绪：${JSON.stringify(mapData)}`)
  }

  await ensureLogisticsPractice()
  await deliveryTaskButton.click()
  const coordinateInputs = page.locator(".property-section .coordinate-grid input")
  await coordinateInputs.first().waitFor()
  const before = {
    longitude: await coordinateInputs.nth(0).inputValue(),
    latitude: await coordinateInputs.nth(1).inputValue()
  }

  const canvas = page.locator(".cesium-map canvas")
  const box = await canvas.boundingBox()
  if (!box) throw new Error("无法读取 Cesium 画布位置")
  const beforeScreenshot = `${outputDirectory}/teacher-before-drag.png`
  await page.screenshot({ path: beforeScreenshot, fullPage: true })

  const entityPosition = await page.evaluate(() => window.__wurenjiMapTest?.entityScreenPosition("task:order-02") ?? null)
  const start = entityPosition ? { x: box.x + entityPosition.x, y: box.y + entityPosition.y } : null
  if (start) {
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + 42, start.y + 28, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(400)
  }

  const after = {
    longitude: await coordinateInputs.nth(0).inputValue(),
    latitude: await coordinateInputs.nth(1).inputValue()
  }
  if (start && before.longitude === after.longitude && before.latitude === after.latitude) {
    const failedScreenshot = `${outputDirectory}/teacher-failed-drag.png`
    await page.screenshot({ path: failedScreenshot, fullPage: true })
    throw new Error(`拖动配送点后坐标未变化：${JSON.stringify({ before, after, box, start, beforeScreenshot, failedScreenshot })}`)
  }


  const teacherObjectRows = page.locator("button.object-row")
  const objectCountBefore = await teacherObjectRows.count()
  await page.locator(".cesium-map canvas").evaluate((canvas) => {
    window.__smokeCanvasClicks = 0
    canvas.addEventListener("click", (event) => {
      window.__smokeCanvasClicks += 1
      window.__smokeLastCanvasClick = { clientX: event.clientX, clientY: event.clientY }
    })
  })
  await page.getByRole("button", { name: "添加障碍物" }).click()
  await page.locator(".cesium-map.is-edit-tool").waitFor()
  const obstacleAnchor = await page.evaluate(() => window.__wurenjiMapTest?.entityScreenPosition("task:order-03") ?? null)
  const obstacleCandidates = obstacleAnchor
    ? [obstacleAnchor]
    : [
        { x: box.width * 0.83, y: box.height * 0.57 },
        { x: box.width * 0.56, y: box.height * 0.72 },
        { x: box.width * 0.5, y: box.height * 0.5 }
      ]
  for (const candidate of obstacleCandidates) {
    await page.mouse.move(box.x + candidate.x, box.y + candidate.y)
    await page.mouse.down()
    await page.waitForTimeout(120)
    await page.mouse.up()
    await page.waitForTimeout(300)
    if (await teacherObjectRows.count() === objectCountBefore + 1) break
  }
  const objectCountAfter = await teacherObjectRows.count()
  if (objectCountAfter !== objectCountBefore + 1) {
    const failedScreenshot = `${outputDirectory}/teacher-failed-add-obstacle.png`
    await page.screenshot({ path: failedScreenshot, fullPage: true })
    const messages = await page.locator(".el-message").allTextContents()
    const runtime = await page.locator(".cesium-map").evaluate((element) => {
      const instance = element.__vueParentComponent
      return {
        canvasClicks: window.__smokeCanvasClicks,
        lastCanvasClick: window.__smokeLastCanvasClick,
        activeTool: instance?.props?.activeTool,
        vnodeActiveTool: instance?.vnode?.props?.activeTool ?? instance?.vnode?.props?.["active-tool"],
        propKeys: Object.keys(instance?.props ?? {}),
        className: element.className
      }
    })
    runtime.mapAttributes = await page.locator(".map-stage").evaluate((element) => ({
      activeTool: element.getAttribute("data-active-tool"),
      isTeacher: element.getAttribute("data-is-teacher"),
      receivedMapClicks: element.getAttribute("data-received-map-click-count")
    }))
    runtime.cesiumAttributes = await page.locator(".cesium-map").evaluate((element) => ({
      interaction: element.getAttribute("data-map-interaction"),
      nativeClickCount: element.getAttribute("data-native-click-count")
    }))
    throw new Error(`教师新增障碍物失败：${JSON.stringify({ objectCountBefore, objectCountAfter, runtime, messages, failedScreenshot })}`)
  }
  if (pageErrors.length > 0) throw new Error(`页面异常：${pageErrors.join("；")}`)

  const screenshot = `${outputDirectory}/teacher-task-dragged.png`
  await page.screenshot({ path: screenshot, fullPage: true })

  studentContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const studentPage = await studentContext.newPage()
  const studentErrors = []
  studentPage.on("pageerror", (error) => studentErrors.push(error.message))
  if (blockMapTiles) await studentPage.route("https://tile.openstreetmap.org/**", (route) => route.abort())
  if (blockTerrainEndpoint) await studentPage.route("https://api.cesium.com/v1/assets/1/endpoint**", (route) => route.abort())
  await studentPage.goto(baseUrl, { waitUntil: "domcontentloaded" })
  await studentPage.getByRole("button", { name: "学生演示" }).click()
  await studentPage.getByRole("button", { name: "V2 历史工作台" }).click()
  await studentPage.locator(".app-shell").waitFor()
  const studentCanvas = studentPage.locator(".cesium-map canvas")
  await studentCanvas.waitFor()
  await studentPage.getByRole("button", { name: "2D 精确规划视角" }).click()
  await studentPage.locator('.cesium-map[data-scene-mode="2d"]').waitFor({ timeout: 5000 })
  await studentPage.waitForTimeout(900)
  const firstDrone = studentPage.locator(".drone-row").first()
  await firstDrone.waitFor()
  await firstDrone.click()
  const studentBox = await studentCanvas.boundingBox()
  if (!studentBox) throw new Error("无法读取学生端 Cesium 画布位置")
  const waypointRows = studentPage.locator(".waypoint-row")
  await waypointRows.first().waitFor()
  const waypointCountBefore = await waypointRows.count()
  await studentPage.getByRole("button", { name: "添加航点" }).click()
  await studentPage.locator(".cesium-map.is-edit-tool").waitFor()
  const waypointAnchor = await studentPage.evaluate(() => window.__wurenjiMapTest?.geoPointScreenPosition(113.9485, 22.5389, 0) ?? null)
  const waypointCandidates = waypointAnchor
    ? [waypointAnchor]
    : [
        { x: studentBox.width * 0.83, y: studentBox.height * 0.57 },
        { x: studentBox.width * 0.56, y: studentBox.height * 0.72 },
        { x: studentBox.width * 0.5, y: studentBox.height * 0.5 }
      ]
  for (const candidate of waypointCandidates) {
    await studentPage.mouse.move(studentBox.x + candidate.x, studentBox.y + candidate.y)
    await studentPage.mouse.down()
    await studentPage.waitForTimeout(120)
    await studentPage.mouse.up()
    await studentPage.waitForTimeout(300)
    if (await waypointRows.count() === waypointCountBefore + 1) break
  }
  const waypointCountAfter = await waypointRows.count()
  if (waypointCountAfter !== waypointCountBefore + 1) {
    throw new Error(`学生新增航点失败：${JSON.stringify({ waypointCountBefore, waypointCountAfter })}`)
  }
  if (!await studentPage.locator(".environment-strip").isVisible()) throw new Error("学生端环境条件未显示")
  if (studentErrors.length > 0) throw new Error(`学生端页面异常：${studentErrors.join("；")}`)
  const studentScreenshot = `${outputDirectory}/student-waypoint-added.png`
  await studentPage.screenshot({ path: studentScreenshot, fullPage: true })

  process.stdout.write(`${JSON.stringify({
    teacher: { dragChecked: Boolean(start), before, after, objectCountBefore, objectCountAfter, mapData, screenshot, pageErrors },
    student: { waypointCountBefore, waypointCountAfter, studentScreenshot, studentErrors }
  }, null, 2)}\n`)
} finally {
  await studentContext?.close()
  await context.close()
  await browser.close()
}
