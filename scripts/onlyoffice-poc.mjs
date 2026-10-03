import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { chromium } from "playwright-core"

const baseUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")
const origin = new URL(baseUrl).origin
const email = process.env.POC_EMAIL ?? "student@demo.local"
const password = process.env.POC_PASSWORD ?? process.env.DEMO_STUDENT_PASSWORD ?? ""
const requestedProjectId = process.env.POC_PROJECT_ID?.trim()
const outputDirectory = process.env.POC_OUTPUT_DIR ?? "artifacts/onlyoffice-poc"
const editRequested = process.env.POC_EDIT === "true"
const executablePath = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium"
].filter(Boolean).find((candidate) => existsSync(candidate))

if (!executablePath) throw new Error("未找到 Chrome；可通过 CHROME_PATH 指定浏览器路径")
await mkdir(outputDirectory, { recursive: true })

const cookie = await login()
const project = await findProject(cookie)
const workspace = await request(`/api/v3/show-projects/${project.id}/documents`, { cookie })
if (!Array.isArray(workspace.documents) || workspace.documents.length !== 3) throw new Error(`项目文档数量不是 3：${JSON.stringify(workspace.documents)}`)

const browser = await chromium.launch({ executablePath, headless: process.env.HEADLESS !== "false" })
const results = []
try {
  for (const document of workspace.documents) results.push(await openDocument(browser, cookie, project, document, editRequested && workspace.canEdit && results.length === 0))
} finally {
  await browser.close()
}

process.stdout.write(`${JSON.stringify({
  project: { id: project.id, title: project.title, canEdit: workspace.canEdit },
  editorPublicUrl: workspace.editorPublicUrl,
  documents: results,
  editableSaveTest: editRequested && workspace.canEdit ? "ATTEMPTED_FIRST_DOCUMENT" : "NOT_RUN_PROJECT_READ_ONLY"
}, null, 2)}\n`)

async function login() {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  })
  if (!response.ok) throw new Error(`登录失败：${response.status} ${await response.text()}`)
  const setCookie = response.headers.get("set-cookie")
  if (!setCookie) throw new Error("登录响应缺少会话 Cookie")
  return setCookie.split(";", 1)[0]
}

async function findProject(cookie) {
  if (requestedProjectId) return { id: requestedProjectId, title: requestedProjectId }
  const projects = await request("/api/v3/my-projects", { cookie })
  const candidate = projects.find((item) => item.sceneType === "CITY_SHOW" && item.currentStageCode === "SHOW_FLIGHT_APPLICATION")
  if (!candidate) throw new Error("没有找到处于飞行申报阶段的城市表演项目；请设置 POC_PROJECT_ID")
  return candidate
}

async function openDocument(browser, cookie, project, document, edit) {
  const editor = await request(`/api/v3/show-projects/${project.id}/documents/${document.id}/editor-session`, { method: "POST", cookie })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const pageErrors = []
  const consoleErrors = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()) })
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" })
  await page.evaluate(() => { document.body.innerHTML = '<main id="onlyoffice-poc" style="width: 100vw; height: 100vh"></main>' })
  await page.addScriptTag({ url: editor.publicApiUrl })
  await page.evaluate((config) => {
    window.__onlyOfficeReady = false
    window.__onlyOfficeError = null
    window.__onlyOfficeModified = false
    window.__onlyOfficeEditor = new window.DocsAPI.DocEditor("onlyoffice-poc", {
      ...config,
      events: {
        onDocumentReady: () => { window.__onlyOfficeReady = true },
        onDocumentStateChange: (event) => { window.__onlyOfficeModified = Boolean(event?.data) },
        onError: (event) => { window.__onlyOfficeError = JSON.stringify(event) }
      }
    })
  }, editor.config)
  await page.waitForFunction(() => window.__onlyOfficeReady === true || window.__onlyOfficeError !== null, null, { timeout: 90_000 })
  const state = await page.evaluate(() => ({ ready: window.__onlyOfficeReady, error: window.__onlyOfficeError, iframeCount: document.querySelectorAll("iframe").length }))
  if (!state.ready) throw new Error(`ONLYOFFICE 文档打开失败：${document.filename} ${state.error ?? "未知错误"}`)
  let modified = false
  if (edit) {
    const frame = page.locator("iframe").first()
    await frame.click({ position: { x: 520, y: 520 } })
    await page.keyboard.press("Control+End")
    await page.keyboard.press("Enter")
    await page.keyboard.type("ONLYOFFICE PoC 保存验证")
    await page.keyboard.press("Control+S")
    await page.waitForTimeout(5_000)
    modified = await page.evaluate(() => window.__onlyOfficeModified)
  }
  const screenshot = `${outputDirectory}/${safeFilename(document.filename)}.png`
  await page.screenshot({ path: screenshot, fullPage: true })
  await page.evaluate(() => window.__onlyOfficeEditor?.destroyEditor())
  await page.waitForTimeout(edit ? 5_000 : 500)
  const refreshedWorkspace = edit ? await request(`/api/v3/show-projects/${project.id}/documents`, { cookie }) : null
  const refreshedDocument = refreshedWorkspace?.documents?.find((item) => item.id === document.id)
  await context.close()
  return {
    id: document.id,
    filename: document.filename,
    sizeBytes: document.currentAsset?.sizeBytes ?? null,
    ready: state.ready,
    iframeCount: state.iframeCount,
    editAttempted: edit,
    modified,
    revisionAfterSave: refreshedDocument?.revision ?? null,
    sha256AfterSave: refreshedDocument?.currentAsset?.sha256 ?? null,
    pageErrors,
    consoleErrors,
    screenshot
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: { Origin: origin, Cookie: options.cookie, ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path} 失败：${response.status} ${body}`)
  try { return JSON.parse(body) } catch { return body }
}

function safeFilename(value) {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\.docx$/i, "")
}
