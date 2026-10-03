import { describe, expect, it } from "vitest"
import { buildTeacherProgressMilestones } from "./teacher-progress.js"

describe("teacher progress milestones", () => {
  it("uses authoritative show document and report facts", () => {
    const milestones = buildTeacherProgressMilestones("CITY_SHOW", {
      documentStatuses: ["SUBMITTED", "RETURNED", "RESUBMITTED"],
      t60Submitted: true,
      runtimeStatus: "PAUSED",
      flightEndStatus: "DRAFT"
    })

    expect(milestones).toEqual([
      expect.objectContaining({ code: "SHOW_DOCUMENTS", state: "ATTENTION", detail: "1 份待修改" }),
      expect.objectContaining({ code: "SHOW_T_MINUS_60", state: "SUBMITTED" }),
      expect.objectContaining({ code: "SHOW_RUNTIME", state: "PAUSED" }),
      expect.objectContaining({ code: "SHOW_FLIGHT_END_REPORT", state: "IN_PROGRESS" })
    ])
  })

  it("reports every logistics planning and operation milestone", () => {
    const milestones = buildTeacherProgressMilestones("CITY_LOGISTICS", {
      routeDraftExists: true,
      routeSubmitted: true,
      validationStatus: "WITH_RISK",
      scheduleDraftExists: true,
      scheduleSubmitted: false,
      runtimeStatus: "COMPLETED",
      reviewSubmitted: true
    })

    expect(milestones).toEqual([
      expect.objectContaining({ code: "LOGISTICS_ROUTE_SUBMISSION", state: "SUBMITTED" }),
      expect.objectContaining({ code: "LOGISTICS_ROUTE_VALIDATION", state: "WITH_RISK", detail: "存在风险" }),
      expect.objectContaining({ code: "LOGISTICS_SCHEDULE", state: "IN_PROGRESS" }),
      expect.objectContaining({ code: "LOGISTICS_RUNTIME", state: "COMPLETED" }),
      expect.objectContaining({ code: "LOGISTICS_REVIEW", state: "SUBMITTED" })
    ])
  })

  it("reports VTL planning, failed validation and completed execution milestones", () => {
    const blocked = buildTeacherProgressMilestones("VTOL_INSPECTION", {
      allocationStatus: "SUBMITTED",
      routeStatus: "RETURNED",
      validationStatus: "LOCKED",
      executionPlanStatus: "LOCKED",
      runtimeStatus: null,
      reviewSubmitted: false
    })

    expect(blocked).toEqual([
      expect.objectContaining({ code: "VTL_ALLOCATION", state: "SUBMITTED", detail: "方案已提交" }),
      expect.objectContaining({ code: "VTL_ROUTE", state: "ATTENTION", detail: "已退回修改" }),
      expect.objectContaining({ code: "VTL_VALIDATION", state: "ATTENTION", detail: "检查未通过，待修改" }),
      expect.objectContaining({ code: "VTL_RUNTIME", state: "NOT_STARTED" }),
      expect.objectContaining({ code: "VTL_REVIEW", state: "NOT_STARTED" })
    ])

    const completed = buildTeacherProgressMilestones("VTOL_INSPECTION", {
      allocationStatus: "SUBMITTED",
      routeStatus: "SUBMITTED",
      validationStatus: "SUBMITTED",
      executionPlanStatus: "SUBMITTED",
      runtimeStatus: "COMPLETED",
      reviewSubmitted: true
    })

    expect(completed).toEqual([
      expect.objectContaining({ code: "VTL_ALLOCATION", state: "SUBMITTED" }),
      expect.objectContaining({ code: "VTL_ROUTE", state: "SUBMITTED" }),
      expect.objectContaining({ code: "VTL_VALIDATION", state: "SUBMITTED", detail: "计划已提交" }),
      expect.objectContaining({ code: "VTL_RUNTIME", state: "COMPLETED" }),
      expect.objectContaining({ code: "VTL_REVIEW", state: "SUBMITTED" })
    ])
  })
})
