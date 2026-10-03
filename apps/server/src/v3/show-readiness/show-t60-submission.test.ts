import { describe, expect, it } from "vitest"
import type { ShowT60ConfirmationView } from "@wurenji/shared"
import { createShowT60SubmissionSnapshot, parseLegacyShowT60Confirmation, parseShowT60SubmissionSnapshot } from "./show-t60-submission.js"

describe("show T-60 submission snapshots", () => {
  const confirmation: ShowT60ConfirmationView = {
    projectName: "滨水编队表演",
    plannedStartAt: "2026-08-14T10:00:00.000Z",
    plannedEndAt: "2026-08-14T10:30:00.000Z",
    takeoffPoint: { longitude: 114.1, latitude: 22.6 },
    airspaceBoundary: [{ longitude: 114.09, latitude: 22.59 }, { longitude: 114.11, latitude: 22.61 }],
    maximumHeightMeters: 120,
    aircraftModel: "HG-UAV",
    aircraftCount: 100,
    contactName: "教学联系人",
    contactPhone: "13800000000",
    environment: { 风向: "东风", 降雨状态: "无降雨" }
  }

  it("round-trips immutable submission metadata and confirmation", () => {
    const snapshot = createShowT60SubmissionSnapshot({
      reportCode: "T60-ABCDEF12-02",
      submittedAt: "2026-08-14T09:00:00.000Z",
      submittedBy: { id: "student-1", displayName: "学生一" },
      simulationTimeMs: 900_000,
      confirmation
    })
    confirmation.projectName = "提交后被修改"
    expect(parseShowT60SubmissionSnapshot(snapshot)).toMatchObject({
      snapshotVersion: 1,
      submission: { reportCode: "T60-ABCDEF12-02", submittedBy: { displayName: "学生一" }, simulationTimeMs: 900_000 },
      confirmation: { projectName: "滨水编队表演", aircraftCount: 100 }
    })
  })

  it("keeps legacy confirmation-only records readable without inventing metadata", () => {
    expect(parseShowT60SubmissionSnapshot(confirmation)).toBeNull()
    expect(parseLegacyShowT60Confirmation(confirmation)).toMatchObject({ projectName: "提交后被修改", aircraftModel: "HG-UAV" })
  })
})
