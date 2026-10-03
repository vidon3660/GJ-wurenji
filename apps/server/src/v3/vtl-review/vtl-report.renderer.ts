import PDFDocument from "pdfkit"
import { resolveEvaluationPdfFont } from "../../logistics/evaluation-pdf.js"
import { createShowReportDocx } from "../show-review/show-report.renderer.js"

const declaration = "本文件由教学仿真系统依据保存的任务方案、运行快照、事件和评价记录生成，仅用于教学训练与复盘，不作为真实飞行审批、航空器性能结论或运行依据。"

export interface VtlReportData {
  title: string
  subtitle: string
  metadata: Array<{ label: string; value: string }>
  sections: Array<{ title: string; rows: Array<{ label: string; value: string }> }>
}

export async function createVtlReportPdf(data: VtlReportData): Promise<Buffer> {
  const document = new PDFDocument({
    size: "A4",
    margin: 48,
    info: { Title: data.title, Author: "云阵无人集群虚拟仿真实训平台", Subject: "垂起广域巡检教学仿真报告" }
  })
  const chunks: Buffer[] = []
  const completed = new Promise<Buffer>((resolve, reject) => {
    document.on("data", (chunk: Buffer) => chunks.push(chunk))
    document.on("end", () => resolve(Buffer.concat(chunks)))
    document.on("error", reject)
  })
  const font = resolveEvaluationPdfFont()
  applyFont(document, font)
  const bottom = document.page.height - document.page.margins.bottom
  const ensureSpace = (height: number) => {
    if (document.y + height <= bottom) return
    document.addPage()
    applyFont(document, font)
  }
  const line = () => {
    document.moveTo(document.page.margins.left, document.y).lineTo(document.page.width - document.page.margins.right, document.y).strokeColor("#c7d5ce").stroke()
  }

  document.fontSize(9).fillColor("#247253").text("云阵 / 无人集群虚拟仿真实训平台")
  document.moveDown(0.8).fontSize(21).fillColor("#173f32").text(data.title)
  document.moveDown(0.35).fontSize(10).fillColor("#687a72").text(data.subtitle)
  document.moveDown(0.8)
  line()
  document.moveDown(0.8)
  for (const item of data.metadata) {
    ensureSpace(30)
    const y = document.y
    document.fontSize(9).fillColor("#687a72").text(item.label, 48, y, { width: 120 })
    document.fontSize(10).fillColor("#202a25").text(item.value || "-", 176, y, { width: 370 })
    document.y = Math.max(document.y, y + 23)
  }
  for (const section of data.sections) {
    ensureSpace(60)
    document.moveDown(0.7).fontSize(13).fillColor("#173f32").text(section.title)
    document.moveDown(0.3)
    line()
    document.moveDown(0.45)
    for (const row of section.rows) {
      ensureSpace(32)
      const y = document.y
      document.fontSize(9).fillColor("#687a72").text(row.label, 48, y, { width: 140 })
      document.fontSize(10).fillColor("#202a25").text(row.value || "-", 194, y, { width: 350, lineGap: 3 })
      document.y = Math.max(document.y, y + 25)
    }
  }
  ensureSpace(55)
  document.moveDown(1).fontSize(8).fillColor("#7b8782").text(declaration, { lineGap: 3 })
  document.end()
  return completed
}

export function createVtlReportDocx(data: VtlReportData): Promise<Buffer> {
  return createShowReportDocx({ ...data, declaration })
}

function applyFont(document: PDFKit.PDFDocument, font: { path: string; family?: string }): void {
  if (font.family) document.font(font.path, font.family)
  else document.font(font.path)
}
