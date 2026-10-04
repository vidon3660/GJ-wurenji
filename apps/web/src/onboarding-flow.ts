import type { OnboardingState, SceneType } from "@wurenji/shared"

/**
 * Actions in the first-run guide are deliberately tied to a real control in
 * the product.  Keep the original stage action for users who started guide
 * version 2 before the question-bank path was added.
 */
export type OnboardingAction = "teacher-first-question-bank" | "teacher-first-assignment" | "student-first-questionnaire" | "student-first-stage"

export interface OnboardingMission {
  action: OnboardingAction
  sceneType: SceneType | null
}

export function shouldShowOnboardingGuide(context: {
  completed: boolean
  hasMission: boolean
  inWorkspace: boolean
  isTeacher: boolean
  studentProjectId: string | null
  deferred: boolean
  deferredProjectId: string | null
}): boolean {
  if (context.completed || context.hasMission || context.inWorkspace) return false
  if (!context.isTeacher && !context.studentProjectId) return false
  if (context.deferred && (context.isTeacher || context.deferredProjectId === context.studentProjectId)) return false
  return true
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

function parseSceneType(value: unknown): SceneType | null {
  return value === "CITY_SHOW" || value === "CITY_LOGISTICS" || value === "VTOL_INSPECTION" ? value : null
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
  clearOnboardingDeferred(storage, userId, state)
}

/**
 * Record that the guide was intentionally postponed.  The marker is scoped to
 * the guide version and account so a refresh does not interrupt the learner,
 * while a newly assigned student project can still trigger the guide again.
 * Teachers use the stable `teacher` marker because they do not have a project
 * id to scope the decision to.
 */
export function loadOnboardingDeferred(storage: StorageLike, userId: string, state: OnboardingState): string | null {
  const value = read(storage, onboardingStorageKey(userId, state, "deferred"))
  return value && value.trim() ? value : null
}

export function saveOnboardingDeferred(storage: StorageLike, userId: string, state: OnboardingState, projectId: string | null): void {
  write(storage, onboardingStorageKey(userId, state, "deferred"), projectId ?? "teacher")
}

export function clearOnboardingDeferred(storage: StorageLike, userId: string, state: OnboardingState): void {
  remove(storage, onboardingStorageKey(userId, state, "deferred"))
}

export function clearOnboardingMission(storage: StorageLike, userId: string, state: OnboardingState): void {
  remove(storage, onboardingStorageKey(userId, state, "mission"))
}

export function loadOnboardingMission(storage: StorageLike, userId: string, state: OnboardingState): OnboardingMission | null {
  const serialized = read(storage, onboardingStorageKey(userId, state, "mission"))
  if (!serialized) return null
  try {
    const value = JSON.parse(serialized) as Partial<OnboardingMission>
    if (value.action !== "teacher-first-question-bank" && value.action !== "teacher-first-assignment" && value.action !== "student-first-questionnaire" && value.action !== "student-first-stage") return null
    return { action: value.action, sceneType: parseSceneType(value.sceneType) }
  } catch {
    return null
  }
}

export function saveOnboardingMission(storage: StorageLike, userId: string, state: OnboardingState, mission: OnboardingMission): void {
  write(storage, onboardingStorageKey(userId, state, "mission"), JSON.stringify(mission))
}
