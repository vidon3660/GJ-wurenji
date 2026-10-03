export function resolveStageSelectionAfterRefresh(
  selectedStageCode: string,
  previousCurrentStageCode: string | undefined,
  refreshedCurrentStageCode: string,
  isStudent: boolean
) {
  const wasFollowingCurrentStage = selectedStageCode === previousCurrentStageCode
  return isStudent && wasFollowingCurrentStage ? refreshedCurrentStageCode : selectedStageCode
}
