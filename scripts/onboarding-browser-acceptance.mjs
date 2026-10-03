import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import pg from "pg"
import { chromium } from "playwright-core"

const baseUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")
const databaseUrl = process.env.ONBOARDING_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://wurenji@localhost:55432/wurenji"
const outputPath = resolve(process.env.ONBOARDING_OUTPUT ?? "artifacts/onboarding/onboarding-browser-acceptance-latest.json")
const screenshotDirectory = resolve(process.env.ONBOARDING_SCREENSHOTS ?? "artifacts/onboarding")
const fixture = await readFixture()
const viewports = [
  { name: "desktop", width: 1366, height: 768 },
  { name: "narrow", width: 390, height: 844 }
]

await mkdir(dirname(outputPath), { recursive: true })
await mkdir(screenshotDirectory, { recursive: true })

const browser = await chromium.launch({ executablePath: browserExecutable(), headless: process.env.HEADLESS !== "false" })
const results = []

try {
  for (const viewport of viewports) {
    results.push(await inspectTeacher(viewport))
    results.push(await inspectStudent(viewport))
  }
} finally {
  await browser.close()
}

const report = {
  format: "wurenji-onboarding-browser-acceptance",
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  baseUrl,
  fixture,
  results,
  passed: results.length === viewports.length * 2 && results.every((result) => result.passed)
}
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify({ passed: report.passed, outputPath, results }, null, 2)}\n`)
if (!report.passed) process.exitCode = 1

async function inspectTeacher(viewport) {
  await resetOnboarding("teacher@demo.local", "teacher-basics")
  const errors = []
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
  const page = await context.newPage()
  collectPageErrors(page, errors)
  const guideScreenshot = resolve(screenshotDirectory, `teacher-guide-${viewport.name}.png`)
  const missionScreenshot = resolve(screenshotDirectory, `teacher-mission-${viewport.name}.png`)
  const replayScreenshot = resolve(screenshotDirectory, `teacher-replay-${viewport.name}.png`)

  try {
    await loginDemo(page, "教师演示")
    const guide = page.locator(".onboarding-dialog")
    await guide.waitFor({ timeout: 15_000 })
    const initialState = await inspectGuide(page, guide)
    await page.screenshot({ path: guideScreenshot, fullPage: true })

    await guide.locator("nav button").nth(1).click()
    const deferredStep = (await guide.locator("h2").innerText()).trim()
    await guide.getByRole("button", { name: "稍后继续", exact: true }).click()
    await guide.waitFor({ state: "detached", timeout: 10_000 })
    await page.getByRole("button", { name: "重新播放引导", exact: true }).click()
    await guide.waitFor({ timeout: 10_000 })
    const restoredStep = (await guide.locator("h2").innerText()).trim()

    await guide.locator("nav button").first().click()
    await guide.locator(".onboarding-scene-picker button").filter({ hasText: "城市物流" }).click()
    await guide.locator("nav button").nth(3).click()
    await guide.getByRole("button", { name: "选择区域并开始配置", exact: true }).click()
    const mission = page.locator('[data-onboarding-mission="teacher-first-assignment"]')
    await mission.waitFor({ timeout: 10_000 })
    const missionLayout = await inspectMission(page, mission)
    const activeScene = await page.locator(".scene-segment button[aria-pressed='true']").first().innerText()
    await page.screenshot({ path: missionScreenshot, fullPage: true })

    const completionResponsePromise = waitForCompletion(page, "teacher-basics")
    await page.getByRole("button", { name: "用此区域创建任务", exact: true }).click()
    await page.locator(".v3-assignment-dialog").waitFor({ timeout: 15_000 })
    const completionResponse = await completionResponsePromise
    const completionPayload = await completionResponse.json()
    await mission.waitFor({ state: "detached", timeout: 10_000 })
    const serverState = await onboardingState(page)
  
    await context.close()
    const replay = await verifyCompletedLogin(viewport, "教师演示", "teacher-basics", replayScreenshot, errors)
    const passed = initialState.visible
      && initialState.layoutFits
      && initialState.focusInside
      && deferredStep === "核对教学区域"
      && restoredStep === deferredStep
      && activeScene.includes("物流")
      && missionLayout.visible
      && missionLayout.layoutFits
      && completionResponse.ok()
      && completionPayload.completed === true
      && completionPayload.skipped === false
      && completionPayload.version === 2
      && serverState.completed === true
      && serverState.skipped === false
      && replay.noAutomaticDialog
      && replay.helpReplayVisible
      && replay.layoutFits
      && replay.focusInside
      && replay.skipCompleted
      && errors.length === 0
    return {
      role: "teacher",
      viewport,
      passed,
      initialState,
      deferredStep,
      restoredStep,
      activeScene,
      missionLayout,
      completionStatus: completionResponse.status(),
      completionPayload,
      serverState,
      replay,
      errors,
      screenshots: { guide: guideScreenshot, mission: missionScreenshot, replay: replayScreenshot }
    }
  } finally {
    if (!isClosed(context)) await context.close()
  }
}

async function inspectStudent(viewport) {
  await resetOnboarding("student@demo.local", "student-basics")
  const errors = []
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
  const page = await context.newPage()
  collectPageErrors(page, errors)
  const guideScreenshot = resolve(screenshotDirectory, `student-guide-${viewport.name}.png`)
  const missionScreenshot = resolve(screenshotDirectory, `student-mission-${viewport.name}.png`)
  const replayScreenshot = resolve(screenshotDirectory, `student-replay-${viewport.name}.png`)

  try {
    await loginDemo(page, "学生演示")
    const guide = page.locator(".onboarding-dialog")
    await guide.waitFor({ timeout: 15_000 })
    const initialState = await inspectGuide(page, guide)
    await page.screenshot({ path: guideScreenshot, fullPage: true })
    await guide.locator("nav button").nth(3).click()
    await guide.getByRole("button", { name: "进入实训并开始操作", exact: true }).click()
    const mission = page.locator('[data-onboarding-mission="student-first-stage"]')
    await mission.waitFor({ timeout: 10_000 })
    const missionLayout = await inspectMission(page, mission)

    const workspace = page.locator(".v3-project-shell")
    const destination = await waitForStudentDestination(page, workspace)
    if (destination === "home") {
      await openStudentFixture(page)
      await workspace.waitFor({ timeout: 15_000 })
    }
    let action = await studentCompletionAction(page)
    if (!action) {
      await page.getByRole("button", { name: "返回教学首页", exact: true }).click()
      await page.locator(".home-scene-segment").waitFor({ timeout: 15_000 })
      await openStudentFixture(page)
      await workspace.waitFor({ timeout: 15_000 })
      action = await studentCompletionAction(page)
    }
    if (!action) throw new Error("当前学生实训没有可执行的阶段启动或仿真运行操作")
    await page.screenshot({ path: missionScreenshot, fullPage: true })

    const completionResponsePromise = waitForCompletion(page, "student-basics")
    await action.click()
    const completionResponse = await completionResponsePromise
    const completionPayload = await completionResponse.json()
    await mission.waitFor({ state: "detached", timeout: 10_000 })
    const serverState = await onboardingState(page)

    await context.close()
    const replay = await verifyCompletedLogin(viewport, "学生演示", "student-basics", replayScreenshot, errors)
    const passed = initialState.visible
      && initialState.layoutFits
      && initialState.focusInside
      && missionLayout.visible
      && missionLayout.layoutFits
      && completionResponse.ok()
      && completionPayload.completed === true
      && completionPayload.skipped === false
      && completionPayload.version === 2
      && serverState.completed === true
      && serverState.skipped === false
      && replay.noAutomaticDialog
      && replay.helpReplayVisible
      && replay.layoutFits
      && replay.focusInside
      && replay.skipCompleted
      && errors.length === 0
    return {
      role: "student",
      viewport,
      passed,
      initialState,
      missionLayout,
      completionStatus: completionResponse.status(),
      completionPayload,
      serverState,
      replay,
      errors,
      screenshots: { guide: guideScreenshot, mission: missionScreenshot, replay: replayScreenshot }
    }
  } finally {
    if (!isClosed(context)) await context.close()
  }
}

async function loginDemo(page, label) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: label, exact: true }).click()
  await page.locator(".platform-shell").waitFor({ timeout: 15_000 })
  await page.locator(".platform-shell .el-loading-mask").waitFor({ state: "hidden", timeout: 15_000 })
}

async function verifyCompletedLogin(viewport, loginLabel, guideKey, screenshot, errors) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
  const page = await context.newPage()
  collectPageErrors(page, errors)
  try {
    await loginDemo(page, loginLabel)
    await page.waitForTimeout(500)
    const guide = page.locator(".onboarding-dialog")
    const noAutomaticDialog = !(await guide.count()) || !(await guide.isVisible())
    await page.getByRole("button", { name: "重新播放引导", exact: true }).click()
    await guide.waitFor({ timeout: 10_000 })
    const state = await inspectGuide(page, guide)
    await page.screenshot({ path: screenshot, fullPage: true })
    const skipResponsePromise = waitForCompletion(page, guideKey)
    await guide.getByRole("button", { name: "跳过引导", exact: true }).click()
    const skipResponse = await skipResponsePromise
    const skipPayload = await skipResponse.json()
    const skippedState = await onboardingState(page)
    return {
      noAutomaticDialog,
      helpReplayVisible: state.visible,
      layoutFits: state.layoutFits,
      focusInside: state.focusInside,
      skipCompleted: skipResponse.ok()
        && skipPayload.completed === true
        && skipPayload.skipped === true
        && skipPayload.version === 2
        && skippedState.skipped === true
    }
  } finally {
    await context.close()
  }
}

async function openStudentFixture(page) {
  await page.locator(".home-scene-segment").waitFor({ timeout: 15_000 })
  const logisticsScene = page.locator(".home-scene-segment button").filter({ hasText: "物流" })
  await logisticsScene.click()
  const checkbox = page.locator(".student-task-toolbar .el-checkbox").first()
  if (!(await checkbox.locator("input").isChecked())) await checkbox.click()
  const search = page.locator(".student-task-search input")
  await search.fill(fixture.title)
  const project = page.locator(".v3-home-project-list > button").filter({ hasText: fixture.title })
  await project.waitFor({ timeout: 15_000 })
  await project.click()
}

async function waitForStudentDestination(page, workspace) {
  return Promise.race([
    workspace.waitFor({ timeout: 15_000 }).then(() => "workspace"),
    page.locator(".home-scene-segment").waitFor({ timeout: 15_000 }).then(() => "home")
  ])
}

async function studentCompletionAction(page) {
  const simulation = page.locator(".simulation-command:not(.locked)")
  if (await simulation.count() && await simulation.first().isVisible()) return simulation.first()
  const stageAction = page.getByRole("button", { name: /^(开始|恢复).*阶段$/ }).first()
  if (await stageAction.count() && await stageAction.isVisible()) return stageAction
  return null
}

async function inspectGuide(page, guide) {
  await page.waitForTimeout(400)
  const box = await guide.boundingBox()
  const footer = await guide.locator("footer").boundingBox()
  const viewport = page.viewportSize()
  const noHorizontalOverflow = await page.evaluate(() => document.body.scrollWidth <= document.body.clientWidth)
  const focusInside = await guide.evaluate((element) => element.contains(document.activeElement))
  return {
    visible: Boolean(box),
    currentStep: (await guide.locator("h2").innerText()).trim(),
    box,
    footer,
    viewport,
    noHorizontalOverflow,
    focusInside,
    layoutFits: Boolean(box && footer)
      && box.x >= 0
      && box.y >= 0
      && box.x + box.width <= viewport.width
      && box.y + box.height <= viewport.height
      && footer.x >= box.x
      && footer.x + footer.width <= box.x + box.width
      && noHorizontalOverflow
  }
}

async function inspectMission(page, mission) {
  const box = await mission.boundingBox()
  return {
    visible: Boolean(box),
    text: (await mission.innerText()).trim(),
    layoutFits: Boolean(box)
      && box.x >= 0
      && box.y >= 0
      && box.x + box.width <= page.viewportSize().width
      && box.y + box.height <= page.viewportSize().height
      && await page.evaluate(() => document.body.scrollWidth <= document.body.clientWidth)
  }
}

function waitForCompletion(page, guideKey) {
  return page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/api/v1/education/onboarding/${guideKey}/complete`), { timeout: 15_000 })
}

function onboardingState(page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/education/onboarding", { credentials: "include" })
    if (!response.ok) throw new Error(`读取引导状态失败：${response.status}`)
    return response.json()
  })
}

async function resetOnboarding(email, guideKey) {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await client.query(`
      DELETE FROM "onboarding_states" AS state
      USING "users" AS account
      WHERE state."userId" = account.id
        AND lower(account.email) = lower($1)
        AND state."guideKey" = $2
        AND state.version = 2
    `, [email, guideKey])
  } finally {
    await client.end()
  }
}

function collectPageErrors(page, errors) {
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("401 (Unauthorized)")) errors.push(message.text())
  })
  page.on("response", (response) => {
    if (response.status() >= 400 && !response.url().endsWith("/api/auth/me")) errors.push(`${response.status()} ${response.url()}`)
  })
}

async function readFixture() {
  const path = resolve(process.env.ONBOARDING_STUDENT_FIXTURE ?? "artifacts/v5-20-responsive-logistics-fixture.json")
  const value = JSON.parse(await readFile(path, "utf8"))
  if (!value.projectId || !value.title) throw new Error(`学生验收夹具无效：${path}`)
  return { path, projectId: value.projectId, title: value.title }
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

function isClosed(context) {
  return context.pages().every((page) => page.isClosed())
}
