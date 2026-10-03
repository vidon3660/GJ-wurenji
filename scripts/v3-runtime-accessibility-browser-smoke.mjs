import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { chromium } from "playwright-core"

const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")
const outputPath = resolve(process.env.V3_RUNTIME_ACCESSIBILITY_OUTPUT ?? "artifacts/accessibility/v3-runtime-accessibility-browser-latest.json")
const viewportValues = (process.env.V3_RUNTIME_ACCESSIBILITY_VIEWPORTS ?? "390x844,1280x720,1440x900").split(",")
const viewports = viewportValues.map(parseViewport)
const fixturePaths = {
  CITY_SHOW: resolve(process.env.V3_RUNTIME_ACCESSIBILITY_SHOW_FIXTURE ?? "artifacts/runtime-stream/race-fixture.json"),
  CITY_LOGISTICS: resolve(process.env.V3_RUNTIME_ACCESSIBILITY_LOGISTICS_FIXTURE ?? "artifacts/stu013-logistics-alert-browser-fixture-latest.json"),
  VTOL_INSPECTION: resolve(process.env.V3_RUNTIME_ACCESSIBILITY_VTL_FIXTURE ?? "artifacts/runtime-stream/vtl-runtime-active-fixture-current-3000.json")
}
const definitions = {
  CITY_SHOW: { tab: "表演", stage: /表演运行/, workspace: ".show-runtime-workspace" },
  CITY_LOGISTICS: { tab: "物流", stage: /配送运行/, workspace: ".logistics-runtime-workspace" },
  VTOL_INSPECTION: { tab: "巡检", stage: /巡检运行/, workspace: ".vtl-runtime-workspace" }
}
const fixtures = Object.fromEntries(await Promise.all(Object.entries(fixturePaths).map(async ([sceneType, path]) => [sceneType, await readFixture(path, sceneType)])))
const executablePath = browserExecutable()
const browser = await chromium.launch({ executablePath, headless: process.env.HEADLESS !== "false" })
const results = []

try {
  for (const viewport of viewports) {
    for (const [sceneType, definition] of Object.entries(definitions)) {
      results.push(await auditRuntimeWorkspace(sceneType, definition, fixtures[sceneType], viewport))
    }
  }
} finally {
  await browser.close()
}

const failures = results.flatMap((result) => result.issues.map((issue) => `${result.sceneType}/${result.viewport.width}x${result.viewport.height}: ${issue}`))
const report = {
  format: "wurenji-v3-runtime-accessibility-browser-smoke",
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  appUrl,
  results,
  passed: failures.length === 0,
  failures
}
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify({ passed: report.passed, outputPath, failures }, null, 2)}\n`)
if (!report.passed) process.exitCode = 1

async function auditRuntimeWorkspace(sceneType, definition, fixture, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = []
  const failedRequests = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("401 (Unauthorized)")) errors.push(message.text())
  })
  page.on("requestfailed", (request) => {
    if (request.url().includes("/api/")) failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`)
  })

  try {
    await login(page)
    await openRuntimeWorkspace(page, definition, fixture)
    const audit = await auditControls(page, definition.workspace)
    const issues = [
      ...audit.unnamedControls.map((control) => `控件无辅助名称：${control}`),
      ...audit.buttonsWithoutType.map((button) => `按钮缺少 type：${button}`),
      ...(audit.horizontalOverflow ? ["页面出现横向溢出"] : []),
      ...errors.map((error) => `页面错误：${error}`),
      ...failedRequests.map((request) => `网络错误：${request}`)
    ]
    return { sceneType, viewport, projectId: fixture.projectId, ...audit, errors, failedRequests, issues, passed: issues.length === 0 }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const pageText = await page.locator("body").innerText().catch(() => "")
    return {
      sceneType,
      viewport,
      projectId: fixture.projectId,
      controlCount: 0,
      unnamedControls: [],
      buttonsWithoutType: [],
      horizontalOverflow: false,
      documentWidth: 0,
      viewportWidth: viewport.width,
      errors,
      failedRequests,
      issues: [`工作台验收失败：${message}`, `页面状态：${pageText.replace(/\s+/g, " ").slice(-500)}`],
      passed: false
    }
  } finally {
    await context.close()
  }
}

async function login(page) {
  await page.goto(appUrl, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: "学生演示", exact: true }).click()
  await page.locator(".platform-shell").waitFor({ timeout: 15_000 })
  const skip = page.getByRole("button", { name: "跳过引导", exact: true })
  if (await skip.count() && await skip.first().isVisible()) await skip.first().click()
  const internalDataToggle = page.locator(".student-task-toolbar .el-checkbox")
  if (await internalDataToggle.count() && !(await internalDataToggle.first().locator("input").isChecked())) {
    const reloaded = page.waitForResponse((response) => response.url().includes("/v3/my-projects?includeInternalData=true") && response.status() === 200)
    await internalDataToggle.first().click({ force: true })
    await reloaded
  }
}

async function openRuntimeWorkspace(page, definition, fixture) {
  await page.locator(".home-scene-segment button").filter({ hasText: definition.tab }).click()
  const search = page.locator(".student-task-search input")
  await search.waitFor({ timeout: 15_000 })
  await search.fill(fixture.title)
  const projectById = page.locator(`.v3-home-project-list > button[data-project-id="${fixture.projectId}"]`).first()
  const projectByTitle = page.locator(".v3-home-project-list > button").filter({ hasText: fixture.title }).first()
  const project = projectById.or(projectByTitle).first()
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && !await project.count()) {
    const loadMore = page.getByRole("button", { name: /加载更多/ }).first()
    if (await loadMore.count() && await loadMore.isVisible()) {
      await loadMore.click()
      await page.waitForTimeout(100)
      continue
    }
    await page.waitForTimeout(150)
  }
  await project.waitFor({ timeout: 15_000 })
  await project.click()
  await page.locator(".v3-project-shell").waitFor({ timeout: 15_000 })
  await page.locator(".v3-stage-nav > button").filter({ hasText: definition.stage }).click()
  await page.locator(definition.workspace).waitFor({ timeout: 15_000 })
  await page.waitForTimeout(300)
}

async function auditControls(page, workspaceSelector) {
  return page.evaluate((selector) => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"
    }
    const accessibleName = (element) => {
      const explicit = element.getAttribute("aria-label") || element.getAttribute("title")
      if (explicit) return explicit
      const labelledBy = element.getAttribute("aria-labelledby")
      if (labelledBy) {
        const value = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim()
        if (value) return value
      }
      if (element.id) {
        const value = [...document.querySelectorAll("label[for]")].find((label) => label.getAttribute("for") === element.id)?.textContent?.trim()
        if (value) return value
      }
      return element.closest("label")?.textContent?.trim()
        || element.closest(".el-form-item")?.querySelector(".el-form-item__label")?.textContent?.trim()
        || element.textContent?.replace(/\s+/g, " ").trim()
        || ""
    }
    const controls = [...document.querySelectorAll(`${selector} button, ${selector} [role='button'], ${selector} input, ${selector} select, ${selector} textarea`)].filter(visible)
    return {
      controlCount: controls.length,
      unnamedControls: controls.filter((element) => !accessibleName(element)).map((element) => element.outerHTML.slice(0, 180)),
      buttonsWithoutType: controls.filter((element) => element.tagName === "BUTTON" && !element.getAttribute("type")).map((element) => accessibleName(element).slice(0, 80)),
      horizontalOverflow: document.body.scrollWidth > document.body.clientWidth,
      documentWidth: document.body.scrollWidth,
      viewportWidth: document.body.clientWidth
    }
  }, workspaceSelector)
}

async function readFixture(path, sceneType) {
  const raw = JSON.parse(await readFile(path, "utf8"))
  const fixture = raw.projectId && raw.title ? raw : raw.projects?.[sceneType]
  if (!fixture?.projectId || !fixture.title) throw new Error(`${sceneType} 验收夹具无效：${path}`)
  return fixture
}

function parseViewport(value) {
  const match = /^(\d+)x(\d+)$/.exec(value.trim())
  if (!match) throw new Error(`无效视口：${value}`)
  return { width: Number(match[1]), height: Number(match[2]) }
}

function browserExecutable() {
  const candidates = [process.env.CHROME_PATH, process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe` : undefined, process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined, "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean)
  const value = candidates.find((candidate) => existsSync(candidate))
  if (!value) throw new Error("未找到 Chrome，请通过 CHROME_PATH 指定浏览器路径")
  return value
}
