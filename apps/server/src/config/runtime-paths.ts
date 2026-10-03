import { isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url))

export function resolveWorkspacePath(value: string | undefined, fallback: string): string {
  const configuredPath = value?.trim() || fallback
  return isAbsolute(configuredPath) ? configuredPath : resolve(workspaceRoot, configuredPath)
}
