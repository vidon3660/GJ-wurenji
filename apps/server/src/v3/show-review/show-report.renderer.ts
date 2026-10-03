import PDFDocument from "pdfkit"
import sharp from "sharp"
import { ZipFile } from "yazl"
import { resolveEvaluationPdfFont } from "../../logistics/evaluation-pdf.js"

export interface ShowReportSection {
  title: string
  paragraphs?: string[]
  rows?: Array<{ label: string; value: string }>
}

export interface ShowReportRenderData {
  title: string
  subtitle: string
  metadata: Array<{ label: string; value: string }>
  sections: ShowReportSection[]
  planningMap?: Buffer | null
  declaration: string
}

export async function createShowReportPdf(data: ShowReportRenderData): Promise<Buffer> {
  const document = new PDFDocument({
    size: "A4",
    margin: 48,
    info: {
      Title: data.title,
      Author: "云阵无人集群虚拟仿真实训平台",
      Subject: "城市无人机编队表演仿真实训项目报告"
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
  const width = document.page.width - document.page.margins.left - document.page.margins.right
  const ensureSpace = (height: number) => {
    if (document.y + height <= document.page.height - document.page.margins.bottom) return
    document.addPage()
    applyFont(document, font)
  }

  document.fontSize(9).fillColor("#247253").text("云阵 / 无人集群虚拟仿真实训平台")
  document.moveDown(0.8).fontSize(22).fillColor("#173f32").text(data.title)
  document.moveDown(0.35).fontSize(10).fillColor("#6d7c75").text(data.subtitle)
  document.moveDown(1)
  divider(document)
  document.moveDown(0.8)

  for (const item of data.metadata) {
    ensureSpace(34)
    const y = document.y
    document.fontSize(9).fillColor("#6d7c75").text(item.label, 48, y, { width: 110 })
    document.fontSize(10.5).fillColor("#202a25").text(item.value, 164, y, { width: width - 116 })
    document.y = Math.max(document.y, y + 25)
  }

  for (const section of data.sections) {
    ensureSpace(54)
    document.moveDown(0.7).fontSize(13).fillColor("#173f32").text(section.title)
    document.moveDown(0.35)
    divider(document)
    document.moveDown(0.55)
    if (section.title === "区域规划" && data.planningMap) {
      ensureSpace(230)
      try {
        document.image(data.planningMap, { fit: [width, 210], align: "center" })
        document.moveDown(0.7)
      } catch {
        document.fontSize(9).fillColor("#8a4b3c").text("区域规划图无法嵌入，源文件校验信息仍保留在报告数据中。")
      }
    }
    for (const row of section.rows ?? []) {
      ensureSpace(34)
      const y = document.y
      document.fontSize(9).fillColor("#6d7c75").text(row.label, 48, y, { width: 128 })
      document.fontSize(10).fillColor("#202a25").text(row.value || "-", 182, y, { width: width - 134, lineGap: 3 })
      document.y = Math.max(document.y, y + 25)
    }
    for (const paragraph of section.paragraphs ?? []) {
      ensureSpace(46)
      document.fontSize(10).fillColor("#35433d").text(paragraph, { lineGap: 4 })
      document.moveDown(0.55)
    }
  }

  ensureSpace(100)
  document.moveDown(0.8)
  divider(document)
  document.moveDown(0.6).fontSize(9).fillColor("#8a4b3c").text("教学仿真声明", { continued: false })
  document.moveDown(0.3).fontSize(8.5).fillColor("#6d5e57").text(data.declaration, { lineGap: 4 })
  document.end()
  return completed
}

export async function createShowReportDocx(data: ShowReportRenderData): Promise<Buffer> {
  const image = data.planningMap ? await normalizePng(data.planningMap) : null
  const body: string[] = [
    paragraph(data.title, "Title"),
    paragraph(data.subtitle, "Subtitle"),
    ...data.metadata.map((item) => paragraph(`${item.label}：${item.value}`))
  ]
  for (const section of data.sections) {
    body.push(paragraph(section.title, "Heading1"))
    if (section.title === "区域规划" && image) body.push(imageParagraph(image.widthEmu, image.heightEmu))
    for (const row of section.rows ?? []) body.push(paragraph(`${row.label}：${row.value || "-"}`))
    for (const value of section.paragraphs ?? []) body.push(paragraph(value))
  }
  body.push(paragraph("教学仿真声明", "Heading1"), paragraph(data.declaration, "Declaration"))
  const relationships = image
    ? `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/planning-map.png"/>`
    : ""
  const contentTypes = image
    ? `<Default Extension="png" ContentType="image/png"/>`
    : ""
  return createZip([
    ["[Content_Types].xml", xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${contentTypes}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`)],
    ["_rels/.rels", xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`)],
    ["word/document.xml", xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`)],
    ["word/styles.xml", xml(stylesXml())],
    ["word/_rels/document.xml.rels", xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`)],
    ["docProps/core.xml", xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(data.title)}</dc:title><dc:creator>云阵无人集群虚拟仿真实训平台</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>`)],
    ["docProps/app.xml", xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>云阵无人集群虚拟仿真实训平台</Application></Properties>`)],
    ...(image ? [["word/media/planning-map.png", image.content] as [string, Buffer]] : [])
  ])
}

async function normalizePng(content: Buffer) {
  const normalized = await sharp(content).png().toBuffer({ resolveWithObject: true })
  const width = normalized.info.width || 1200
  const height = normalized.info.height || 800
  const widthEmu = 5_943_600
  return { content: normalized.data, widthEmu, heightEmu: Math.round(widthEmu * height / width) }
}

function paragraph(value: string, style?: string): string {
  const styleXml = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""
  return `<w:p>${styleXml}<w:r><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r></w:p>`
}

function imageParagraph(width: number, height: number): string {
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${width}" cy="${height}"/><wp:docPr id="1" name="区域规划图"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="planning-map.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
}

function stylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="360"/></w:pPr><w:rPr><w:color w:val="557068"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="300" w:after="160"/></w:pPr><w:rPr><w:b/><w:color w:val="173F32"/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Declaration"><w:name w:val="Declaration"/><w:rPr><w:color w:val="8A4B3C"/><w:sz w:val="18"/></w:rPr></w:style></w:styles>`
}

function createZip(entries: Array<[string, Buffer]>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile()
    const chunks: Buffer[] = []
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk))
    zip.outputStream.once("error", reject)
    zip.outputStream.once("end", () => resolve(Buffer.concat(chunks)))
    for (const [path, content] of entries) zip.addBuffer(content, path)
    zip.end()
  })
}

function xml(value: string): Buffer {
  return Buffer.from(value, "utf8")
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;")
}

function divider(document: PDFKit.PDFDocument): void {
  document.moveTo(document.page.margins.left, document.y)
    .lineTo(document.page.width - document.page.margins.right, document.y)
    .lineWidth(0.6)
    .strokeColor("#d7e1dd")
    .stroke()
}

function applyFont(document: PDFKit.PDFDocument, font: { path: string; family?: string }): void {
  if (font.family) document.font(font.path, font.family)
  else document.font(font.path)
}
