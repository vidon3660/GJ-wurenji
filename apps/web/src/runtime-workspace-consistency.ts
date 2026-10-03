export interface RuntimeWorkspaceVersion {
  session: {
    id: string
    attemptNo: number
    revision: number
  }
}

export function shouldApplyRuntimeWorkspace(
  current: RuntimeWorkspaceVersion | null,
  next: RuntimeWorkspaceVersion,
  options: { allowOlderAttempt?: boolean } = {}
): boolean {
  if (!current) return true
  if (current.session.id === next.session.id) return next.session.revision >= current.session.revision
  if (next.session.attemptNo > current.session.attemptNo) return true
  if (next.session.attemptNo < current.session.attemptNo) return options.allowOlderAttempt === true
  return options.allowOlderAttempt === true
}
