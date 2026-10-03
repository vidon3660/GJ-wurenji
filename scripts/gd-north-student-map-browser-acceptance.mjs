import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { chromium } from "playwright-core"

const baseUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")
const artifactDirectory = resolve("artifacts/formal-gd-north")
const outputPath = resolve(artifactDirectory, "student-map-browser-acceptance.json")
const overviewScreenshot = resolve(artifactDirectory, "student-submitted-tasks.png")
const mapScreenshot = resolve(artifactDirectory, "logistics-map-scale-and-elements.png")
const projects = [
  { scene: "表演", id: "33f955ad-5ac1-4ba8-afaf-9711dd9e70a8", title: "广东北部城市无人机编队表演正式教学任务", stage: "区域规划", workspace: ".area-planning-workspace" },
  { scene: "物流", id: "859a6c43-4ae3-45c1-af1b-dd3f45668113", title: "广东北部城市低空物流正式教学任务", stage: "区域分析", workspace: ".logistics-region-workspace" },
  { scene: "巡检", id: "0272fb9f-6925-428b-93e9-654a90cccfd5", title: "广东北部垂起广域巡检正式教学任务", stage: "区域与对象", workspace: ".vtl-planning-workspace" }
]

await mkdir(artifactDirectory, { recursive: true })
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: process.env.HEADLESS !== "false" })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const page = await context.newPage()
const pageErrors = []
const mapResponses = []
page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("401 (Unauthorized)")) pageErrors.push(message.text())
})
page.on("response", (response) => {
  if (response.url().includes("/map/logistics/gd-north-core-")) mapResponses.push({ url: response.url(), status: response.status(), contentType: response.headers()["content-type"] ?? null })
})

const result = { generatedAt: new Date().toISOString(), baseUrl, tasks: [], maps: [], mapResponses, pageErrors, screenshots: { overview: overviewScreenshot, logisticsMap: mapScreenshot, taskPages: {} }, passed: false }
try {
  await enterStudent(page)
  for (const project of projects) {
    await chooseScene(page, project.scene)
    const card = page.locator(`[data-project-id="${project.id}"]`)
    await card.waitFor({ timeout: 15_000 })
    const cardText = (await card.innerText()).replace(/\s+/g, " ").trim()
    const taskScreenshot = resolve(artifactDirectory, `student-submitted-${project.scene === "表演" ? "show" : project.scene === "物流" ? "logistics" : "vtl"}.png`)
    await page.screenshot({ path: taskScreenshot, fullPage: true })
    result.screenshots.taskPages[project.scene] = taskScreenshot
    result.tasks.push({ scene: project.scene, projectId: project.id, title: project.title, cardText, screenshot: taskScreenshot, submittedVisible: cardText.includes("查看提交内容") && cardText.includes("待教师查看") && cardText.includes("复盘评价") })
  }
  await page.screenshot({ path: overviewScreenshot, fullPage: true })

  for (const project of projects) {
    await chooseScene(page, project.scene)
    await page.locator(`[data-project-id="${project.id}"]`).click()
    await page.locator(".v3-project-shell").waitFor({ timeout: 15_000 })
    await page.getByRole("button", { name: new RegExp(`^${project.stage}，`) }).click()
    await page.locator(project.workspace).waitFor({ timeout: 20_000 })
    await page.locator(`${project.workspace} canvas`).first().waitFor({ timeout: 20_000 })
    const scaleBar = page.locator(`${project.workspace} .v3-map-scale-bar strong`).first()
    await scaleBar.waitFor({ timeout: 20_000 })
    await page.waitForTimeout(700)
    const initialLabel = await stableScaleLabel(scaleBar)
    const zoomLabels = []
    for (let index = 0; index < 4; index += 1) {
      await page.locator(`${project.workspace} [aria-label="放大地图"]`).click()
      zoomLabels.push(await changedScaleLabel(scaleBar, zoomLabels.at(-1) ?? initialLabel))
    }
    const zoomedLabel = zoomLabels.at(-1)
    await page.waitForTimeout(1400)
    const stableLabel = (await scaleBar.innerText()).trim()
    const mapResult = {
      scene: project.scene,
      projectId: project.id,
      initialLabel,
      zoomLabels,
      stableLabel,
      initialMeters: scaleMeters(initialLabel),
      zoomedMeters: scaleMeters(zoomedLabel),
      stableMeters: scaleMeters(stableLabel),
      noZoomRebound: scaleMeters(stableLabel) <= scaleMeters(zoomedLabel),
      defaultNear200m: scaleMeters(initialLabel) >= 100 && scaleMeters(initialLabel) <= 500,
      elementFocus: null
    }
    if (project.scene === "物流") {
      const element = page.locator(`${project.workspace} .region-elements-list button:not([disabled])`).first()
      await element.waitFor({ timeout: 10_000 })
      const beforeLabel = stableLabel
      await element.click()
      await page.waitForTimeout(700)
      const afterLabel = (await scaleBar.innerText()).trim()
      mapResult.elementFocus = { name: (await element.innerText()).replace(/\s+/g, " ").trim(), beforeLabel, afterLabel, preservesScale: scaleMeters(afterLabel) === scaleMeters(beforeLabel) }
      await page.screenshot({ path: mapScreenshot, fullPage: true })
    }
    result.maps.push(mapResult)
    await page.getByRole("button", { name: "返回教学首页", exact: true }).click()
    await page.locator(".platform-shell").waitFor({ timeout: 15_000 })
  }
  result.passed = result.tasks.every((item) => item.submittedVisible)
    && result.maps.every((item) => item.defaultNear200m && item.zoomedMeters < item.initialMeters && item.noZoomRebound)
    && result.maps.find((item) => item.scene === "物流")?.elementFocus?.preservesScale === true
    && mapResponses.some((item) => item.url.endsWith("gd-north-core-orthophoto.jpg") && item.status === 200)
    && mapResponses.some((item) => item.url.endsWith("gd-north-core-buildings.geojson") && item.status === 200)
    && pageErrors.length === 0
} finally {
  await context.close()
  await browser.close()
}

await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify({ passed: result.passed, outputPath, tasks: result.tasks, maps: result.maps, mapResponses: result.mapResponses, pageErrors: result.pageErrors }, null, 2)}\n`)
if (!result.passed) process.exitCode = 1

async function enterStudent(target) {
  await target.goto(baseUrl, { waitUntil: "domcontentloaded" })
  await target.getByRole("button", { name: "学生演示", exact: true }).click()
  await target.locator(".platform-shell").waitFor({ timeout: 15_000 })
  await target.locator(".platform-shell .el-loading-mask").waitFor({ state: "hidden", timeout: 15_000 })
  const skip = target.getByRole("button", { name: "跳过引导", exact: true })
  if (await skip.count() && await skip.first().isVisible()) await skip.first().click()
}

async function chooseScene(target, scene) {
  const button = target.locator(".home-scene-segment button").filter({ hasText: scene })
  await button.click()
  await target.locator(".platform-shell .el-loading-mask").waitFor({ state: "hidden", timeout: 15_000 })
}

async function stableScaleLabel(locator) {
  let value = ""
  let stableCount = 0
  for (let index = 0; index < 80; index += 1) {
    await locator.page().waitForTimeout(100)
    const next = (await locator.innerText()).trim()
    if (scaleMeters(next) > 0 && scaleMeters(next) <= 500 && next === value) stableCount += 1
    else stableCount = 0
    if (stableCount >= 2) return next
    value = next
  }
  throw new Error(`地图初始比例尺未稳定到核心区域：${value}`)
}

async function changedScaleLabel(locator, previous) {
  for (let index = 0; index < 20; index += 1) {
    await locator.page().waitForTimeout(100)
    const value = (await locator.innerText()).trim()
    if (value !== previous && /m|km/.test(value)) return value
  }
  return (await locator.innerText()).trim()
}

function scaleMeters(label) {
  const match = label.match(/([\d.]+)\s*(km|m)/i)
  if (!match) return Number.NaN
  return Number(match[1]) * (match[2].toLowerCase() === "km" ? 1000 : 1)
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
