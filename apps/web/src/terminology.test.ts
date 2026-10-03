import { describe, expect, it } from "vitest"
import { formatAircraftModelCode, formatCoordinateReference, formatEvaluationStatus, formatHeightDatum, formatLandingSiteStatus, formatLocalCoordinateFrame, formatLogisticsEvidenceCode, formatMapResourceSource, formatReportJobStatus, formatRuntimeSessionStatus, formatScaleTemplateCode, formatShowGroupCode, formatSubmissionStatus, formatTimelineStatus, formatValidationStatus, formatVtlGroupCode, formatVtlTaskType } from "./terminology"

describe("user-facing terminology", () => {
  it("explains coordinate and local frames", () => {
    expect(formatCoordinateReference("WGS84")).toBe("全球坐标系 WGS84")
    expect(formatLocalCoordinateFrame("ENU")).toBe("局部东-北-天坐标 ENU")
  })

  it("makes map resource metadata understandable", () => {
    expect(formatHeightDatum("AGL")).toBe("相对地面高度 AGL")
    expect(formatMapResourceSource("BUILT_IN")).toBe("平台内置资源")
    expect(formatMapResourceSource("学校专用 DEM")).toBe("学校专用 DEM")
  })

  it("explains height datums without changing their identifiers", () => {
    expect(formatHeightDatum("AGL")).toBe("相对地面高度 AGL")
    expect(formatHeightDatum("AMSL")).toBe("平均海平面高度 AMSL")
  })

  it("turns scale template codes into readable scene labels", () => {
    expect(formatScaleTemplateCode("SHOW_3000")).toBe("城市表演 3000 架")
    expect(formatScaleTemplateCode("LOGISTICS_50")).toBe("城市物流 50 架")
    expect(formatScaleTemplateCode("VTL_20")).toBe("垂起巡检 20 架")
  })

  it("explains logistics model and validation codes without losing identifiers", () => {
    expect(formatAircraftModelCode("LOGISTICS-TEACHING-01")).toBe("物流教学无人机（LOGISTICS-TEACHING-01）")
    expect(formatAircraftModelCode(undefined)).toBe("机型未提供")
    expect(formatLogisticsEvidenceCode("ROUTE_CONFLICT")).toBe("航线存在冲突（ROUTE_CONFLICT）")
    expect(formatLogisticsEvidenceCode("NEW_RULE")).toBe("NEW_RULE")
  })

  it("explains vertical inspection group codes", () => {
    expect(formatVtlGroupCode("GROUP_A")).toBe("巡检机组 A（GROUP_A）")
    expect(formatVtlGroupCode(undefined)).toBe("机组未指定")
  })

  it("explains show formation codes", () => {
    expect(formatShowGroupCode("G01")).toBe("表演编队 01（G01）")
    expect(formatShowGroupCode(undefined)).toBe("表演编队未指定")
  })

  it("maps workflow states to actionable Chinese labels", () => {
    expect(formatSubmissionStatus("SUBMITTED")).toBe("已提交，等待教师处理")
    expect(formatSubmissionStatus("LOCKED")).toBe("未开放或被前置条件锁定")
    expect(formatSubmissionStatus("IN_PROGRESS")).toBe("进行中")
    expect(formatSubmissionStatus("SNAPSHOT")).toBe("候选版本")
    expect(formatSubmissionStatus("VALIDATED")).toBe("已验证")
  })

  it("explains evaluation and report job states", () => {
    expect(formatEvaluationStatus("PENDING")).toBe("待教师评价")
    expect(formatEvaluationStatus("PUBLISHED")).toBe("评价已发布")
    expect(formatReportJobStatus("RETRY_WAIT")).toBe("等待重试")
    expect(formatReportJobStatus("DEAD_LETTER")).toBe("生成失败")
  })

  it("explains runtime and evidence timeline states", () => {
    expect(formatRuntimeSessionStatus("READY")).toBe("等待启动")
    expect(formatRuntimeSessionStatus("PAUSED")).toBe("已暂停")
    expect(formatTimelineStatus("ACKNOWLEDGED")).toBe("已确认")
    expect(formatTimelineStatus("UNKNOWN_CODE")).toBe("UNKNOWN_CODE")
  })

  it("explains planning validation, site availability, and task types", () => {
    expect(formatValidationStatus("WITH_RISK")).toBe("存在风险，可继续")
    expect(formatValidationStatus("HARD_CONFLICT")).toBe("存在硬性冲突")
    expect(formatLandingSiteStatus("RESTRICTED")).toBe("受限使用")
    expect(formatVtlTaskType("AREA")).toBe("区域巡检")
  })
})
