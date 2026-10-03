import { describe, expect, it } from "vitest"
import { sceneEducationProfile } from "./scene-education"

describe("scene education profiles", () => {
  it("keeps the three teaching objectives distinct", () => {
    expect(sceneEducationProfile("CITY_SHOW").focus).toContain("编队图案")
    expect(sceneEducationProfile("CITY_LOGISTICS").focus).toContain("订单时窗")
    expect(sceneEducationProfile("VTOL_INSPECTION").focus).toContain("地形净距")
    expect(sceneEducationProfile("CITY_SHOW").objective).not.toContain("订单")
  })

  it("names the student and system roles for NPC interaction", () => {
    const profile = sceneEducationProfile("CITY_LOGISTICS")
    expect(profile.studentRole).toBe("低空物流调度员")
    expect(profile.systemRoles).toContain("仓站调度员")
  })
})
