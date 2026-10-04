import { isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url))

export function resolveWorkspacePath(value: string | undefined, fallback: string): string {
  const configuredPath = value?.trim() || fallback
  return isAbsolute(configuredPath) ? configuredPath : resolve(workspaceRoot, configuredPath)
}

/**
 * Resolve the map directory used by the server and the bundled web build.
 *
 * Keeping this default in one place is important: the seed service, readiness
 * checks and terrain sampling all need to inspect the same map tree when a
 * deployment does not provide MAP_DATA_DIR explicitly.
 */
export function resolveMapDataPath(value: string | undefined = process.env.MAP_DATA_DIR): string {
  return resolveWorkspacePath(value, "apps/web/dist/map")
}
