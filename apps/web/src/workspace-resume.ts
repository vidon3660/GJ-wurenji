export interface WorkspaceResumeTarget {
  version: 1
  kind: "V3"
  id: string
}

export function workspaceResumeKey(userId: string): string {
  return `wurenji:v3-workspace:${userId}`
}

export function parseWorkspaceResumeTarget(value: string | null): WorkspaceResumeTarget | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<WorkspaceResumeTarget>
    if (parsed.version !== 1 || parsed.kind !== "V3" || typeof parsed.id !== "string" || !parsed.id.trim()) return null
    return { version: 1, kind: "V3", id: parsed.id.trim() }
  } catch {
    return null
  }
}

export function loadWorkspaceResumeTarget(storage: Pick<Storage, "getItem">, userId: string): WorkspaceResumeTarget | null {
  return parseWorkspaceResumeTarget(storage.getItem(workspaceResumeKey(userId)))
}

export function saveWorkspaceResumeTarget(storage: Pick<Storage, "setItem">, userId: string, projectId: string): void {
  storage.setItem(workspaceResumeKey(userId), JSON.stringify({ version: 1, kind: "V3", id: projectId } satisfies WorkspaceResumeTarget))
}

export function clearWorkspaceResumeTarget(storage: Pick<Storage, "removeItem">, userId: string): void {
  storage.removeItem(workspaceResumeKey(userId))
}
