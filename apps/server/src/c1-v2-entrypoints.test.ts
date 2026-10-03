import "reflect-metadata"
import { describe, expect, it } from "vitest"
import { AppModule } from "./app.module.js"
import { EducationController } from "./education/education.controller.js"

function controllerMethods(controller: { prototype: object }): string[] {
  return Object.getOwnPropertyNames(controller.prototype).filter((name) => name !== "constructor")
}

describe("C1 V2 public entrypoint cleanup", () => {
  it("does not register the legacy practice, simulation, or logistics modules", () => {
    const imports = Reflect.getMetadata("imports", AppModule) as unknown[]
    const moduleNames = imports.map((item) => typeof item === "function" ? item.name : "")

    expect(moduleNames).not.toContain("PracticesModule")
    expect(moduleNames).not.toContain("SimulationModule")
    expect(moduleNames).not.toContain("LogisticsModule")
  })

  it("keeps shared education routes while removing V2 teaching routes", () => {
    const methods = controllerMethods(EducationController)

    expect(methods).toEqual(expect.arrayContaining(["onboarding", "courses", "classes", "students", "questionBanksList"]))
    expect(methods).not.toEqual(expect.arrayContaining(["overview", "templates", "template", "createTemplate", "createPractice", "assignments", "leaderboards", "leaderboard", "updateLeaderboard"]))
  })
})
