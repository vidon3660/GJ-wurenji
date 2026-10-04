import { describe, expect, it } from "vitest"
import sharp from "sharp"
import type { ProjectActivityEventEntity } from "../activities/activity-event.entity.js"
import type { StudentProjectEntity } from "../assignments/assignment.entities.js"
import type { ProjectEvaluationEntity, RuntimeAlertEntity, RuntimeEventEntity, RuntimeSessionEntity, StudentRuntimeActionEntity } from "../runtime/runtime.entities.js"
import type { ShowOperationalReportEntity, ShowRuntimeGroupSnapshotEntity } from "../show-runtime/show-runtime.entities.js"
import { createShowReportDocx, createShowReportPdf } from "./show-report.renderer.js"
import { buildShowReplayTimeline, computeShowCohortAnalytics, computeShowObjectiveMetrics, parseShowStudentSummary, reportRenderData } from "./show-review.service.js"

describe("show review metrics and replay", () => {
  it("parses structured student review summaries while keeping legacy text compatible", () => {
    expect(parseShowStudentSummary(JSON.stringify({ schemaVersion: 1, completion: "任务完成", problems: "通信波动", decisions: "先悬停后返航", improvements: "提前检查链路" }))).toEqual({
      completion: "任务完成",
      problems: "通信波动",
      decisions: "先悬停后返航",
      improvements: "提前检查链路"
    })
    expect(parseShowStudentSummary("旧版自由文本总结")).toBeNull()
  })

  it("derives risk recognition, response and landing metrics from authoritative records", () => {
    const event = {
      id: "event-1",
      triggeredAt: new Date("2026-08-12T00:00:01Z"),
      status: "RESOLVED",
      payload: { detectedSimulationTimeMs: 12_000, controlledSimulationTimeMs: 24_000, escalationCount: 0 }
    } as unknown as RuntimeEventEntity
    const action = { eventId: "event-1", simulationTimeMs: 18_000 } as unknown as StudentRuntimeActionEntity
    const alert = { status: "RESOLVED" } as RuntimeAlertEntity
    const report = {
      reportType: "FLIGHT_END",
      status: "SUBMITTED",
      snapshot: { actualTakeoffCount: 100, normalLandedCount: 99, abnormalCount: 1, authoritativeNormalLandedCount: 99, authoritativeAbnormalCount: 1, completionStatus: "ABNORMAL", runtimeStatus: "COMPLETED" }
    } as unknown as ShowOperationalReportEntity
    const metrics = computeShowObjectiveMetrics({
      session: { status: "COMPLETED" } as RuntimeSessionEntity,
      events: [event],
      alerts: [alert],
      actions: [action],
      reports: [report]
    })
    expect(metrics.find((item) => item.code === "RISK_IDENTIFICATION")).toMatchObject({ value: 100, state: "PASS" })
    expect(metrics.find((item) => item.code === "AVG_RESPONSE_SECONDS")).toMatchObject({ value: 6, state: "PASS" })
    expect(metrics.find((item) => item.code === "LANDING_ACCOUNTING")).toMatchObject({ value: "一致", state: "PASS" })
    expect(metrics.find((item) => item.code === "LANDING_ACCURACY")).toMatchObject({ value: "正确", state: "PASS" })
    expect(metrics.find((item) => item.code === "MISSION_RESULT")).toMatchObject({ value: "COMPLETED", state: "PASS" })
  })

  it("surfaces imported trajectory space checks in the objective metrics", () => {
    const metrics = computeShowObjectiveMetrics({
      session: { status: "COMPLETED" } as RuntimeSessionEntity,
      events: [],
      alerts: [],
      actions: [],
      reports: []
    }, [{ code: "SHOW_PROGRAM_AIR_CONFLICT", passed: false, message: "存在机间距不足" }])
    expect(metrics.find((item) => item.code === "PROGRAM_SPATIAL_CHECK")).toMatchObject({ value: "不通过", state: "RISK", detail: expect.stringContaining("存在机间距不足") })
  })

  it("merges state, event, alert, action and reporting evidence chronologically", () => {
    const correlationId = "00000000-0000-0000-0000-000000000001"
    const timeline = buildShowReplayTimeline({
      session: { id: "session-1", createdAt: new Date("2026-08-12T00:00:00Z") } as RuntimeSessionEntity,
      events: [{
        id: "event-1", code: "COMMUNICATION_LOSS", category: "COMMUNICATION_LINK", status: "RESOLVED", severity: "ERROR",
        scheduledSimulationTimeMs: 20_000, triggeredSimulationTimeMs: 20_000, triggeredAt: new Date("2026-08-12T00:00:02Z"), createdAt: new Date("2026-08-12T00:00:02Z"), correlationId,
        payload: { title: "通信链路异常", detail: "链路质量下降", lifecycleStatus: "CONTROLLED" }
      } as RuntimeEventEntity],
      alerts: [{
        id: "alert-1", eventId: "event-1", title: "通信链路异常", detail: "链路质量持续下降，影响范围正在扩大", severity: "ERROR", status: "RESOLVED", simulationTimeMs: 22_000,
        openedAt: new Date("2026-08-12T00:00:03Z"), acknowledgedAt: new Date("2026-08-12T00:00:05Z"), resolvedAt: new Date("2026-08-12T00:00:06Z"), correlationId, payload: { affectedCount: 20 }
      } as RuntimeAlertEntity],
      actions: [{
        id: "action-ack", eventId: "event-1", alertId: "alert-1", actionCode: "ACKNOWLEDGE_ALERT", targetType: "ALERT", targetId: "alert-1", status: "APPLIED", simulationTimeMs: 24_000,
        requestedAt: new Date("2026-08-12T00:00:05Z"), appliedAt: new Date("2026-08-12T00:00:05Z"), createdAt: new Date("2026-08-12T00:00:05Z"), correlationId,
        payload: { reasoning: { observation: "发现通信链路告警", rationale: "需要确认告警", expectedOutcome: "进入处置流程" } }, result: { applied: true, eventControlled: false }
      } as StudentRuntimeActionEntity, {
        id: "action-1", eventId: "event-1", alertId: "alert-1", actionCode: "PAUSE_PROGRAM", targetType: "PROGRAM", targetId: null, status: "APPLIED", simulationTimeMs: 25_000,
        requestedAt: new Date("2026-08-12T00:00:06Z"), appliedAt: new Date("2026-08-12T00:00:06Z"), createdAt: new Date("2026-08-12T00:00:06Z"), correlationId,
        payload: { reasoning: { observation: "发现通信链路持续丢包", rationale: "链路质量仍在持续下降", expectedOutcome: "暂停后风险不再扩大" } }, result: { applied: true, eventControlled: true }
      } as StudentRuntimeActionEntity],
      snapshots: [{
        id: "snapshot-1", simulationTimeMs: 10_000, createdAt: new Date("2026-08-12T00:00:01Z"), phase: "BATCH_TAKEOFF", reason: "PHASE",
        totals: { plannedCount: 100, airborneCount: 20, landedCount: 0, returningCount: 0, warningCount: 0, abnormalCount: 0, lostCount: 0 }, groups: []
      } as ShowRuntimeGroupSnapshotEntity],
      reports: [],
      activities: [{
        id: "activity-triggered", eventType: "RUNTIME_EVENT_TRIGGERED", objectType: "RUNTIME_EVENT", objectId: "event-1", actorName: "系统", realTime: new Date("2026-08-12T00:00:02Z"), simulationTimeMs: 20_000,
        stageCode: "SHOW_RUNTIME", correlationId, payload: { title: "通信链路异常", detail: "链路质量下降", severity: "WARNING", affectedCount: 10 }, result: {}
      } as ProjectActivityEventEntity, {
        id: "activity-discovered", eventType: "RUNTIME_EVENT_DISCOVERED", objectType: "RUNTIME_ALERT", objectId: "alert-1", actorName: "系统", realTime: new Date("2026-08-12T00:00:03Z"), simulationTimeMs: 22_000,
        stageCode: "SHOW_RUNTIME", correlationId, payload: { title: "通信链路异常", detail: "链路质量下降", affectedCount: 10 }, result: { eventId: "event-1", severity: "WARNING" }
      } as ProjectActivityEventEntity, {
        id: "activity-escalated", eventType: "RUNTIME_EVENT_ESCALATED", objectType: "RUNTIME_EVENT", objectId: "event-1", actorName: "系统", realTime: new Date("2026-08-12T00:00:04Z"), simulationTimeMs: 23_000,
        stageCode: "SHOW_RUNTIME", correlationId, payload: {}, result: { severity: "ERROR", affectedCount: 20 }
      } as ProjectActivityEventEntity, {
        id: "activity-old-attempt", eventType: "RUNTIME_EVENT_ESCALATED", objectType: "RUNTIME_EVENT", objectId: "event-old", actorName: "系统", realTime: new Date("2026-08-11T00:00:04Z"), simulationTimeMs: 23_000,
        stageCode: "SHOW_RUNTIME", correlationId: "00000000-0000-0000-0000-000000000099", payload: {}, result: { severity: "CRITICAL", affectedCount: 100 }
      } as ProjectActivityEventEntity, {
        id: "stage-old-attempt", eventType: "STAGE_STARTED", actorName: "系统", realTime: new Date("2026-08-11T00:00:01Z"), simulationTimeMs: 1_000,
        stageCode: "SHOW_RUNTIME", correlationId: null, payload: {}, result: {}
      } as ProjectActivityEventEntity, {
        id: "activity-1", eventType: "FLIGHT_END_REPORT_SUBMITTED", actorName: "学生", realTime: new Date("2026-08-12T00:00:05Z"), simulationTimeMs: 30_000,
        stageCode: "SHOW_FLIGHT_END_REPORT", correlationId: null, result: {}
      } as ProjectActivityEventEntity]
    })
    expect(timeline.filter((item) => item.kind === "EVENT").map((item) => item.status)).toEqual(["TRIGGERED", "ESCALATED", "CONTROLLED"])
    expect(timeline.filter((item) => item.kind === "ALERT").map((item) => item.status)).toEqual(["OPEN", "ESCALATED", "ACKNOWLEDGED", "RESOLVED"])
    expect(timeline.find((item) => item.kind === "ALERT" && item.status === "OPEN")?.detail).toBe("链路质量下降")
    expect(timeline.some((item) => item.sourceId === "activity-old-attempt")).toBe(false)
    expect(timeline.some((item) => item.sourceId === "stage-old-attempt")).toBe(false)
    const actionNode = timeline.find((item) => item.kind === "ACTION" && item.sourceId === "action-1")!
    expect(actionNode).toMatchObject({ title: "暂停表演", simulationTimeMs: 25_000 })
    expect(actionNode.detail).toContain("异常发现：发现通信链路持续丢包")
    expect(actionNode.detail).toContain("结果确认：动作已执行，事件已控制")
    expect(actionNode.payload).toMatchObject({ reasoning: { expectedOutcome: "暂停后风险不再扩大" }, result: { eventControlled: true }, runtimeEvidenceSequence: 3 })
    expect(timeline.find((item) => item.id === "EVENT_TRIGGERED:activity-triggered")?.payload).toMatchObject({ runtimeEvidenceSequence: 1 })
    expect(timeline.find((item) => item.id === "EVENT_CONTROLLED:action-1")?.payload).toMatchObject({ runtimeEvidenceSequence: 3 })
    expect(timeline.find((item) => item.id === "ALERT_ACKNOWLEDGED:action-ack")?.payload).toMatchObject({ runtimeEvidenceSequence: 2 })
  })

  it("keeps authoritative business consequences in replay and the single report", () => {
    const businessConsequences = [
      "G01-A001：已退出当前表演任务并计入提前降落",
      "编队 1：本次处置形成 1 架编队缺口，图案完整性需按当前空中 99/100 架复核"
    ]
    const action = {
      id: "action-land",
      eventId: "event-battery",
      alertId: "alert-battery",
      actionCode: "SINGLE_LAND",
      targetType: "AIRCRAFT",
      targetId: "G01-A001",
      status: "APPLIED",
      simulationTimeMs: 40_000,
      requestedAt: new Date("2026-09-12T00:00:40Z"),
      appliedAt: new Date("2026-09-12T00:00:41Z"),
      createdAt: new Date("2026-09-12T00:00:40Z"),
      correlationId: "00000000-0000-0000-0000-000000000024",
      payload: { reasoning: { observation: "发现单机电池异常", rationale: "安全余度不足", expectedOutcome: "单机安全退出" } },
      result: { applied: true, businessConsequences, eventControlled: true, withinDeadline: true, responseTimeMs: 7_200 }
    } as unknown as StudentRuntimeActionEntity
    const timeline = buildShowReplayTimeline({ session: null, events: [], alerts: [], actions: [action], snapshots: [], reports: [], activities: [] })
    const actionNode = timeline.find((item) => item.kind === "ACTION")
    expect(actionNode?.detail).toContain(businessConsequences[0])
    expect(actionNode?.detail).toContain("1 架编队缺口")
    expect(actionNode?.detail).toContain("事件已控制")
    expect(actionNode?.detail).toContain("响应 7.2 秒")

    const report = reportRenderData({
      project: { title: "城市表演任务", studentName: "测试学生" },
      evaluation: { objectiveMetrics: [], teacherScores: [] },
      actions: [{ ...action, requestedAt: action.requestedAt.toISOString() }]
    })
    const handling = report.sections.find((section) => section.title === "事件处置")
    const reportText = handling?.paragraphs?.join("；") ?? ""
    expect(reportText).toContain(businessConsequences[0])
    expect(reportText).toContain("1 架编队缺口")
    expect(reportText).toContain("时限内完成")
    expect(reportText).toContain("响应 7.2 秒")
  })
})

describe("show cohort analytics", () => {
  it("separates workflow omissions from objective and teacher-confirmed error types", () => {
    const analytics = computeShowCohortAnalytics(
      "assignment-1",
      [
        { id: "project-1", status: "GRADED" },
        { id: "project-2", status: "IN_PROGRESS" },
        { id: "project-3", status: "NOT_STARTED" }
      ] as StudentProjectEntity[],
      [
        {
          projectId: "project-1",
          status: "PUBLISHED",
          totalScore: 80,
          objectiveMetrics: [{ code: "ALERT_ACKNOWLEDGEMENT", label: "告警确认率", value: 50, displayValue: "50%", unit: "%", state: "RISK", detail: "1/2" }],
          teacherScores: [{ code: "DOCUMENTS", label: "申报材料", maxScore: 20, score: 8, comment: "存在漏项" }],
          studentSubmittedAt: new Date("2026-08-14T01:00:00Z")
        },
        {
          projectId: "project-2",
          status: "PENDING",
          totalScore: null,
          objectiveMetrics: [{ code: "AVG_RESPONSE_SECONDS", label: "平均首次处置时效", value: 90, displayValue: "90 秒", unit: "秒", state: "RISK", detail: "响应偏慢" }],
          teacherScores: [],
          studentSubmittedAt: null
        }
      ] as ProjectEvaluationEntity[],
      [{ category: "COMMUNICATION_LINK", triggeredAt: new Date("2026-08-14T00:30:00Z") }] as RuntimeEventEntity[],
      [
        { projectId: "project-1", stageCode: "SHOW_AREA_PLANNING", status: "ACCEPTED" },
        { projectId: "project-2", stageCode: "SHOW_AREA_PLANNING", status: "SUBMITTED" }
      ],
      [
        { projectId: "project-1", templateCode: "AIRSPACE_APPLICATION_FORM", status: "SUBMITTED" },
        { projectId: "project-1", templateCode: "AIRSPACE_APPLICATION_LETTER", status: "VIEWED" },
        { projectId: "project-1", templateCode: "SAFETY_EMERGENCY_PLAN", status: "RETURNED" },
        { projectId: "project-2", templateCode: "AIRSPACE_APPLICATION_FORM", status: "RESUBMITTED" }
      ],
      [{ projectId: "project-1", status: "COMPLETED" }, { projectId: "project-2", status: "DRAFT" }],
      [{ projectId: "project-1", submittedAt: new Date("2026-08-14T00:10:00Z") }, { projectId: "project-2", submittedAt: null }],
      [{ projectId: "project-1", reportType: "FLIGHT_END", status: "SUBMITTED" }]
    )

    expect(analytics).toMatchObject({ projectCount: 3, completedCount: 1, completionRate: 0.3333, averageScore: 80, averageResponseSeconds: 90 })
    expect(analytics.commonOmissions.find((item) => item.code === "DOCUMENT:SAFETY_EMERGENCY_PLAN")).toMatchObject({ count: 2, ratio: 0.6667 })
    expect(analytics.commonOmissions.find((item) => item.code === "TASK_NOT_STARTED")).toMatchObject({ count: 1 })
    expect(analytics.commonOmissions.find((item) => item.code === "PREFLIGHT")).toMatchObject({ count: 1 })
    expect(analytics.errorTypes).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "OBJECTIVE:ALERT_ACKNOWLEDGEMENT", count: 1 }),
      expect.objectContaining({ code: "OBJECTIVE:AVG_RESPONSE_SECONDS", count: 1 }),
      expect.objectContaining({ code: "TEACHER:DOCUMENTS", label: "申报材料（教师低分）", count: 1 })
    ]))
    expect(analytics.eventTypes).toEqual([expect.objectContaining({ code: "COMMUNICATION_LINK", count: 1 })])
  })
})

describe("show project report renderer", () => {
  it("creates valid DOCX and PDF files with an embedded planning map", async () => {
    const planningMap = await sharp({ create: { width: 320, height: 180, channels: 3, background: "#e5eee9" } }).png().toBuffer()
    const data = {
      title: "城市无人机编队表演仿真实训项目报告",
      subtitle: "R3 测试任务 · 测试学生",
      metadata: [{ label: "最终成绩", value: "92.0 / 100" }],
      sections: [{ title: "区域规划", rows: [{ label: "方案版本", value: "V1" }] }, { title: "评价结果", paragraphs: ["处置流程完整。"] }],
      planningMap,
      declaration: "本文件为教学仿真材料。"
    }
    const [docx, pdf] = await Promise.all([createShowReportDocx(data), createShowReportPdf(data)])
    expect(docx.subarray(0, 2).toString("ascii")).toBe("PK")
    expect(docx.includes(Buffer.from("word/media/planning-map.png"))).toBe(true)
    expect(pdf.subarray(0, 4).toString("ascii")).toBe("%PDF")
    expect(pdf.byteLength).toBeGreaterThan(5_000)
  })
})
