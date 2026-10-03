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

const fallbackValues = new Map<string, string>()
const fallbackStorage: StorageLike = {
  getItem: (key) => fallbackValues.get(key) ?? null,
  setItem: (key, value) => fallbackValues.set(key, value),
  removeItem: (key) => fallbackValues.delete(key)
}

/**
 * localStorage can be unavailable in an embedded webview, private browsing
 * session, or when the browser has blocked storage for this origin. The guide
 * should remain usable in all three cases; the in-memory store keeps the
 * current session usable and the persistence helpers below silently degrade.
 */
export function getOnboardingStorage(): StorageLike {
  if (typeof window === "undefined") return fallbackStorage
  try {
    return window.localStorage
  } catch {
    return fallbackStorage
  }
}

function read(storage: StorageLike, key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function write(storage: StorageLike, key: string, value: string): void {
  try {
    storage.setItem(key, value)
  } catch {
    // Storage is an enhancement. Do not block the guided operation when it is unavailable.
  }
}

function remove(storage: StorageLike, key: string): void {
  try {
    storage.removeItem(key)
  } catch {
    // See write().
  }
}

function onboardingStorageKey(userId: string, state: OnboardingState, suffix: string): string {
  return `wurenji:onboarding:${userId}:${state.guideKey}:v${state.version}:${suffix}`
}

export function loadOnboardingStep(storage: StorageLike, userId: string, state: OnboardingState, stepCount: number): number {
  const value = Number(read(storage, onboardingStorageKey(userId, state, "step")))
  return Number.isInteger(value) && value >= 0 && value < stepCount ? value : 0
}

export function saveOnboardingStep(storage: StorageLike, userId: string, state: OnboardingState, step: number): void {
  write(storage, onboardingStorageKey(userId, state, "step"), String(step))
}

export function clearOnboardingProgress(storage: StorageLike, userId: string, state: OnboardingState): void {
  remove(storage, onboardingStorageKey(userId, state, "step"))
  clearOnboardingMission(storage, userId, state)
}

export function clearOnboardingMission(storage: StorageLike, userId: string, state: OnboardingState): void {
  remove(storage, onboardingStorageKey(userId, state, "mission"))
}

export function loadOnboardingMission(storage: StorageLike, userId: string, state: OnboardingState): OnboardingMission | null {
  const serialized = read(storage, onboardingStorageKey(userId, state, "mission"))
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
  write(storage, onboardingStorageKey(userId, state, "mission"), JSON.stringify(mission))
}
