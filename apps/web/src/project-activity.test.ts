import { describe, expect, it } from "vitest"
import { v3ActivityEventTypes, type V3ActivityEventType, type V3ActivityEventView } from "@wurenji/shared"
import { projectActivityLabel, projectActivitySummary } from "./project-activity"

describe("project activity presentation", () => {
  it("provides a Chinese label for every supported event type", () => {
    expect(v3ActivityEventTypes.length).toBeGreaterThan(70)
    for (const eventType of v3ActivityEventTypes) {
      expect(projectActivityLabel(eventType), eventType).toMatch(/[\u4e00-\u9fff]/)
    }
  })

  it.each([
    ["AREA_DRAFT_SAVED", {}, { featureCount: 4, annotationCount: 1 }, "4 个区域要素 · 1 个标注"],
    ["DOCUMENT_SUBMITTED", {}, { versionNo: 2 }, "文档版本 V2"],
    ["ASSESSMENT_RETAKE_CREATED", { reason: "原考核期间网络中断" }, { attemptNumber: 2 }, "第 2 次考核 · 原考核期间网络中断"],
    ["RUNTIME_RESTARTED", {}, { attemptNo: 2, nodeLabel: "事件处置前" }, "第 2 次训练 · 事件处置前"],
    ["RUNTIME_EVENT_RESOLVED", {}, { recoveryMode: "AUTO" }, "控制方式：AUTO"],
    ["RUNTIME_ACTION_APPLIED", { actionCode: "RETURN_AIRCRAFT" }, { eventControlled: true }, "RETURN_AIRCRAFT · 事件已控制"],
    ["LOGISTICS_RUNTIME_RESTARTED", {}, { attemptNo: 3, nodeCode: "CHECKPOINT_2" }, "第 3 次训练 · CHECKPOINT_2"],
    ["LOGISTICS_SCHEDULE_BATCH_ADJUSTED", {}, { orderCount: 6, takeoffShiftMs: 300000 }, "6 条任务 · +5 分钟 时刻偏移"],
    ["LOGISTICS_SCHEDULE_BATCH_ADJUSTED", {}, { orderCount: 2, takeoffShiftMs: -600000 }, "2 条任务 · -10 分钟 时刻偏移"],
    ["LOGISTICS_RUNTIME_EVENT_RESOLVED", {}, { eventSubtype: "WIND_GUST" }, "WIND_GUST · 已控制"],
    ["QUESTION_ATTEMPT_REGRADED", {}, { autoScore: 30, pendingCount: 0 }, "自动得分 30 · 待证据 0 题"],
    ["REPORT_GENERATED", {}, { format: "PDF", filename: "项目报告.pdf" }, "PDF · 项目报告.pdf"]
  ] as const)("summarizes %s with its business evidence", (eventType, payload, result, expected) => {
    expect(projectActivitySummary(activity(eventType, payload, result))).toBe(expected)
  })

  it("uses a nonempty deterministic fallback", () => {
    expect(projectActivitySummary(activity("ASSIGNMENT_ARCHIVED", {}, {}))).toBe("关键操作已留痕")
  })
})

function activity(eventType: V3ActivityEventType, payload: Record<string, unknown>, result: Record<string, unknown>): V3ActivityEventView {
  return {
    id: "activity-1",
    assignmentId: "assignment-1",
    projectId: "project-1",
    stageCode: null,
    actorId: "user-1",
    actorName: "测试用户",
    actorRole: "student",
    eventType,
    objectType: "PROJECT",
    objectId: "project-1",
    realTime: "2026-08-14T08:00:00.000Z",
    simulationTimeMs: null,
    beforeRevision: null,
    afterRevision: null,
    payload,
    result,
    correlationId: null
  }
}
