import { afterEach, describe, expect, it, vi } from "vitest"
import { isAbsolute, join } from "node:path"
import { resolveMapDataPath, resolveWorkspacePath, workspaceRoot } from "./runtime-paths.js"

afterEach(() => vi.unstubAllEnvs())

describe("runtime paths", () => {
  it("resolves default paths from the workspace root", () => {
    expect(resolveWorkspacePath(undefined, "apps/web/dist")).toBe(join(workspaceRoot, "apps/web/dist"))
  })

  it("resolves configured relative paths from the workspace root", () => {
    expect(resolveWorkspacePath("data/map", "unused")).toBe(join(workspaceRoot, "data/map"))
  })

  it("preserves configured absolute paths", () => {
    const absolutePath = isAbsolute("C:\\map-data") ? "C:\\map-data" : "/map-data"
    expect(resolveWorkspacePath(absolutePath, "unused")).toBe(absolutePath)
  })

  it("uses the bundled map directory when MAP_DATA_DIR is not configured", () => {
    vi.stubEnv("MAP_DATA_DIR", undefined)
    expect(resolveMapDataPath()).toBe(join(workspaceRoot, "apps/web/dist/map"))
  })

  it("resolves a configured map directory from the workspace root", () => {
    vi.stubEnv("MAP_DATA_DIR", "data/map")
    expect(resolveMapDataPath()).toBe(join(workspaceRoot, "data/map"))
  })
})
