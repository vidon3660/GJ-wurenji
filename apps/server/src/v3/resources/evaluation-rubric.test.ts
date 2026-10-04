import { describe, expect, it } from "vitest"
import type { V3ResourceReference } from "@wurenji/shared"
import {
  defaultEvaluationRubric,
  frozenTeacherScoresComplete,
  normalizeFrozenTeacherScores,
  rubricFromContent,
  teacherEvaluationContentBlockedReason,
  teacherScoresFromRubric,
  totalFrozenTeacherScore
} from "./evaluation-rubric.js"
import { ResourcePackageService } from "./resource-package.service.js"

describe("REPORT evaluation rubric", () => {
  it("maps the show rubric to the five TEA-024 teacher-scoring domains", () => {
    const rubric = defaultEvaluationRubric("CITY_SHOW")

    expect(rubric.version).toBe("1.1.0")
    expect(rubric.items.map((item) => [item.code, item.label, item.maxScore])).toEqual([
      ["AREA_PLANNING", "区域规划", 15],
      ["FLIGHT_APPLICATION", "申报文件内容", 15],
      ["PREFLIGHT_REPORTING", "飞前判断与动态报备", 15],
      ["RISK_DECISION", "运行风险识别与决策", 25],
      ["PROCEDURE_RESULT", "运行处置流程与结果", 15],
      ["REVIEW_QUALITY", "飞后运行分析质量", 15]
    ])
    expect(rubric.items.reduce((total, item) => total + item.maxScore, 0)).toBe(100)
  })

  it("uses only complete frozen teacher scores for the final total", () => {
    const scores = teacherScoresFromRubric(defaultEvaluationRubric("CITY_SHOW"))
    const incomplete = scores.map((item, index) => ({ ...item, score: index === 0 ? item.maxScore : null }))
    const complete = scores.map((item) => ({ ...item, score: item.maxScore - 1 }))

    expect(frozenTeacherScoresComplete(incomplete)).toBe(false)
    expect(totalFrozenTeacherScore(incomplete)).toBeNull()
    expect(teacherEvaluationContentBlockedReason(incomplete, "教师综合讲评已经满足最小长度要求")).toBe("请完成全部分项评分（已完成 1/6）")
    expect(teacherEvaluationContentBlockedReason(complete, "太短")).toBe("综合讲评至少 10 个字符（当前 2 个）")
    expect(teacherEvaluationContentBlockedReason(complete, "教师综合讲评已经满足最小长度要求")).toBeNull()
    expect(totalFrozenTeacherScore(complete)).toBe(94)
  })

  it("falls back to the built-in rubric for a legacy REPORT package", async () => {
    const service = resourceService({
      id: "report-legacy",
      packageType: "REPORT",
      name: "旧评价报告",
      version: "1.0.0",
      sha256: "a".repeat(64),
      status: "RETIRED",
      manifest: { output: "SINGLE_PDF" }
    })

    const resolved = await service.resolveEvaluationRubric("CITY_LOGISTICS", [reference("report-legacy", "旧评价报告", "1.0.0", "a")])

    expect(resolved.resourceDefined).toBe(false)
    expect(resolved.rubricVersion).toBe("旧评价报告@1.0.0")
    expect(resolved.teacherScores.map((item) => item.code)).toEqual([
      "REGION_ROUTE_PLANNING", "ROUTE_VALIDATION", "ORDER_SCHEDULING", "RUNTIME_MONITORING", "EMERGENCY_RESOLUTION", "REVIEW_QUALITY"
    ])
  })

  it("resolves the scene rubric from the frozen REPORT reference", async () => {
    const custom = {
      ...defaultEvaluationRubric("CITY_SHOW"),
      version: "2.3.0",
      title: "自定义表演评价量表",
      items: [
        { code: "PLANNING", label: "方案规划", maxScore: 40, sourceReferences: ["TEA-024"] },
        { code: "OPERATIONS", label: "运行处置", maxScore: 60, sourceReferences: ["TEA-024"] }
      ]
    }
    const service = resourceService({
      id: "report-current",
      packageType: "REPORT",
      name: "统一报告",
      version: "1.2.0",
      sha256: "b".repeat(64),
      status: "ACTIVE",
      manifest: { outputs: ["SINGLE_PDF"], rubrics: [custom] }
    })

    const resolved = await service.resolveEvaluationRubric("CITY_SHOW", [reference("report-current", "统一报告", "1.2.0", "b")])

    expect(resolved.resourceDefined).toBe(true)
    expect(resolved.rubricVersion).toBe("统一报告@1.2.0#2.3.0")
    expect(resolved.teacherScores).toEqual([
      { code: "PLANNING", label: "方案规划", maxScore: 40, score: null, comment: "" },
      { code: "OPERATIONS", label: "运行处置", maxScore: 60, score: null, comment: "" }
    ])
  })

  it("keeps frozen evaluation items unchanged after the resource definition changes", () => {
    const original = teacherScoresFromRubric(defaultEvaluationRubric("CITY_SHOW"))
    const upgraded = rubricFromContent("CITY_SHOW", {
      rubrics: [{
        ...defaultEvaluationRubric("CITY_SHOW"),
        version: "2.0.0",
        items: [
          { code: "NEW_PLANNING", label: "新版规划", maxScore: 50, sourceReferences: ["新版条款"] },
          { code: "NEW_OPERATIONS", label: "新版运行", maxScore: 50, sourceReferences: ["新版条款"] }
        ]
      }]
    }).rubric

    const scored = normalizeFrozenTeacherScores(
      original.map((item) => ({ ...item, score: item.maxScore, comment: "按冻结版本评分" })),
      original
    )

    expect(scored.map((item) => item.code)).toEqual(original.map((item) => item.code))
    expect(scored.map((item) => item.code)).not.toEqual(upgraded.items.map((item) => item.code))
  })

  it("plans same-name upgrades and selects the highest scene-compatible REPORT", async () => {
    const frozen = [
      resource("rule-current", "RULE", "教学规则", "1.0.0", "RETIRED", {}),
      resource("report-current", "REPORT", "旧评价报告", "1.0.0", "RETIRED", { output: "SINGLE_PDF" })
    ]
    const active = [
      resource("rule-other", "RULE", "其他规则", "9.0.0", "ACTIVE", {}),
      resource("rule-upgrade", "RULE", "教学规则", "1.2.0", "ACTIVE", {}),
      resource("report-logistics", "REPORT", "物流评价报告", "9.0.0", "ACTIVE", {
        outputs: ["SINGLE_PDF"],
        rubrics: [defaultEvaluationRubric("CITY_LOGISTICS")]
      }),
      resource("report-show", "REPORT", "表演评价报告", "2.0.0", "ACTIVE", {
        outputs: ["SINGLE_PDF"],
        rubrics: [defaultEvaluationRubric("CITY_SHOW")]
      }),
      resource("report-test", "REPORT", "测试评价报告", "99.0.0", "ACTIVE", { output: "SINGLE_PDF", testOnly: true })
    ]
    const manager = {
      find: async (_entity: unknown, options: { where?: { status?: unknown } }) => options.where?.status === "ACTIVE" ? active : frozen
    }
    const service = new ResourcePackageService({ manager } as never, undefined as never, undefined as never, undefined as never, undefined as never, undefined as never)

    const plan = await service.planActiveReferenceUpgrade("CITY_SHOW", frozen.map(toReference), manager as never)

    expect(plan.changes).toEqual([
      expect.objectContaining({ packageType: "RULE", replacement: expect.objectContaining({ packageId: "rule-upgrade", version: "1.2.0" }) }),
      expect.objectContaining({ packageType: "REPORT", replacement: expect.objectContaining({ packageId: "report-show", version: "2.0.0" }) })
    ])
  })
})

function resourceService(resource: Record<string, unknown>): ResourcePackageService {
  const repository = {
    manager: {
      findOne: async () => resource
    }
  }
  return new ResourcePackageService(repository as never, undefined as never, undefined as never, undefined as never, undefined as never, undefined as never)
}

function reference(packageId: string, name: string, version: string, shaCharacter: string): V3ResourceReference {
  return { packageId, packageType: "REPORT", name, version, sha256: shaCharacter.repeat(64) }
}

function resource(
  id: string,
  packageType: "RULE" | "REPORT",
  name: string,
  version: string,
  status: "ACTIVE" | "RETIRED",
  manifest: Record<string, unknown>
) {
  return {
    id,
    packageType,
    name,
    version,
    sha256: id.padEnd(64, "a").slice(0, 64),
    status,
    manifest,
    minimumPlatformVersion: "0.1.0"
  }
}

function toReference(item: ReturnType<typeof resource>): V3ResourceReference {
  return {
    packageId: item.id,
    packageType: item.packageType,
    name: item.name,
    version: item.version,
    sha256: item.sha256
  }
}
