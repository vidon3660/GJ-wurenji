import { describe, expect, it } from "vitest"
import type { AssignmentDraftConfig, ResourcePackageType, V3ResourceReference } from "@wurenji/shared"
import { validateRequiredResourceTypes } from "./assignment.service.js"

describe("assignment resource validation", () => {
  it("requires exactly one REPORT resource", () => {
    const refs = logisticsReferences()
    expect(() => validateRequiredResourceTypes("CITY_LOGISTICS", config(), refs)).not.toThrow()
    expect(() => validateRequiredResourceTypes("CITY_LOGISTICS", config(), [...refs, reference("REPORT", "report-2")])).toThrow("只能引用一个")
  })

  it("freezes exactly the selected show program when configured", () => {
    const showConfig = { ...config(), scaleTemplateCode: "SHOW_100", showProgramPackageId: "program-1" }
    const refs = showReferences()

    expect(() => validateRequiredResourceTypes("CITY_SHOW", showConfig, refs)).not.toThrow()
    expect(() => validateRequiredResourceTypes("CITY_SHOW", showConfig, refs.filter((item) => item.packageType !== "SHOW_PROGRAM"))).toThrow("舞步程序")
    expect(() => validateRequiredResourceTypes("CITY_SHOW", { ...showConfig, showProgramPackageId: null }, refs)).toThrow("不能引用舞步程序")
  })
})

function logisticsReferences(): V3ResourceReference[] {
  return ["RULE", "REGION", "SCALE_TEMPLATE", "AIRCRAFT", "EVENT", "REPORT"].map((type) => reference(type as ResourcePackageType, type === "REGION" ? "region-1" : type.toLowerCase()))
}

function showReferences(): V3ResourceReference[] {
  return ["RULE", "REGION", "SCALE_TEMPLATE", "AIRCRAFT", "EVENT", "SHOW_PROGRAM", "DOCUMENT_TEMPLATE", "REPORT"]
    .map((type) => reference(type as ResourcePackageType, type === "REGION" ? "region-1" : type === "SHOW_PROGRAM" ? "program-1" : type.toLowerCase()))
}

function reference(packageType: ResourcePackageType, packageId: string): V3ResourceReference {
  return { packageId, packageType, name: packageType, version: "1.0.0", sha256: "a".repeat(64) }
}

function config(): AssignmentDraftConfig {
  return {
    taskBrief: "物流训练",
    scaleTemplateCode: "LOGISTICS_3",
    regionPackageId: "region-1",
    availableAt: "2026-08-13T00:00:00.000Z",
    dueAt: "2026-08-14T00:00:00.000Z",
    assessmentDurationMinutes: 120,
    allowResubmission: true,
    allowedValidationAttempts: 3,
    allowedRuntimeAttempts: 2,
    resultVisibility: "FULL_REVIEW",
    scenario: {}
  }
}
