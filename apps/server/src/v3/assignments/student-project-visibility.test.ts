import { describe, expect, it } from "vitest"
import { filterVisibleStudentProjects } from "./student-project-visibility.js"

describe("student project visibility", () => {
  it("hides demo and acceptance projects from the default student list", () => {
    const projects = [
      { id: "formal", snapshot: { isDemo: false, isAcceptanceData: false } },
      { id: "demo", snapshot: { isDemo: true, isAcceptanceData: false } },
      { id: "acceptance", snapshot: { isDemo: false, isAcceptanceData: true } }
    ]

    expect(filterVisibleStudentProjects(projects).map((project) => project.id)).toEqual(["formal"])
  })

  it("returns internal projects only when explicitly requested", () => {
    const projects = [
      { id: "formal", snapshot: { isDemo: false, isAcceptanceData: false } },
      { id: "acceptance", snapshot: { isDemo: false, isAcceptanceData: true } }
    ]

    expect(filterVisibleStudentProjects(projects, true).map((project) => project.id)).toEqual(["formal", "acceptance"])
  })
})
