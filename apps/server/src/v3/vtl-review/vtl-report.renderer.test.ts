import { describe, expect, it } from "vitest"
import { createVtlReportDocx, createVtlReportPdf, type VtlReportData } from "./vtl-report.renderer.js"

describe("VTL project report renderer", () => {
  it("creates valid PDF and DOCX files from the same review evidence", async () => {
    const data: VtlReportData = {
      title: "垂起广域巡检项目报告",
      subtitle: "20 架教学仿真",
      metadata: [
        { label: "项目", value: "丘陵广域巡检" },
        { label: "任务覆盖", value: "8/8" }
      ],
      sections: [
        { title: "任务完成情况", rows: [{ label: "未完成对象", value: "无" }] },
        { title: "运行与能量", rows: [{ label: "平均剩余能量", value: "31%" }] }
      ]
    }

    const [pdf, docx] = await Promise.all([createVtlReportPdf(data), createVtlReportDocx(data)])

    expect(pdf.subarray(0, 4).toString("ascii")).toBe("%PDF")
    expect(pdf.byteLength).toBeGreaterThan(2_000)
    expect(docx.subarray(0, 2).toString("ascii")).toBe("PK")
    expect(docx.byteLength).toBeGreaterThan(1_000)
  })
})
