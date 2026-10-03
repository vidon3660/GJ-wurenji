import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { chromium } from "playwright-core"
import yauzl from "yauzl"

const baseUrl = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "")
const origin = process.env.WEB_ORIGIN?.split(",")[0]?.trim() || baseUrl
const outputPath = resolve(argument("output") ?? `artifacts/document-acceptance/document-acceptance-${timestamp()}.json`)
const outputDirectory = resolve(process.env.DOCUMENT_ACCEPTANCE_OUTPUT_DIR ?? dirname(outputPath))
const editableProjectId = process.env.DOCUMENT_ACCEPTANCE_PROJECT_ID?.trim() || ""
const reportProjectId = process.env.DOCUMENT_ACCEPTANCE_REPORT_PROJECT_ID?.trim() || ""
const markerPrefix = process.env.DOCUMENT_ACCEPTANCE_MARKER?.trim() || `文档验收-${timestamp()}`
const callbackTimeoutMs = positiveInteger(process.env.DOCUMENT_ACCEPTANCE_CALLBACK_TIMEOUT_MS, 45_000)
let executablePath = null
const editableDocumentStatuses = new Set(["NOT_STARTED", "EDITING", "RETURNED"])
const fullToolTemplateCode = "AIRSPACE_APPLICATION_FORM"
const requiredEditorTools = ["TEXT_INPUT", "TABLE_CELL_EDIT", "COPY_PASTE", "UNDO_REDO", "BASIC_FORMATTING", "AUTO_SAVE", "MANUAL_SAVE"]
const restoreOriginalDocuments = process.env.DOCUMENT_ACCEPTANCE_RESTORE !== "false"
const skipReportAcceptance = process.env.DOCUMENT_ACCEPTANCE_SKIP_REPORT === "true"

async function main() {
executablePath = browserExecutable()
await mkdir(outputDirectory, { recursive: true })
const student = await login(process.env.DOCUMENT_ACCEPTANCE_STUDENT_EMAIL ?? "student@demo.local", process.env.DOCUMENT_ACCEPTANCE_STUDENT_PASSWORD ?? process.env.DEMO_STUDENT_PASSWORD ?? "")
const teacher = await login(process.env.DOCUMENT_ACCEPTANCE_TEACHER_EMAIL ?? "teacher@demo.local", process.env.DOCUMENT_ACCEPTANCE_TEACHER_PASSWORD ?? process.env.DEMO_TEACHER_PASSWORD ?? "")
const project = await selectEditableProject(student.cookie)
let workspace = await request(`/api/v3/show-projects/${project.id}/documents`, { cookie: student.cookie })
if (!workspace.canEdit) throw new Error(`项目 ${project.id} 的飞行申报材料不可编辑`)
if (!Array.isArray(workspace.documents) || workspace.documents.length !== 3) throw new Error(`项目文档数量不是 3：${workspace.documents?.length ?? 0}`)
if (workspace.documents.some((document) => !editableDocumentStatuses.has(document.status))) throw new Error("验收项目包含已提交材料，拒绝自动编辑")

const editorReadiness = await verifyEditorReadiness(student.cookie, project.id, workspace.documents[0])
if (!editorReadiness.ready) {
  const blockedReport = {
    format: "wurenji-document-acceptance",
    formatVersion: 3,
    verifiedAt: new Date().toISOString(),
    environment: { baseUrl, executablePath },
    editableProject: { id: project.id, title: project.title },
    editorReadiness,
    documents: [],
    report: null,
    checks: { onlyOfficeAvailable: false },
    summary: { passed: false, blocked: true, blocker: "ONLYOFFICE_UNAVAILABLE", failedChecks: ["onlyOfficeAvailable"] }
  }
  await writeFile(outputPath, `${JSON.stringify(blockedReport, null, 2)}\n`, "utf8")
  process.stderr.write(`OnlyOffice 不可用：${editorReadiness.message}\nReport ${outputPath}\n`)
  process.exitCode = 2
} else {

const browser = await chromium.launch({ executablePath, headless: process.env.HEADLESS !== "false" })
const browserVersion = browser.version()
const documentResults = []
try {
  for (const document of workspace.documents) {
    const marker = `${markerPrefix}-${document.templateCode}`
    const result = await editAndVerifyDocument(browser, student.cookie, project, document, marker)
    documentResults.push(result)
    workspace = await request(`/api/v3/show-projects/${project.id}/documents`, { cookie: student.cookie })
  }
} finally {
  await browser.close()
}

let reportResult = null
let reportBlocker = null
if (!skipReportAcceptance) {
  try {
    reportResult = await verifyReports(teacher.cookie)
  } catch (error) {
    reportBlocker = { code: "REPORT_PROJECT_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) }
  }
}
const report = {
  format: "wurenji-document-acceptance",
  formatVersion: 2,
  verifiedAt: new Date().toISOString(),
  environment: { baseUrl, browser: browserVersion, executablePath },
  editableProject: { id: project.id, title: project.title },
  markerPrefix,
  documents: documentResults,
  report: reportResult,
  reportBlocker
}
report.checks = {
  allDocumentsOpened: documentResults.every((item) => item.opened && item.reopened),
  allDocumentsModified: documentResults.every((item) => item.modifiedEver),
  allDocumentsSaved: documentResults.every((item) => item.revisionAfterSave > item.revisionBefore && item.sha256AfterSave !== item.sha256Before),
  allMarkersPersisted: documentResults.every((item) => item.markerPersisted),
  allDownloadsValid: documentResults.every((item) => item.docx.valid),
  editorCapabilityContractComplete: documentResults.every((item) => requiredEditorTools.every((tool) => item.capabilities?.tools?.includes(tool))),
  fullEditorToolChainVerified: documentResults.find((item) => item.templateCode === fullToolTemplateCode)?.toolAcceptance?.passed === true,
  originalDocumentsRestored: !restoreOriginalDocuments || documentResults.every((item) => item.restoration?.restored === true),
  noBrowserErrors: documentResults.every((item) => item.pageErrors.length === 0 && item.consoleErrors.length === 0 && item.reopenPageErrors.length === 0 && item.reopenConsoleErrors.length === 0),
  reportDocxValid: skipReportAcceptance || reportResult?.docx.valid === true,
  reportPdfValid: skipReportAcceptance || reportResult?.pdf.valid === true
}
report.checks.reportProjectAvailable = skipReportAcceptance || reportBlocker === null
report.summary = { passed: Object.values(report.checks).every(Boolean), blocked: reportBlocker !== null, blocker: reportBlocker?.code ?? null, failedChecks: Object.entries(report.checks).filter(([, passed]) => !passed).map(([name]) => name) }

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify(report.summary)}\nProject ${project.id}\nReport ${outputPath}\n`)
if (!report.summary.passed) process.exitCode = 1
}

}

try {
  await main()
} catch (error) {
  const blockedReport = {
    format: "wurenji-document-acceptance",
    formatVersion: 3,
    verifiedAt: new Date().toISOString(),
    environment: { baseUrl, executablePath },
    editorReadiness: null,
    documents: [],
    report: null,
    checks: { applicationAvailable: false },
    summary: { passed: false, blocked: true, blocker: "APPLICATION_UNAVAILABLE", failedChecks: ["applicationAvailable"] },
    reason: error instanceof Error ? error.message : String(error)
  }
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(blockedReport, null, 2)}\n`, "utf8")
  process.stderr.write(`文档验收环境不可用：${blockedReport.reason}\nReport ${outputPath}\n`)
  process.exitCode = 2
}

async function verifyEditorReadiness(cookie, projectId, document) {
  let publicApiUrl = null
  try {
    const session = await request(`/api/v3/show-projects/${projectId}/documents/${document.id}/editor-session`, { method: "POST", cookie })
    publicApiUrl = session.publicApiUrl
    const response = await fetch(publicApiUrl, { signal: AbortSignal.timeout(5_000) })
    if (!response.ok) return { ready: false, publicApiUrl, status: response.status, message: `编辑器脚本返回 HTTP ${response.status}` }
    return { ready: true, publicApiUrl, status: response.status }
  } catch (error) {
    return { ready: false, publicApiUrl, status: null, message: error instanceof Error ? error.message : String(error) }
  }
}

async function editAndVerifyDocument(browserInstance, cookie, selectedProject, document, marker) {
  const screenshotBase = safeFilename(`${document.templateCode}-${document.filename.replace(/\.docx$/i, "")}`)
  const beforeRevision = document.revision
  const beforeSha256 = document.currentAsset?.sha256 ?? null
  const original = await download(document.currentAsset.downloadPath, cookie)
  const editSession = await request(`/api/v3/show-projects/${selectedProject.id}/documents/${document.id}/editor-session`, { method: "POST", cookie })
  const context = await browserInstance.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  await context.addCookies([browserCookie(cookie)])
  const page = await context.newPage()
  const pageErrors = []
  const consoleErrors = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()) })
  let restoration = null
  try {
    await openEditor(page, editSession)
    const openedScreenshot = resolve(outputDirectory, `${screenshotBase}-opened.png`)
    await page.screenshot({ path: openedScreenshot, fullPage: true })
    const frame = page.locator("iframe").first()
    const toolMarkers = document.templateCode === fullToolTemplateCode ? {
      text: marker,
      table: `${marker}-TABLE-CELL`,
      copy: `${marker}-COPY-PASTE`,
      undoRedo: `${marker}-UNDO-REDO`,
      formatting: `${marker}-BOLD`,
      manualSave: `${marker}-MANUAL-SAVE`
    } : null
    let autoSaveEvidence = null
    const editedScreenshot = resolve(outputDirectory, `${screenshotBase}-edited.png`)
    if (toolMarkers) {
      await exerciseEditorTools(page, frame, toolMarkers)
      autoSaveEvidence = await waitForAutoSave(page)
      await page.screenshot({ path: editedScreenshot, fullPage: true })
      await page.evaluate(() => window.__onlyOfficeEditor?.destroyEditor())
      const afterAutoSave = await pollDocument(cookie, selectedProject.id, document.id, (current) => current.revision > beforeRevision && current.currentAsset?.sha256 !== beforeSha256)
      autoSaveEvidence.revisionBefore = beforeRevision
      autoSaveEvidence.revisionAfter = afterAutoSave.revision
      autoSaveEvidence.sha256Before = beforeSha256
      autoSaveEvidence.sha256After = afterAutoSave.currentAsset?.sha256 ?? null
    } else {
      await frame.click({ position: { x: 520, y: 520 } })
      await page.keyboard.press("Control+End")
      await page.keyboard.press("Enter")
      await page.keyboard.type(marker)
      await waitForAutoSave(page)
      await page.screenshot({ path: editedScreenshot, fullPage: true })
      await page.evaluate(() => window.__onlyOfficeEditor?.destroyEditor())
    }
    const modifiedEver = await page.evaluate(() => Boolean(window.__onlyOfficeModifiedEver))

    const afterFirstSave = await pollDocument(cookie, selectedProject.id, document.id, (current) => current.revision > beforeRevision && current.currentAsset?.sha256 !== beforeSha256)
    const revisionBeforeManualSave = afterFirstSave.revision
    const sha256BeforeManualSave = afterFirstSave.currentAsset?.sha256 ?? null
    const manualSession = await request(`/api/v3/show-projects/${selectedProject.id}/documents/${document.id}/editor-session`, { method: "POST", cookie })
    const manualPage = await context.newPage()
    manualPage.on("pageerror", (error) => pageErrors.push(error.message))
    manualPage.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()) })
    await openEditor(manualPage, manualSession)
    const manualFrame = manualPage.locator("iframe").first()
    await manualFrame.click({ position: { x: 520, y: 520 } })
    await manualPage.keyboard.press("Control+End")
    await manualPage.keyboard.press("Enter")
    await manualPage.keyboard.type(toolMarkers?.manualSave ?? `${marker}-MANUAL-SAVE`)
    await manualPage.keyboard.press("Control+S")
    await waitForAutoSave(manualPage)
    await manualPage.evaluate(() => window.__onlyOfficeEditor?.destroyEditor())
    await manualPage.close()
    const savedDocument = await pollDocument(cookie, selectedProject.id, document.id, (current) => current.revision > revisionBeforeManualSave && current.currentAsset?.sha256 !== sha256BeforeManualSave)

    const downloaded = await download(savedDocument.currentAsset.downloadPath, cookie)
    const downloadPath = resolve(outputDirectory, `${screenshotBase}-downloaded.docx`)
    await writeFile(downloadPath, downloaded.content)
    const docx = await inspectDocx(downloaded.content, toolMarkers ?? marker)

    const reopenSession = await request(`/api/v3/show-projects/${selectedProject.id}/documents/${document.id}/editor-session`, { method: "POST", cookie })
    const reopenPage = await context.newPage()
    const reopenPageErrors = []
    const reopenConsoleErrors = []
    reopenPage.on("pageerror", (error) => reopenPageErrors.push(error.message))
    reopenPage.on("console", (message) => { if (message.type() === "error") reopenConsoleErrors.push(message.text()) })
    await openEditor(reopenPage, reopenSession)
    const reopenedScreenshot = resolve(outputDirectory, `${screenshotBase}-reopened.png`)
    await reopenPage.screenshot({ path: reopenedScreenshot, fullPage: true })
    await reopenPage.evaluate(() => window.__onlyOfficeEditor?.destroyEditor())
    await reopenPage.close()

    restoration = restoreOriginalDocuments ? await restoreDocument(cookie, selectedProject.id, document.id, document.filename, original.content, beforeSha256) : null
    const toolAcceptance = toolMarkers ? {
      textInput: docx.toolEvidence?.textInput === true,
      tableCellEdit: docx.toolEvidence?.tableCellEdit === true,
      copyPaste: docx.toolEvidence?.copyPaste === true,
      undoRedo: docx.toolEvidence?.undoRedo === true,
      basicFormatting: docx.toolEvidence?.basicFormatting === true,
      autoSave: autoSaveEvidence?.settled === true,
      manualSave: savedDocument.revision > revisionBeforeManualSave && savedDocument.currentAsset.sha256 !== sha256BeforeManualSave,
      actions: ["TABLE_CELL_EDIT", "TEXT_INPUT", "COPY", "PASTE", "UNDO", "REDO", "BOLD", "AUTO_SAVE", "MANUAL_SAVE"]
    } : null
    if (toolAcceptance) toolAcceptance.passed = [toolAcceptance.textInput, toolAcceptance.tableCellEdit, toolAcceptance.copyPaste, toolAcceptance.undoRedo, toolAcceptance.basicFormatting, toolAcceptance.autoSave, toolAcceptance.manualSave].every(Boolean)

    return {
      id: document.id,
      templateCode: document.templateCode,
      filename: document.filename,
      marker,
      opened: true,
      modifiedEver,
      reopened: reopenPageErrors.length === 0 && reopenConsoleErrors.length === 0,
      revisionBefore: beforeRevision,
      revisionAfterSave: savedDocument.revision,
      sha256Before: beforeSha256,
      sha256AfterSave: savedDocument.currentAsset.sha256,
      markerPersisted: docx.markerPersisted,
      capabilities: editSession.capabilities,
      autoSaveEvidence,
      revisionBeforeManualSave,
      toolAcceptance,
      restoration,
      docx,
      pageErrors,
      consoleErrors,
      reopenPageErrors,
      reopenConsoleErrors,
      artifacts: { openedScreenshot, editedScreenshot, reopenedScreenshot, downloadPath }
    }
  } finally {
    if (restoreOriginalDocuments && restoration === null) {
      restoration = await restoreDocument(cookie, selectedProject.id, document.id, document.filename, original.content, beforeSha256).catch(() => null)
    }
    await context.close()
  }
}

async function openEditor(page, session) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" })
  await page.evaluate(() => { document.body.innerHTML = '<main id="onlyoffice-acceptance" style="width:100vw;height:100vh"></main>' })
  await page.addScriptTag({ url: session.publicApiUrl })
  await page.evaluate((config) => {
    window.__onlyOfficeReady = false
    window.__onlyOfficeError = null
    window.__onlyOfficeModified = false
    window.__onlyOfficeModifiedEver = false
    window.__onlyOfficeModifiedEvents = []
    window.__onlyOfficeEditor = new window.DocsAPI.DocEditor("onlyoffice-acceptance", {
      ...config,
      events: {
        onDocumentReady: () => { window.__onlyOfficeReady = true },
        onDocumentStateChange: (event) => {
          window.__onlyOfficeModified = Boolean(event?.data)
          window.__onlyOfficeModifiedEvents.push({ modified: window.__onlyOfficeModified, at: Date.now() })
          if (window.__onlyOfficeModified) window.__onlyOfficeModifiedEver = true
        },
        onError: (event) => { window.__onlyOfficeError = JSON.stringify(event) }
      }
    })
  }, session.config)
  await page.waitForFunction(() => window.__onlyOfficeReady === true || window.__onlyOfficeError !== null, null, { timeout: 90_000 })
  const state = await page.evaluate(() => ({ ready: window.__onlyOfficeReady, error: window.__onlyOfficeError, iframeCount: document.querySelectorAll("iframe").length }))
  if (!state.ready || state.iframeCount < 1) throw new Error(`ONLYOFFICE 文档打开失败：${state.error ?? "未创建编辑器 iframe"}`)
}

async function exerciseEditorTools(page, frame, markers) {
  await page.keyboard.press("Escape")
  await frame.click({ position: { x: 640, y: 358 } })
  await page.keyboard.press("End")
  await page.keyboard.type(` ${markers.table}`)

  await page.keyboard.press("Control+End")
  await page.keyboard.press("Enter")
  await page.keyboard.type(markers.text)

  await page.keyboard.press("Enter")
  await page.keyboard.type(markers.copy)
  for (const _character of [...markers.copy]) await page.keyboard.press("Shift+ArrowLeft")
  await page.keyboard.press("Control+C")
  await page.waitForTimeout(300)
  await page.keyboard.press("ArrowRight")
  await page.keyboard.press("Enter")
  await page.keyboard.press("Control+V")
  await page.waitForTimeout(300)

  await page.keyboard.press("End")
  await page.keyboard.press("Enter")
  await page.keyboard.type(markers.undoRedo)
  await page.keyboard.press("Control+Z")
  await page.keyboard.press("Control+Y")

  await page.keyboard.press("End")
  await page.keyboard.press("Enter")
  await page.keyboard.type(markers.formatting)
  await page.keyboard.press("Shift+Home")
  await page.keyboard.press("Control+B")
  await page.keyboard.press("ArrowRight")
}

async function waitForAutoSave(page) {
  const startedAt = Date.now()
  await page.waitForFunction(() => {
    const events = window.__onlyOfficeModifiedEvents ?? []
    const dirtyIndex = events.findIndex((event) => event.modified)
    return dirtyIndex >= 0 && events.slice(dirtyIndex + 1).some((event) => !event.modified)
  }, null, { timeout: callbackTimeoutMs })
  const events = await page.evaluate(() => window.__onlyOfficeModifiedEvents ?? [])
  const dirtyIndex = events.findIndex((event) => event.modified)
  const settledEvent = events.slice(dirtyIndex + 1).find((event) => !event.modified)
  return { settled: Boolean(settledEvent), waitMs: Date.now() - startedAt, events }
}

async function pollDocument(cookie, projectId, documentId, predicate) {
  const deadline = Date.now() + callbackTimeoutMs
  while (Date.now() < deadline) {
    const currentWorkspace = await request(`/api/v3/show-projects/${projectId}/documents`, { cookie })
    const document = currentWorkspace.documents.find((item) => item.id === documentId)
    if (document && predicate(document)) return document
    await delay(1_000)
  }
  throw new Error(`等待 ONLYOFFICE 保存回调超时：${documentId}`)
}

async function currentDocument(cookie, projectId, documentId) {
  const currentWorkspace = await request(`/api/v3/show-projects/${projectId}/documents`, { cookie })
  const document = currentWorkspace.documents.find((item) => item.id === documentId)
  if (!document) throw new Error(`项目文档不存在：${documentId}`)
  return document
}

async function restoreDocument(cookie, projectId, documentId, filename, content, expectedSha256) {
  const current = await currentDocument(cookie, projectId, documentId)
  const form = new FormData()
  form.set("expectedRevision", String(current.revision))
  form.set("saveMode", "MANUAL_SAVE")
  form.set("file", new Blob([content], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), filename)
  const response = await fetch(`${baseUrl}/api/v3/show-projects/${projectId}/documents/${documentId}/content`, { method: "PUT", headers: { Origin: origin, Cookie: cookie }, body: form })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`恢复原始文档失败：${response.status} ${JSON.stringify(body)}`)
  const restored = body.documents?.find((item) => item.id === documentId)
  return {
    restored: restored?.currentAsset?.sha256 === expectedSha256,
    revisionBeforeRestore: current.revision,
    revisionAfterRestore: restored?.revision ?? null,
    expectedSha256,
    actualSha256: restored?.currentAsset?.sha256 ?? null
  }
}

async function verifyReports(cookie) {
  const project = await selectReportProject(cookie)
  const docxWorkspace = await request(`/api/v3/show-projects/${project.id}/review/report/generate`, { method: "POST", cookie, body: { format: "DOCX" } })
  const docxDownload = await download(`/api/v3/show-projects/${project.id}/review/report/download`, cookie, false)
  const docxPath = resolve(outputDirectory, `report-${project.id}.docx`)
  await writeFile(docxPath, docxDownload.content)
  const docx = await inspectDocx(docxDownload.content)
  const pdfWorkspace = await request(`/api/v3/show-projects/${project.id}/review/report/generate`, { method: "POST", cookie, body: { format: "PDF" } })
  const pdfDownload = await download(`/api/v3/show-projects/${project.id}/review/report/download`, cookie, false)
  const pdfPath = resolve(outputDirectory, `report-${project.id}.pdf`)
  await writeFile(pdfPath, pdfDownload.content)
  const pdfText = pdfDownload.content.toString("latin1")
  const pdf = {
    valid: pdfDownload.content.subarray(0, 5).toString("ascii") === "%PDF-" && pdfDownload.content.includes(Buffer.from("%%EOF")),
    sizeBytes: pdfDownload.content.byteLength,
    sha256: sha256(pdfDownload.content),
    pageObjectCount: (pdfText.match(/\/Type\s*\/Page\b/g) ?? []).length,
    contentType: pdfDownload.contentType
  }
  return {
    project: { id: project.id, title: project.title },
    docx: { ...docx, format: docxWorkspace.report?.format, path: docxPath },
    pdf: { ...pdf, format: pdfWorkspace.report?.format, path: pdfPath }
  }
}

async function inspectDocx(content, markers = null) {
  if (content.subarray(0, 2).toString("ascii") !== "PK") return { valid: false, sizeBytes: content.byteLength, sha256: sha256(content), markerPersisted: false }
  const entries = await unzipEntries(content, new Set(["[Content_Types].xml", "word/document.xml", "word/styles.xml", "word/settings.xml"]), "word/media/")
  const documentXml = entries.files.get("word/document.xml")?.toString("utf8") ?? ""
  const stylesXml = entries.files.get("word/styles.xml")?.toString("utf8") ?? ""
  const settingsXml = entries.files.get("word/settings.xml")?.toString("utf8") ?? ""
  const contentTypes = entries.files.get("[Content_Types].xml")?.toString("utf8") ?? ""
  const marker = typeof markers === "string" ? markers : markers?.text ?? null
  const normalizedDocument = normalizeXmlText(documentXml)
  const markerPersisted = marker === null ? null : normalizedDocument.includes(marker)
  const tableXml = documentXml.match(/<w:tbl[ >][\s\S]*?<\/w:tbl>/)?.[0] ?? ""
  const toolEvidence = typeof markers === "object" && markers !== null ? {
    textInput: normalizedDocument.includes(markers.text),
    tableCellEdit: normalizeXmlText(tableXml).includes(markers.table),
    copyPaste: countOccurrences(normalizedDocument, markers.copy) >= 2,
    undoRedo: countOccurrences(normalizedDocument, markers.undoRedo) === 1,
    basicFormatting: hasBoldMarker(documentXml, markers.formatting),
    manualSaveMarker: normalizedDocument.includes(markers.manualSave)
  } : null
  return {
    valid: Boolean(documentXml && contentTypes.includes("wordprocessingml.document.main+xml")),
    sizeBytes: content.byteLength,
    sha256: sha256(content),
    markerPersisted,
    toolEvidence,
    paragraphCount: (documentXml.match(/<w:p[ >]/g) ?? []).length,
    tableCount: (documentXml.match(/<w:tbl[ >]/g) ?? []).length,
    sectionCount: (documentXml.match(/<w:sectPr[ >]/g) ?? []).length,
    pageBreakCount: (documentXml.match(/w:type="page"/g) ?? []).length,
    drawingCount: (documentXml.match(/<w:drawing[ >]/g) ?? []).length,
    mediaFileCount: entries.mediaCount,
    fontNames: [...new Set([...stylesXml.matchAll(/w:(?:ascii|eastAsia|hAnsi)="([^"]+)"/g)].map((match) => match[1]))].sort(),
    hasUpdateFields: /<w:updateFields[^>]*w:val="true"/.test(settingsXml)
  }
}

function unzipEntries(content, targetFiles, mediaPrefix) {
  return new Promise((resolveArchive, rejectArchive) => {
    yauzl.fromBuffer(content, { lazyEntries: true }, (openError, zipfile) => {
      if (openError || !zipfile) return rejectArchive(openError ?? new Error("DOCX 归档无法打开"))
      const files = new Map()
      let mediaCount = 0
      zipfile.on("error", rejectArchive)
      zipfile.on("entry", (entry) => {
        if (entry.fileName.startsWith(mediaPrefix) && !entry.fileName.endsWith("/")) mediaCount += 1
        if (!targetFiles.has(entry.fileName)) return zipfile.readEntry()
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return rejectArchive(streamError ?? new Error(`无法读取 ${entry.fileName}`))
          const chunks = []
          stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
          stream.on("error", rejectArchive)
          stream.on("end", () => { files.set(entry.fileName, Buffer.concat(chunks)); zipfile.readEntry() })
        })
      })
      zipfile.on("end", () => resolveArchive({ files, mediaCount }))
      zipfile.readEntry()
    })
  })
}

async function selectEditableProject(cookie) {
  const projects = await request("/api/v3/my-projects", { cookie })
  const candidates = projects.filter((item) => item.sceneType === "CITY_SHOW" && item.currentStageCode === "SHOW_FLIGHT_APPLICATION")
  for (const project of candidates) {
    if (editableProjectId && project.id !== editableProjectId) continue
    const workspaceValue = await request(`/api/v3/show-projects/${project.id}/documents`, { cookie }).catch(() => null)
    if (workspaceValue?.canEdit && workspaceValue.documents?.length === 3 && workspaceValue.documents.every((document) => editableDocumentStatuses.has(document.status))) return project
  }
  throw new Error("没有找到三份材料均未提交且可编辑的飞行申报项目；请设置 DOCUMENT_ACCEPTANCE_PROJECT_ID")
}

async function selectReportProject(cookie) {
  if (reportProjectId) return { id: reportProjectId, title: reportProjectId }
  const overview = await request("/api/v3/teaching/overview", { cookie })
  const candidates = []
  for (const item of overview.recentProgress ?? []) {
    if (item.sceneType !== "CITY_SHOW") continue
    const review = await request(`/api/v3/show-projects/${item.projectId}/review`, { cookie }).catch(() => null)
    candidates.push({ id: item.projectId, title: item.assignmentTitle, evaluationStatus: review?.evaluation?.status ?? "UNAVAILABLE" })
    if (review?.evaluation?.status === "PUBLISHED") return { id: item.projectId, title: item.assignmentTitle }
  }
  const candidateSummary = candidates.length > 0
    ? `可检查项目：${candidates.map((item) => `${item.id}(${item.evaluationStatus})`).join(", ")}`
    : "近期进度中没有城市表演项目"
  throw new Error(`没有找到已发布评价的表演项目；请设置 DOCUMENT_ACCEPTANCE_REPORT_PROJECT_ID。${candidateSummary}`)
}

async function login(email, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) })
  if (!response.ok) throw new Error(`登录失败：${response.status} ${await response.text()}`)
  const cookie = (response.headers.get("set-cookie") ?? "").split(";", 1)[0]
  if (!cookie) throw new Error("登录响应缺少会话 Cookie")
  return { cookie }
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: { Origin: origin, Cookie: options.cookie, ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path} 失败：${response.status} ${text}`)
  try { return JSON.parse(text) } catch { return text }
}

async function download(path, cookie, assetPath = true) {
  const url = assetPath && !path.startsWith("/api/") ? `${baseUrl}/api${path}` : `${baseUrl}${path}`
  const response = await fetch(url, { headers: { Origin: origin, Cookie: cookie } })
  if (!response.ok) throw new Error(`下载失败：${response.status} ${url}`)
  return { content: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get("content-type") ?? "" }
}

function browserExecutable() {
  const candidates = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean)
  const selected = candidates.find((candidate) => existsSync(candidate))
  if (!selected) throw new Error("未找到 Chrome；可通过 CHROME_PATH 指定浏览器路径")
  return selected
}

function browserCookie(cookie) {
  const separatorIndex = cookie.indexOf("=")
  if (separatorIndex < 1) throw new Error("Session cookie format is invalid")
  return {
    name: cookie.slice(0, separatorIndex),
    value: cookie.slice(separatorIndex + 1),
    url: baseUrl
  }
}

function normalizeXmlText(value) {
  return value.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ")
}

function hasBoldMarker(documentXml, marker) {
  return [...documentXml.matchAll(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g)].some((match) => normalizeXmlText(match[0]).includes(marker) && /<w:b(?:\s[^>]*)?\/?\s*>/.test(match[0]))
}

function countOccurrences(value, marker) {
  let count = 0
  let index = 0
  while ((index = value.indexOf(marker, index)) >= 0) {
    count += 1
    index += marker.length
  }
  return count
}

function sha256(content) { return createHash("sha256").update(content).digest("hex") }
function delay(value) { return new Promise((resolveDelay) => setTimeout(resolveDelay, value)) }
function safeFilename(value) { return value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_") }
function argument(name) { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : undefined }
function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") }
function positiveInteger(value, fallback) { const parsed = Number(value ?? fallback); if (!Number.isInteger(parsed) || parsed < 1) throw new Error("超时时间必须为正整数"); return parsed }
