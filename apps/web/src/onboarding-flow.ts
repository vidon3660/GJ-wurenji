import type { OnboardingState, SceneType } from "@wurenji/shared"

export type OnboardingAction = "teacher-first-assignment" | "student-first-stage"

export interface OnboardingMission {
  action: OnboardingAction
  sceneType: SceneType | null
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function onboardingStorageKey(userId: string, state: OnboardingState, suffix: string): string {
  return `wurenji:onboarding:${userId}:${state.guideKey}:v${state.version}:${suffix}`
}

export function loadOnboardingStep(storage: StorageLike, userId: string, state: OnboardingState, stepCount: number): number {
  const value = Number(storage.getItem(onboardingStorageKey(userId, state, "step")))
  return Number.isInteger(value) && value >= 0 && value < stepCount ? value : 0
}

export function saveOnboardingStep(storage: StorageLike, userId: string, state: OnboardingState, step: number): void {
  storage.setItem(onboardingStorageKey(userId, state, "step"), String(step))
}

export function clearOnboardingProgress(storage: StorageLike, userId: string, state: OnboardingState): void {
  storage.removeItem(onboardingStorageKey(userId, state, "step"))
  clearOnboardingMission(storage, userId, state)
}

export function clearOnboardingMission(storage: StorageLike, userId: string, state: OnboardingState): void {
  storage.removeItem(onboardingStorageKey(userId, state, "mission"))
}

export function loadOnboardingMission(storage: StorageLike, userId: string, state: OnboardingState): OnboardingMission | null {
  const serialized = storage.getItem(onboardingStorageKey(userId, state, "mission"))
  if (!serialized) return null
  try {
    const value = JSON.parse(serialized) as Partial<OnboardingMission>
    if (value.action !== "teacher-first-assignment" && value.action !== "student-first-stage") return null
    return { action: value.action, sceneType: value.sceneType ?? null }
  } catch {
    return null
  }
}

export function saveOnboardingMission(storage: StorageLike, userId: string, state: OnboardingState, mission: OnboardingMission): void {
  storage.setItem(onboardingStorageKey(userId, state, "mission"), JSON.stringify(mission))
}
