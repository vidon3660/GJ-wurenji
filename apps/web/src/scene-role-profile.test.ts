import { describe, expect, it } from "vitest"
import { sceneRoleProfile } from "./scene-role-profile"

describe("scene role profile", () => {
  it("explains the different teaching roles for each scene", () => {
    expect(sceneRoleProfile("CITY_SHOW")).toMatchObject({ studentRole: "编队运行规划员" })
    expect(sceneRoleProfile("CITY_LOGISTICS")).toMatchObject({ studentRole: "物流调度与运行控制员" })
    expect(sceneRoleProfile("VTOL_INSPECTION")).toMatchObject({ studentRole: "巡检任务飞行控制员" })
  })

  it("always declares system roles and scene constraints", () => {
    for (const sceneType of ["CITY_SHOW", "CITY_LOGISTICS", "VTOL_INSPECTION"] as const) {
      const profile = sceneRoleProfile(sceneType)
      expect(profile.systemRoles.length).toBeGreaterThanOrEqual(3)
      expect(profile.objective.length).toBeGreaterThan(10)
      expect(profile.coreObjects.length).toBeGreaterThan(2)
      expect(profile.keyConstraints.length).toBeGreaterThan(2)
    }
  })
})
