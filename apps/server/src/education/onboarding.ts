import type { AuthUser, OnboardingState } from "@wurenji/shared"

export const onboardingGuideVersion = 2

export function onboardingGuideKey(role: AuthUser["role"]): OnboardingState["guideKey"] {
  return role === "student" ? "student-basics" : "teacher-basics"
}

export function validOnboardingRequest(role: AuthUser["role"], guideKey: string, version: number): boolean {
  return guideKey === onboardingGuideKey(role) && version === onboardingGuideVersion
}
