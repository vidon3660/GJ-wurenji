import PDFDocument from "pdfkit"
import { existsSync, statSync } from "node:fs"
import type { GradeDimensionResult, EvaluationMetricResult } from "@wurenji/shared"

export interface EvaluationPdfData {
  assignmentTitle: string
  classroomName: string
  courseName: string
  term: string
  practiceTitle: string
  studentName: string
  studentEmail: string
  status: string
  autoScore: number
  teacherAdjustment: number
  totalScore: number
  passed: boolean
  hardConstraintsPassed: boolean
  teacherFeedback: string | null
  dimensions: GradeDimensionResult[]
  metrics: EvaluationMetricResult[]
  revision: number
  evaluatedAt: Date
  publishedAt: Date
}

interface PdfFont {
  path: string
  family?: string
}

const fontCandidates: PdfFont[] = [
  { path: "C:/Windows/Fonts/simhei.ttf" },
  { path: "C:/Windows/Fonts/Deng.ttf" },
  { path: "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", family: "NotoSansCJKsc-Regular" },
  { path: "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", family: "WenQuanYiZenHei" },
  // Some managed Linux runners unpack Debian font packages below /usr/local
  // instead of installing them into the system prefix. Keep this path as a
  // runtime candidate; no font binary is checked into the repository.
  { path: "/usr/local/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", family: "NotoSansCJKsc-Regular" }
]

export function resolveEvaluationPdfFont(): PdfFont {
  if (process.env.PDF_FONT_PATH) {
    if (!isUsableFontPath(process.env.PDF_FONT_PATH)) throw new Error(`PDF_FONT_PATH 不存在或不可读：${process.env.PDF_FONT_PATH}`)
    return process.env.PDF_FONT_FAMILY
      ? { path: process.env.PDF_FONT_PATH, family: process.env.PDF_FONT_FAMILY }
      : { path: process.env.PDF_FONT_PATH }
  }
  const candidate = fontCandidates.find((item) => isUsableFontPath(item.path))
  if (!candidate) throw new Error("未找到可用于评价结果 PDF 的中文字体")
  return candidate
}

function isUsableFontPath(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

export function createEvaluationPdf(data: EvaluationPdfData): Promise<Buffer> {
  const document = new PDFDocument({
    size: "A4",
    margin: 48,
    info: {
      Title: `${data.assignmentTitle} - 评价结果`,
      Author: "云阵无人集群虚拟仿真实训平台",
      Subject: "学生实训评价结果"
    }
  })
  const chunks: Buffer[] = []
  const completed = new Promise<Buffer>((resolve, reject) => {
    document.on("data", (chunk: Buffer) => chunks.push(chunk))
    document.on("end", () => resolve(Buffer.concat(chunks)))
    document.on("error", reject)
  })
  const font = resolveEvaluationPdfFont()
  applyFont(document, font)

  const pageWidth = document.page.width - document.page.margins.left - document.page.margins.right
  const ensureSpace = (height: number) => {
    if (document.y + height <= document.page.height - document.page.margins.bottom) return
    document.addPage()
    applyFont(document, font)
  }
  const divider = () => {
    document.moveTo(document.page.margins.left, document.y)
      .lineTo(document.page.width - document.page.margins.right, document.y)
      .lineWidth(0.6)
      .strokeColor("#d7e1dd")
      .stroke()
  }
  const sectionTitle = (title: string) => {
    ensureSpace(42)
    document.moveDown(0.7).fontSize(13).fillColor("#173f32").text(title)
    document.moveDown(0.35)
    divider()
    document.moveDown(0.55)
  }
  const labelValue = (label: string, value: string, x: number, y: number, width: number) => {
    document.fontSize(9).fillColor("#6d7c75").text(label, x, y, { width })
    document.fontSize(10.5).fillColor("#202a25").text(value, x, y + 16, { width })
  }

  document.fontSize(10).fillColor("#398060").text("云阵 / 无人集群虚拟仿真实训平台")
  document.moveDown(0.8).fontSize(24).fillColor("#173f32").text("实训评价结果")
  document.moveDown(0.35).fontSize(10).fillColor("#6d7c75").text(`${data.courseName} · ${data.term} · ${data.classroomName}`)
  document.moveDown(1.1)
  divider()
  document.moveDown(0.8)

  const metaY = document.y
  labelValue("学生", data.studentName, 48, metaY, 150)
  labelValue("账号", data.studentEmail, 205, metaY, 180)
  labelValue("评价版本", `R${data.revision}`, 392, metaY, 70)
  labelValue("发布时间", formatDate(data.publishedAt), 469, metaY, 78)
  document.y = metaY + 50
  labelValue("班级实训", data.assignmentTitle, 48, document.y, 250)
  labelValue("仿真场景", data.practiceTitle, 305, document.y, 242)
  document.y += 54

  sectionTitle("评价结论")
  const scoreY = document.y
  document.roundedRect(48, scoreY, pageWidth, 82, 4).fillAndStroke("#f2f7f4", "#d7e1dd")
  document.fontSize(32).fillColor("#173f32").text(data.totalScore.toFixed(1), 66, scoreY + 14, { width: 100 })
  document.fontSize(10).fillColor("#6d7c75").text("总分 / 100", 68, scoreY + 54, { width: 100 })
  document.fontSize(12).fillColor(data.passed ? "#247253" : "#a34040").text(data.passed ? "通过" : "未通过", 184, scoreY + 20, { width: 72 })
  document.fontSize(9).fillColor("#6d7c75").text(data.hardConstraintsPassed ? "安全硬约束通过" : "安全硬约束未通过", 184, scoreY + 46, { width: 120 })
  labelValue("自动评分", data.autoScore.toFixed(1), 325, scoreY + 17, 80)
  labelValue("教师调整", `${data.teacherAdjustment > 0 ? "+" : ""}${data.teacherAdjustment.toFixed(1)}`, 420, scoreY + 17, 90)
  document.y = scoreY + 92

  sectionTitle("评价维度")
  for (const dimension of data.dimensions) {
    ensureSpace(58)
    const rowY = document.y
    document.fontSize(10.5).fillColor("#202a25").text(dimension.name, 48, rowY, { width: 160 })
    document.fontSize(10.5).fillColor("#173f32").text(`${dimension.earnedScore.toFixed(1)} / ${dimension.maxScore}`, 418, rowY, { width: 129, align: "right" })
    document.roundedRect(48, rowY + 23, pageWidth, 5, 2.5).fill("#e4ebe7")
    document.roundedRect(48, rowY + 23, pageWidth * Math.max(0, Math.min(1, dimension.ratio)), 5, 2.5).fill("#4f9b77")
    document.fontSize(8.5).fillColor("#6d7c75").text(dimension.evidence.join("；") || "无附加证据", 48, rowY + 36, { width: pageWidth })
    document.y = rowY + 56
  }

  sectionTitle("指标核定与证据")
  for (const metric of data.metrics) {
    ensureSpace(68)
    const rowY = document.y
    document.fontSize(9).fillColor(metric.passed ? "#247253" : "#a34040").text(metric.passed ? "达标" : "未达标", 48, rowY, { width: 48 })
    document.fontSize(10.5).fillColor("#202a25").text(metric.label, 102, rowY, { width: 150 })
    document.fontSize(10).fillColor("#173f32").text(metric.displayValue, 258, rowY, { width: 90 })
    document.fontSize(9).fillColor("#6d7c75").text(`目标：${metric.target}`, 354, rowY, { width: 193, align: "right" })
    document.fontSize(8.5).fillColor("#6d7c75").text(metric.evidence, 102, rowY + 22, { width: 445 })
    document.y = rowY + 55
    divider()
    document.moveDown(0.5)
  }

  sectionTitle("教师复核意见")
  document.fontSize(10).fillColor("#35433d").text(data.teacherFeedback || "教师未填写补充意见。", { lineGap: 5 })
  document.moveDown(1.4)
  document.fontSize(8.5).fillColor("#86938d").text(`自动评价时间：${formatDate(data.evaluatedAt)}  ·  文件校验以平台当前发布版本为准。`)

  document.end()
  return completed
}

function formatDate(value: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(value)
}

function applyFont(document: PDFKit.PDFDocument, font: PdfFont) {
  if (font.family) document.font(font.path, font.family)
  else document.font(font.path)
}
