import { describe, expect, it } from "vitest"
import { teacherProgressCsv } from "./teacher-progress-export"
import type { V3TeacherProgressItem } from "@wurenji/shared"

const item = (overrides: Partial<V3TeacherProgressItem> = {}): V3TeacherProgressItem => ({
  projectId: "project-1",
  studentId: "student-1",
  studentName: "张三,甲",
  assignmentId: "assignment-1",
  assignmentSnapshotId: "snapshot-1",
  assignmentTitle: "物流任务",
  sceneType: "CITY_LOGISTICS",
  mode: "TRAINING",
  isDemo: false,
  isAcceptanceData: false,
  projectStatus: "IN_PROGRESS",
  currentStageCode: "LOGISTICS_REGION_ANALYSIS",
  currentStageTitle: "区域分析",
  submissionState: "IN_PROGRESS",
  alertState: "OPEN",
  alerts: [{ id: "alert-1" } as V3TeacherProgressItem["alerts"][number]],
  evaluationState: "PENDING",
  milestones: [],
  assessmentAttempt: null as unknown as V3TeacherProgressItem["assessmentAttempt"],
  assessmentTiming: null as unknown as V3TeacherProgressItem["assessmentTiming"],
  canCreateAssessmentRetake: false,
  lastActivityAt: "2026-10-04T00:00:00.000Z",
  ...overrides
})

describe("teacherProgressCsv", () => {
  it("exports filtered teaching fields with a UTF-8-friendly header and escaped cells", () => {
    const csv = teacherProgressCsv([item()], (value) => `时间 ${value}`)
    expect(csv.startsWith("学生,任务,场景")).toBe(true)
    expect(csv).toContain('"张三,甲"')
    expect(csv).toContain("城市低空物流,区域分析,进行中,待评价,1,时间 2026-10-04T00:00:00.000Z,project-1")
    expect(csv.endsWith("\r\n")).toBe(true)
  })

  it("returns the header when there are no matching rows", () => {
    expect(teacherProgressCsv([])).toBe("学生,任务,场景,当前阶段,提交状态,评价状态,开放告警,最近活动,项目ID\r\n")
  })
})
