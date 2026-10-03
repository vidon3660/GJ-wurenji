import { describe, expect, it } from "vitest"
import { onboardingGuideKey, onboardingGuideVersion, validOnboardingRequest } from "./onboarding.js"

describe("onboarding", () => {
  it("uses the task-based guide version for every role", () => {
    expect(onboardingGuideVersion).toBe(2)
    expect(onboardingGuideKey("teacher")).toBe("teacher-basics")
    expect(onboardingGuideKey("admin")).toBe("teacher-basics")
    expect(onboardingGuideKey("student")).toBe("student-basics")
  })

  it("rejects another role or an obsolete guide version", () => {
    expect(validOnboardingRequest("student", "teacher-basics", 2)).toBe(false)
    expect(validOnboardingRequest("teacher", "teacher-basics", 1)).toBe(false)
    expect(validOnboardingRequest("teacher", "teacher-basics", 2)).toBe(true)
  })
})
