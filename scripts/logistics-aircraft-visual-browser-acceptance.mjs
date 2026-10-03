import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { chromium } from "playwright-core"

const baseUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")
const projectId = process.env.LOGISTICS_PROJECT_ID ?? "859a6c43-4ae3-45c1-af1b-dd3f45668113"
const title = process.env.LOGISTICS_PROJECT_TITLE ?? "广东北部城市低空物流正式教学任务"
const artifactDirectory = resolve("artifacts/formal-gd-north")
const screenshotPath = resolve(artifactDirectory, "logistics-aircraft-runtime.png")
const outputPath = resolve(artifactDirectory, "logistics-aircraft-runtime-acceptance.json")
const errors = []
const modelResponses = []

await mkdir(artifactDirectory, { recursive: true })
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: process.env.HEADLESS !== "false" })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const page = await context.newPage()
page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("401 (Unauthorized)")) errors.push(message.text())
})
page.on("response", (response) => {
  if (response.url().endsWith("/models/logistics-drone.gltf")) modelResponses.push({ status: response.status(), url: response.url() })
})

const result = { generatedAt: new Date().toISOString(), projectId, title, modelResponses, errors, modes: {}, movement: null, follow: null, screenshotPath, passed: false }
try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: "学生演示", exact: true }).click()
  await page.locator(".platform-shell").waitFor({ timeout: 15_000 })
  const skip = page.getByRole("button", { name: "跳过引导", exact: true })
  if (await skip.count() && await skip.first().isVisible()) await skip.first().click()
  await page.locator(".home-scene-segment button").filter({ hasText: "物流" }).click()
  const project = page.locator(`[data-project-id="${projectId}"]`)
  await project.waitFor({ timeout: 15_000 })
  await project.click()
  await page.locator(".v3-project-shell").waitFor({ timeout: 15_000 })
  await page.getByRole("button", { name: /^配送运行，/ }).click()
  await page.locator(".logistics-runtime-workspace").waitFor({ timeout: 20_000 })
  const map = page.locator(".logistics-runtime-map-shell")
  await map.waitFor({ timeout: 20_000 })
  await page.waitForFunction(() => Number(document.querySelector(".logistics-runtime-map-shell")?.getAttribute("data-aircraft-visual-count") ?? 0) > 0)

  await page.getByRole("button", { name: "3D 空间理解视角", exact: true }).click()
  await waitForMode(page, "3d")
  result.modes.threeDimensional = await mapDetails(map)

  await page.getByRole("button", { name: "2D 精确规划视角", exact: true }).click()
  await waitForMode(page, "2d")
  result.modes.twoDimensional = await mapDetails(map)

  await page.getByRole("button", { name: "3D 空间理解视角", exact: true }).click()
  await waitForMode(page, "3d")
  await page.waitForFunction(() => {
    try { return JSON.parse(document.querySelector(".logistics-runtime-map-shell")?.getAttribute("data-aircraft-pick-points") ?? "[]").length > 0 } catch { return false }
  }, undefined, { timeout: 15_000 })
  const before = await mapDetails(map)
  const rate = page.getByLabel("仿真速度")
  if (await rate.locator('option[value="3600"]').count()) await rate.selectOption("3600")
  else if (await rate.locator('option[value="4"]').count()) await rate.selectOption("4")
  const play = page.getByRole("button", { name: "播放仿真", exact: true })
  if (await play.isEnabled()) await play.click()
  await page.waitForFunction(() => Number(document.querySelector(".logistics-runtime-map-shell")?.getAttribute("data-aircraft-trail-count") ?? 0) > 0, undefined, { timeout: 15_000 })
  await page.waitForTimeout(1_200)
  const after = await mapDetails(map)
  result.movement = {
    before: before.positions,
    after: after.positions,
    positionChanged: JSON.stringify(before.positions) !== JSON.stringify(after.positions),
    trailCount: after.trailCount
  }

  const airborne = page.locator('.runtime-aircraft-list button[data-aircraft-status="TAKING_OFF"], .runtime-aircraft-list button[data-aircraft-status="OUTBOUND"], .runtime-aircraft-list button[data-aircraft-status="ARRIVED"], .runtime-aircraft-list button[data-aircraft-status="RETURNING"], .runtime-aircraft-list button[data-aircraft-status="LANDING"], .runtime-aircraft-list button[data-aircraft-status="HOLDING"], .runtime-aircraft-list button[data-aircraft-status="DIVERTING"], .runtime-aircraft-list button[data-aircraft-status="EMERGENCY_LANDING"]').first()
  if (await airborne.count()) await airborne.click()
  const follow = page.getByRole("button", { name: "跟随飞行器", exact: true })
  if (await follow.count()) await follow.click()
  if (await rate.locator('option[value="60"]').count()) await rate.selectOption("60")
  await page.waitForTimeout(500)
  const followHeightBefore = Number(await map.getAttribute("data-camera-height-meters"))
  await page.waitForTimeout(2500)
  const followHeightAfter = Number(await map.getAttribute("data-camera-height-meters"))
  result.follow = {
    heightBefore: followHeightBefore,
    heightAfter: followHeightAfter,
    heightStable: Math.abs(followHeightAfter - followHeightBefore) < 0.1,
    selectedAircraftId: await map.getAttribute("data-selected-aircraft-id"),
    followingAircraftId: await map.getAttribute("data-following-aircraft"),
    pressed: await page.locator(".aircraft-follow-toggle").getAttribute("aria-pressed")
  }
  await page.screenshot({ path: screenshotPath, fullPage: true })

  result.passed = result.modes.threeDimensional.modelCount > 0
    && result.modes.twoDimensional.billboardCount > 0
    && result.movement.positionChanged
    && result.movement.trailCount > 0
    && result.follow.selectedAircraftId === result.follow.followingAircraftId
    && result.follow.heightStable
    && modelResponses.some((item) => item.status === 200)
    && errors.length === 0
} finally {
  await context.close()
  await browser.close()
}

await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify({ ...result, outputPath }, null, 2)}\n`)
if (!result.passed) process.exitCode = 1

async function waitForMode(target, mode) {
  await target.waitForFunction((expectedMode) => document.querySelector(".logistics-runtime-map-shell")?.getAttribute("data-static-feature-mode") === expectedMode, mode, { timeout: 15_000 })
  await target.waitForTimeout(700)
}

async function mapDetails(locator) {
  return locator.evaluate((element) => {
    const setup = element.__vueParentComponent?.setupState
    const exposed = element.__vueParentComponent?.exposed
    const viewerValue = exposed?.scaleViewer ?? setup?.scaleViewer
    const sourceValue = exposed?.aircraftSource ?? setup?.aircraftSource
    const viewer = viewerValue?.value ?? viewerValue
    const source = sourceValue?.value ?? sourceValue
    const entities = source?.entities?.values ?? []
    const currentTime = viewer?.clock?.currentTime
    const positions = entities
      .filter((entity) => entity.id.startsWith("runtime-aircraft:"))
      .map((entity) => {
        const value = entity.position?.getValue(currentTime)
        return value ? [entity.id, Math.round(value.x), Math.round(value.y), Math.round(value.z)] : [entity.id]
      })
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
    return {
      visualCount: Number(element.getAttribute("data-aircraft-visual-count") ?? 0),
      trailCount: Number(element.getAttribute("data-aircraft-trail-count") ?? 0),
      modelCount: entities.length > 0
        ? entities.filter((entity) => entity.id.startsWith("runtime-aircraft:") && entity.model).length
        : Number(element.getAttribute("data-aircraft-model-count") ?? 0),
      billboardCount: entities.length > 0
        ? entities.filter((entity) => entity.id.startsWith("runtime-aircraft:") && entity.billboard).length
        : Number(element.getAttribute("data-aircraft-billboard-count") ?? 0),
      trailEntityCount: entities.filter((entity) => entity.id.startsWith("runtime-aircraft-trail:") && entity.polyline).length,
      positions: positions.length > 0 ? positions : (() => {
        try {
          return JSON.parse(element.getAttribute("data-aircraft-pick-points") ?? "[]")
            .map((point) => [point.id, point.x, point.y])
            .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
        } catch {
          return []
        }
      })()
    }
  })
}

function browserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined
  ].filter(Boolean)
  const value = candidates.find((candidate) => existsSync(candidate))
  if (!value) throw new Error("未找到 Chrome；可通过 CHROME_PATH 指定浏览器路径")
  return value
}
