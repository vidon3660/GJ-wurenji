import { describe, expect, it } from "vitest"
import { isAbsolute, join } from "node:path"
import { resolveWorkspacePath, workspaceRoot } from "./runtime-paths.js"

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
})
