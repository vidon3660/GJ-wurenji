import { describe, expect, it } from "vitest"
import { allowedStageActions, decideStageTransition, stageDefinitionsFor } from "@wurenji/shared"

describe("V3 stage policy", () => {
  it("defines the fixed show and logistics stage sequences", () => {
    expect(stageDefinitionsFor("CITY_SHOW").map((stage) => stage.code)).toEqual([
      "SHOW_AREA_PLANNING",
      "SHOW_FLIGHT_APPLICATION",
      "SHOW_PREFLIGHT",
      "SHOW_T_MINUS_60",
      "SHOW_RUNTIME",
      "SHOW_FLIGHT_END_REPORT",
      "SHOW_REVIEW"
    ])
    expect(stageDefinitionsFor("CITY_LOGISTICS")).toHaveLength(8)
  })

  it("filters VTL stages to the configured continuous prefix", () => {
    expect(stageDefinitionsFor("VTOL_INSPECTION", ["VTL_AREA_OBJECTS", "VTL_TASK_ALLOCATION"]).map((stage) => stage.code)).toEqual([
      "VTL_AREA_OBJECTS",
      "VTL_TASK_ALLOCATION"
    ])
    expect(stageDefinitionsFor("VTOL_INSPECTION", ["VTL_AREA_OBJECTS", "VTL_TASK_ALLOCATION"])[1]?.prerequisiteCodes).toEqual(["VTL_AREA_OBJECTS"])
  })

  it("only lets the system unlock a stage after prerequisites", () => {
    expect(decideStageTransition("LOCKED", "AVAILABLE", {
      actor: "STUDENT",
      mode: "TRAINING",
      allowResubmission: true,
      prerequisitesSatisfied: true,
      submissionGatePassed: true
    })).toEqual({ allowed: false, code: "ACTOR_DENIED" })
    expect(decideStageTransition("LOCKED", "AVAILABLE", {
      actor: "SYSTEM",
      mode: "TRAINING",
      allowResubmission: true,
      prerequisitesSatisfied: false,
      submissionGatePassed: true
    })).toEqual({ allowed: false, code: "PREREQUISITES_NOT_MET" })
  })

  it("blocks assessment returns unless resubmission was frozen into the assignment", () => {
    expect(decideStageTransition("SUBMITTED", "RETURNED", {
      actor: "TEACHER",
      mode: "ASSESSMENT",
      allowResubmission: false,
      prerequisitesSatisfied: true,
      submissionGatePassed: true
    })).toEqual({ allowed: false, code: "MODE_POLICY_DENIED" })
    expect(decideStageTransition("SUBMITTED", "RETURNED", {
      actor: "TEACHER",
      mode: "ASSESSMENT",
      allowResubmission: true,
      prerequisitesSatisfied: true,
      submissionGatePassed: true
    })).toEqual({ allowed: true, code: "ALLOWED" })
  })

  it("derives allowed actions from actor, mode, and state", () => {
    expect(allowedStageActions("AVAILABLE", "TRAINING", true, "STUDENT")).toEqual(["START"])
    expect(allowedStageActions("SUBMITTED", "ASSESSMENT", false, "TEACHER")).toEqual(["ACCEPT"])
    expect(allowedStageActions("SUBMITTED", "TRAINING", false, "TEACHER")).toEqual(["ACCEPT", "RETURN"])
  })
})
