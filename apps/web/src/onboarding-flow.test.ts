import { describe, expect, it } from "vitest"
import type { OnboardingState } from "@wurenji/shared"
import { clearOnboardingDeferred, clearOnboardingProgress, loadOnboardingDeferred, loadOnboardingMission, loadOnboardingStep, saveOnboardingDeferred, saveOnboardingMission, saveOnboardingStep, shouldShowOnboardingGuide } from "./onboarding-flow"

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  }
}

const state: OnboardingState = { guideKey: "student-basics", version: 2, completed: false, skipped: false }
const guideContext = { completed: false, hasMission: false, inWorkspace: false, isTeacher: false, studentProjectId: "project-1", deferred: false, deferredProjectId: null }

describe("onboarding flow", () => {
  it("starts a student guide only when a usable project is available", () => {
    expect(shouldShowOnboardingGuide({ ...guideContext, studentProjectId: null })).toBe(false)
    expect(shouldShowOnboardingGuide(guideContext)).toBe(true)
    expect(shouldShowOnboardingGuide({ ...guideContext, isTeacher: true, studentProjectId: null })).toBe(true)
  })

  it("keeps periodic refresh quiet after the guide is deferred", () => {
    const deferred = { ...guideContext, deferred: true, deferredProjectId: "project-1" }
    expect(shouldShowOnboardingGuide(deferred)).toBe(false)
    expect(shouldShowOnboardingGuide({ ...deferred, studentProjectId: "project-2" })).toBe(true)
    expect(shouldShowOnboardingGuide({ ...deferred, isTeacher: true, studentProjectId: "project-2" })).toBe(false)
  })

  it("persists a postpone choice per account and guide version", () => {
    const storage = memoryStorage()
    saveOnboardingDeferred(storage, "student-1", state, "project-1")
    expect(loadOnboardingDeferred(storage, "student-1", state)).toBe("project-1")
    expect(loadOnboardingDeferred(storage, "student-2", state)).toBeNull()
    expect(loadOnboardingDeferred(storage, "student-1", { ...state, version: 3 })).toBeNull()
    clearOnboardingDeferred(storage, "student-1", state)
    expect(loadOnboardingDeferred(storage, "student-1", state)).toBeNull()
  })

  it("keeps a resumed workspace and an active mission free of automatic popups", () => {
    expect(shouldShowOnboardingGuide({ ...guideContext, inWorkspace: true })).toBe(false)
    expect(shouldShowOnboardingGuide({ ...guideContext, hasMission: true })).toBe(false)
    expect(shouldShowOnboardingGuide({ ...guideContext, completed: true })).toBe(false)
  })

  it("restores only a valid step for the current guide version", () => {
    const storage = memoryStorage()
    saveOnboardingStep(storage, "student-1", state, 2)
    expect(loadOnboardingStep(storage, "student-1", state, 4)).toBe(2)
    expect(loadOnboardingStep(storage, "student-1", { ...state, version: 3 }, 4)).toBe(0)
    saveOnboardingStep(storage, "student-1", state, 9)
    expect(loadOnboardingStep(storage, "student-1", state, 4)).toBe(0)
  })

  it("persists a real-operation mission and clears all progress on completion", () => {
    const storage = memoryStorage()
    saveOnboardingStep(storage, "student-1", state, 1)
    saveOnboardingMission(storage, "student-1", state, { action: "student-first-stage", sceneType: "CITY_LOGISTICS" })
    expect(loadOnboardingMission(storage, "student-1", state)).toEqual({ action: "student-first-stage", sceneType: "CITY_LOGISTICS" })
    clearOnboardingProgress(storage, "student-1", state)
    expect(loadOnboardingStep(storage, "student-1", state, 4)).toBe(0)
    expect(loadOnboardingMission(storage, "student-1", state)).toBeNull()
    expect(loadOnboardingDeferred(storage, "student-1", state)).toBeNull()
  })

  it("keeps the guide usable when browser storage throws", () => {
    const unavailableStorage = {
      getItem: () => { throw new Error("storage blocked") },
      setItem: () => { throw new Error("storage blocked") },
      removeItem: () => { throw new Error("storage blocked") }
    }
    expect(() => saveOnboardingStep(unavailableStorage, "student-1", state, 1)).not.toThrow()
    expect(() => saveOnboardingMission(unavailableStorage, "student-1", state, { action: "student-first-stage", sceneType: null })).not.toThrow()
    expect(loadOnboardingStep(unavailableStorage, "student-1", state, 4)).toBe(0)
    expect(loadOnboardingMission(unavailableStorage, "student-1", state)).toBeNull()
    expect(() => clearOnboardingProgress(unavailableStorage, "student-1", state)).not.toThrow()
  })

  it("does not mix progress between accounts", () => {
    const storage = memoryStorage()
    saveOnboardingStep(storage, "teacher-1", state, 2)
    saveOnboardingStep(storage, "teacher-2", state, 1)
    expect(loadOnboardingStep(storage, "teacher-1", state, 4)).toBe(2)
    expect(loadOnboardingStep(storage, "teacher-2", state, 4)).toBe(1)
  })

  it("normalizes a stale mission scene before it reaches the workspace", () => {
    const storage = memoryStorage()
    storage.setItem("wurenji:onboarding:student-1:student-basics:v2:mission", JSON.stringify({ action: "student-first-stage", sceneType: "OLD_SCENE" }))
    expect(loadOnboardingMission(storage, "student-1", state)).toEqual({ action: "student-first-stage", sceneType: null })
  })
})
