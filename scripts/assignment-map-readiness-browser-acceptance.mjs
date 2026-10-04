import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { chromium } from "playwright-core"

const baseUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")
const outputPath = resolve(process.env.ASSIGNMENT_MAP_READINESS_OUTPUT ?? "artifacts/map-resources/assignment-map-readiness-browser-latest.json")
const screenshotDirectory = resolve(process.env.ASSIGNMENT_MAP_READINESS_SCREENSHOTS ?? "artifacts/map-resources")
const viewportWidth = positiveInteger(process.env.ASSIGNMENT_MAP_READINESS_VIEWPORT_WIDTH, 1440)
const viewportHeight = positiveInteger(process.env.ASSIGNMENT_MAP_READINESS_VIEWPORT_HEIGHT, 900)
const executablePath = browserExecutable()
const scenes = [
  { code: "CITY_SHOW", label: "城市编队表演", requiredTargets: ["scale-template", "region", "show-program", "question-bank", "resource-dependencies", "map-resource", "show-schedule", "scenario-events", "publish-classroom"] },
  { code: "CITY_LOGISTICS", label: "城市低空物流", requiredTargets: ["scale-template", "region", "question-bank", "resource-dependencies", "map-resource", "logistics-candidate-points", "logistics-runtime-schedule", "logistics-order-config", "scenario-events", "publish-classroom"] },
  { code: "VTOL_INSPECTION", label: "垂起广域巡检", requiredTargets: ["scale-template", "region", "question-bank", "resource-dependencies", "map-resource", "vtl-runtime-schedule", "vtl-main-landing-site", "vtl-task-objects", "vtl-task-area", "vtl-open-stages", "vtl-evaluation-items", "scenario-events", "publish-classroom"] }
]

await mkdir(screenshotDirectory, { recursive: true })
const browser = await chromium.launch({ executablePath, headless: process.env.HEADLESS !== "false" })
const results = []

try {
  const context = await browser.newContext({ viewport: { width: viewportWidth, height: viewportHeight }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const pageErrors = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("401 (Unauthorized)")) pageErrors.push(message.text())
  })

  await enterTeacher(page)
  for (const scene of scenes) {
    results.push(await inspectScene(page, scene))
  }

  for (const result of results) result.pageErrors = [...pageErrors]
  await context.close()
} finally {
  await browser.close()
}

const report = {
  format: "wurenji-assignment-map-readiness-browser-acceptance",
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  baseUrl,
  viewport: { width: viewportWidth, height: viewportHeight },
  results,
  passed: results.length === scenes.length && results.every((result) => result.passed && result.pageErrors.length === 0)
}
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify({ passed: report.passed, outputPath, results }, null, 2)}\n`)
if (!report.passed) process.exitCode = 1

async function enterTeacher(page) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" })
  const loginPage = page.locator(".login-page")
  if (await loginPage.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: /^教师演示/ }).first().click()
    const teacherPassword = process.env.DEMO_TEACHER_PASSWORD
    if (!teacherPassword) {
      throw new Error("场景入口验收需要登录教师账号；请设置 DEMO_TEACHER_PASSWORD，或传入已有登录会话")
    }
    await page.locator('input[name="password"]').fill(teacherPassword)
    await page.getByRole("button", { name: "登录平台", exact: true }).click()
  }
  await page.locator(".platform-shell").waitFor({ timeout: 15_000 })
  await page.locator(".platform-shell .el-loading-mask").waitFor({ state: "hidden", timeout: 15_000 })
  const skip = page.getByRole("button", { name: "跳过引导", exact: true })
  if (await skip.count() && await skip.first().isVisible()) await skip.first().click()
}

async function inspectScene(page, scene) {
  const dialog = page.locator(".assignment-wizard")
  await page.getByRole("banner").getByRole("button", { name: "创建 V3 任务", exact: true }).click()
  await dialog.waitFor({ timeout: 15_000 })

  const step0 = dialog.locator(".wizard-panel").first()
  await step0.locator("input").first().fill(`资源门禁验收-${scene.code}`)
  await step0.locator("textarea").nth(0).fill("验证预设教学区域地图资源状态展示。")
  await step0.locator("textarea").nth(1).fill("完成地图资源门禁预览检查。")
  await step0.locator("textarea").nth(2).fill("看到资源状态并确认正式资源未就绪提示。")
  await dialog.locator(".wizard-choice-grid:not(.mode-grid) > button").filter({ hasText: scene.label }).click()
  await page.getByRole("button", { name: "下一步", exact: true }).click()
  const resourceStep = dialog.locator(".wizard-panel").filter({ hasText: "固定规模与预设区域" })
  await resourceStep.waitFor({ timeout: 15_000 })
  const observedTargets = new Set(await collectFocusTargets(resourceStep))
  const nextButton = page.getByRole("button", { name: "下一步", exact: true })
  if (await nextButton.isDisabled()) {
    for (const select of await resourceStep.locator(".el-select").all()) {
      if (!await nextButton.isDisabled()) break
      await select.click()
      await selectVisibleFirstOption(page)
    }
  }
  await nextButton.click()
  const scenarioStep = dialog.locator(".wizard-panel").filter({ hasText: "场景变量与事件" })
  await scenarioStep.waitFor({ timeout: 15_000 })
  for (const target of await collectFocusTargets(scenarioStep)) observedTargets.add(target)

  if (scene.code === "CITY_SHOW") {
    await fillShowContact(dialog)
    const eventButton = dialog.locator(".event-selector > button:not([disabled])").first()
    if (await eventButton.count()) await eventButton.click()
  }
  await page.getByRole("button", { name: "下一步", exact: true }).click()
  await chooseFirstClass(page, dialog)
  const publishStep = dialog.locator(".wizard-panel").filter({ hasText: "发布范围与时间" })
  for (const target of await collectFocusTargets(publishStep)) observedTargets.add(target)
  const preflightResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/v3\/assignments\/drafts\/[^/]+\/preflight$/.test(response.url()), { timeout: 30_000 })
  await page.getByRole("button", { name: "生成预览", exact: true }).click()
  const preflightResponse = await preflightResponsePromise
  const preflightPayload = await preflightResponse.json()
  await dialog.locator(".preview-panel").waitFor({ timeout: 30_000 })
  await dialog.locator(".map-readiness-preview").waitFor({ timeout: 15_000 })

  const panelText = await dialog.locator(".map-readiness-preview").innerText()
  const mapSummaryText = await dialog.locator(".preview-summary").innerText()
  const screenshot = resolve(screenshotDirectory, `assignment-map-readiness-${scene.code.toLowerCase()}.png`)
  await page.screenshot({ path: screenshot, fullPage: true })
  const bodyState = await page.evaluate(() => ({
    noHorizontalOverflow: document.body.scrollWidth <= document.body.clientWidth,
    canvas: Boolean(document.querySelector(".assignment-wizard")),
    readinessPanels: document.querySelectorAll(".map-readiness-preview").length,
    readinessTop: document.querySelector(".map-readiness-preview")?.getBoundingClientRect().top ?? null,
    preflightTop: document.querySelector(".assignment-preflight")?.getBoundingClientRect().top ?? null
  }))
  const warningCheck = dialog.locator(".preflight-check.warning").first()
  const warningCount = await dialog.locator(".preflight-check.warning").count()
  const mapCheck = preflightPayload.checks?.find((check) => check.code === "MAP_RESOURCE") ?? null
  const missingTargets = scene.requiredTargets.filter((target) => !observedTargets.has(target))
  let navigation = { clicked: false, activeStep: "", scrollTop: null, focusTarget: null, focusWithinTarget: false, highlighted: false, targetVisible: false }
  if (warningCount > 0) {
    await warningCheck.click()
    await page.waitForTimeout(450)
    navigation = await dialog.evaluate(() => ({
      clicked: true,
      activeStep: document.querySelector(".wizard-steps li.active strong")?.textContent?.trim() ?? "",
      scrollTop: document.querySelector(".wizard-panel")?.scrollTop ?? null,
      focusTarget: document.querySelector(".preflight-focus-target")?.getAttribute("data-preflight-target") ?? null,
      focusWithinTarget: (() => {
        const target = document.querySelector(".preflight-focus-target")
        return Boolean(target && (target === document.activeElement || target.contains(document.activeElement)))
      })(),
      highlighted: Boolean(document.querySelector(".preflight-focus-target")),
      targetVisible: (() => {
        const panel = document.querySelector(".wizard-panel")
        const target = document.querySelector(".preflight-focus-target")
        if (!panel || !target) return false
        const panelRect = panel.getBoundingClientRect()
        const targetRect = target.getBoundingClientRect()
        return targetRect.bottom > panelRect.top && targetRect.top < panelRect.bottom
      })()
    }))
  }
  const passed = panelText.includes("MAP RESOURCE GATE")
    && /待验收|待配置|校验失败|缺失|已就绪|正式资源就绪/.test(panelText)
    && mapSummaryText.includes("地图资源")
    && bodyState.noHorizontalOverflow
    && bodyState.readinessPanels === 1
    && bodyState.readinessTop !== null
    && bodyState.preflightTop !== null
    && bodyState.readinessTop < bodyState.preflightTop
    && missingTargets.length === 0
    && mapCheck?.step === 1
    && mapCheck?.focusTarget === "map-resource"
    && (warningCount === 0 || (navigation.clicked
      && navigation.activeStep === "模板与区域"
      && navigation.focusTarget === "map-resource"
      && navigation.focusWithinTarget
      && navigation.highlighted
      && navigation.targetVisible))

  await page.getByRole("button", { name: "取消", exact: true }).click()
  await dialog.waitFor({ state: "detached", timeout: 10_000 })
  return { sceneType: scene.code, passed, panelText, mapSummaryText, layout: bodyState, focusTargets: { observed: [...observedTargets].sort(), missing: missingTargets }, mapCheck, navigation, screenshot, pageErrors: [] }
}

async function collectFocusTargets(scope) {
  return scope.locator("[data-preflight-target]").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-preflight-target")).filter(Boolean))
}

async function selectVisibleFirstOption(page) {
  const dropdown = page.locator(".el-select-dropdown:visible")
  await dropdown.waitFor({ state: "visible", timeout: 10_000 })
  const option = dropdown.locator(".el-select-dropdown__item:visible").first()
  await option.waitFor({ state: "visible", timeout: 10_000 })
  await option.click({ force: true })
}

async function fillShowContact(dialog) {
  const formItem = (label) => dialog.getByText(label, { exact: true }).first().locator("..")
  await formItem("联系人").locator("input").fill("验收联系人")
  await formItem("联系电话").locator("input").fill("13800000000")
}

async function chooseFirstClass(page, dialog) {
  const select = dialog.getByText("发布班级", { exact: true }).first().locator("..")
  await select.locator(".el-select").click()
  const option = page.locator(".el-select-dropdown:visible .el-select-dropdown__item:visible").first()
  await option.waitFor({ state: "visible", timeout: 10_000 })
  await option.click({ force: true })
}

function browserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ].filter(Boolean)
  const value = candidates.find((candidate) => existsSync(candidate))
  if (!value) throw new Error("未找到 Chrome；可通过 CHROME_PATH 指定浏览器路径")
  return value
}

function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("资源门禁浏览器验收视口必须为正整数")
  return parsed
}
