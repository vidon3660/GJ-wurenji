import { describe, expect, it } from "vitest"
import type { V3RegionMapReadinessView } from "@wurenji/shared"
import { vtlMapReadinessPresentation, vtlMapResourceStatusLabel } from "./vtl-map-readiness-presentation"

describe("VTOL map readiness presentation", () => {
  it("allows publishing when all formal resources are ready", () => {
    expect(vtlMapReadinessPresentation(readiness(true), true)).toMatchObject({
      state: "READY",
      publishBlocked: false,
      issues: []
    })
  })

  it("keeps production publishing available while naming every missing formal resource", () => {
    const result = vtlMapReadinessPresentation(readiness(false), true)
    expect(result).toMatchObject({ state: "FALLBACK", publishBlocked: false })
    expect(result.issues.map((issue) => issue.label)).toEqual(["DEM", "影像", "高程快照"])
    expect(result.issues.map((issue) => issue.statusLabel)).toEqual(["校验失败", "待配置", "缺失"])
    expect(result.issues[0]?.nextStep).toContain("quantized-mesh DEM")
    expect(result.issues[1]?.nextStep).toContain("配置影像地址")
    expect(result.issues[2]?.nextStep).toContain("高程 samples")
  })

  it("maps every resource gate status to a clear teacher-facing label", () => {
    expect(vtlMapResourceStatusLabel("READY")).toBe("已就绪")
    expect(vtlMapResourceStatusLabel("MISSING")).toBe("缺失")
    expect(vtlMapResourceStatusLabel("INVALID")).toBe("校验失败")
    expect(vtlMapResourceStatusLabel("EXTERNAL")).toBe("外部待验收")
    expect(vtlMapResourceStatusLabel("UNCONFIGURED")).toBe("待配置")
  })

  it("keeps local teaching fallback publishable without calling it formal evidence", () => {
    expect(vtlMapReadinessPresentation(readiness(false), false)).toMatchObject({
      state: "FALLBACK",
      publishBlocked: false,
      title: "当前使用教学地图回退"
    })
  })

  it("does not block publishing when the readiness check is temporarily unavailable", () => {
    expect(vtlMapReadinessPresentation(null, true)).toMatchObject({
      state: "UNKNOWN",
      publishBlocked: false
    })
  })
})

function readiness(formalReady: boolean): V3RegionMapReadinessView {
  return {
    regionPackageId: "region-1",
    regionCode: "VTL-HILLS-01",
    packageVersion: "1.0.0",
    checkedAt: "2026-08-20T00:00:00.000Z",
    formalReady,
    environmentDiagnostics: {
      status: "UNAVAILABLE",
      layerPresent: false,
      buildingCount: 0,
      obstacleCount: 0,
      missingHeightCount: 0,
      authoritativeSourceDeclared: false,
      source: null,
      version: null,
      message: "未找到 BUILDINGS 环境图层，无法判断建筑物和障碍物数据"
    },
    checks: [
      check("TERRAIN", formalReady ? "READY" : "INVALID", "DEM 文件树摘要不一致"),
      check("IMAGERY", formalReady ? "READY" : "UNCONFIGURED", "区域包未配置版本化影像资源"),
      check("ELEVATION_SNAPSHOT", formalReady ? "READY" : "MISSING", "高程采样快照不存在")
    ]
  }
}

function check(kind: "TERRAIN" | "IMAGERY" | "ELEVATION_SNAPSHOT", status: "READY" | "INVALID" | "UNCONFIGURED" | "MISSING", message: string) {
  return { kind, status, required: true, message, url: null, localPath: null, expectedSha256: null, actualSha256: null }
}
