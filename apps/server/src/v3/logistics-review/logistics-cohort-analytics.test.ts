import { describe, expect, it } from "vitest"
import type { ProjectEvaluationEntity, RuntimeEventEntity } from "../runtime/runtime.entities.js"
import type { StudentProjectEntity } from "../assignments/assignment.entities.js"
import { computeLogisticsCohortAnalytics } from "./logistics-review.service.js"

describe("logistics cohort analytics", () => {
  it("aggregates completion, published scores, risks, response time and triggered event types", () => {
    const analytics = computeLogisticsCohortAnalytics(
      "assignment-1",
      [
        { id: "project-1", status: "GRADED" },
        { id: "project-2", status: "EVALUATING" },
        { id: "project-3", status: "IN_PROGRESS" }
      ] as Array<Pick<StudentProjectEntity, "id" | "status">>,
      [
        {
          status: "PUBLISHED",
          totalScore: 92,
          objectiveMetrics: [
            metric("AVG_RESPONSE_SECONDS", "平均处置时效", 30, "PASS"),
            metric("ORDER_COMPLETION", "订单完成率", 80, "RISK")
          ]
        },
        {
          status: "REVIEWED",
          totalScore: 78,
          objectiveMetrics: [
            metric("AVG_RESPONSE_SECONDS", "平均处置时效", 50, "PASS"),
            metric("ORDER_COMPLETION", "订单完成率", 60, "RISK"),
            metric("EVENT_CONTROL", "事件控制率", 50, "RISK")
          ]
        }
      ] as Array<Pick<ProjectEvaluationEntity, "status" | "totalScore" | "objectiveMetrics">>,
      [
        { category: "AIRCRAFT_DEVICE", triggeredAt: new Date("2026-08-13T00:00:00Z"), payload: { eventSubtype: "BATTERY_CONSUMPTION_ANOMALY" } },
        { category: "AIRCRAFT_DEVICE", triggeredAt: new Date("2026-08-13T00:01:00Z"), payload: { eventSubtype: "BATTERY_CONSUMPTION_ANOMALY" } },
        { category: "ORDER_TASK_CHANGE", triggeredAt: new Date("2026-08-13T00:02:00Z"), payload: {} },
        { category: "COMMUNICATION_LINK", triggeredAt: null, payload: {} }
      ] as Array<Pick<RuntimeEventEntity, "category" | "triggeredAt" | "payload">>
    )

    expect(analytics).toMatchObject({
      assignmentId: "assignment-1",
      projectCount: 3,
      completedCount: 1,
      completionRate: 1 / 3,
      publishedCount: 1,
      averageScore: 92,
      averageResponseSeconds: 40
    })
    expect(analytics.commonRisks).toEqual([
      { code: "ORDER_COMPLETION", label: "订单完成率", count: 2, ratio: 1 },
      { code: "EVENT_CONTROL", label: "事件控制率", count: 1, ratio: 0.5 }
    ])
    expect(analytics.eventTypes).toEqual([
      { code: "BATTERY_CONSUMPTION_ANOMALY", label: "电池消耗异常", count: 2, ratio: 2 / 3 },
      { code: "ORDER_TASK_CHANGE", label: "订单变化", count: 1, ratio: 1 / 3 }
    ])
  })

  it("returns an empty but stable result before students reach review", () => {
    expect(computeLogisticsCohortAnalytics("assignment-2", [], [], [])).toEqual({
      assignmentId: "assignment-2",
      projectCount: 0,
      completedCount: 0,
      completionRate: 1,
      publishedCount: 0,
      averageScore: null,
      averageResponseSeconds: null,
      commonOmissions: [],
      errorTypes: [],
      commonRisks: [],
      eventTypes: []
    })
  })
})

function metric(code: string, label: string, value: number, state: "PASS" | "RISK") {
  return { code, label, value, displayValue: String(value), unit: null, state, detail: "" }
}
