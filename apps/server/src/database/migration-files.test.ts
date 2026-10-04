import { describe, expect, it } from "vitest"
import { dirname, join, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveMigrationFiles } from "./migration-files.js"

describe("resolveMigrationFiles", () => {
  it("loads source migrations while excluding adjacent unit tests", () => {
    const directory = dirname(fileURLToPath(import.meta.url))
    const files = resolveMigrationFiles(directory)

    expect(files.length).toBeGreaterThan(0)
    expect(files.every((file) => /\.(?:js|ts)$/.test(file))).toBe(true)
    expect(files.some((file) => file.endsWith("1785802052382-LegacyBaseline.ts"))).toBe(true)
    expect(files.some((file) => file.endsWith("ScenarioOverlayRevisionAndSnapshotVersions.test.ts"))).toBe(false)
  })

  it("keeps paths rooted at the database migration directory", () => {
    const directory = dirname(fileURLToPath(import.meta.url))
    const prefix = join(directory, "migrations")
    expect(resolveMigrationFiles(directory).every((file) => file.startsWith(`${prefix}${sep}`))).toBe(true)
  })
})
