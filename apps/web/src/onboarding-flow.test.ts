import { describe, expect, it } from "vitest"
import type { OnboardingState } from "@wurenji/shared"
import { clearOnboardingProgress, loadOnboardingMission, loadOnboardingStep, saveOnboardingMission, saveOnboardingStep } from "./onboarding-flow"

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  }
}

const state: OnboardingState = { guideKey: "student-basics", version: 2, completed: false, skipped: false }

describe("onboarding flow", () => {
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
})
