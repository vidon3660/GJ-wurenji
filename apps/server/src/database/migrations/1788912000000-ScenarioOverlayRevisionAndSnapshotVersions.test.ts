import { describe, expect, it } from "vitest"
import { ScenarioOverlayRevisionAndSnapshotVersions1788912000000 } from "./1788912000000-ScenarioOverlayRevisionAndSnapshotVersions.js"

describe("scenario overlay revision migration", () => {
  it("adds constraints, immutable resource references, and snapshot version columns in order", async () => {
    const statements: string[] = []
    const runner = { query: async (sql: string) => { statements.push(sql) } }
    await new ScenarioOverlayRevisionAndSnapshotVersions1788912000000().up(runner as never)
    expect(statements).toHaveLength(10)
    expect(statements[0]).toContain('ADD "revision" integer NOT NULL DEFAULT 1')
    expect(statements[3]).toContain('ON DELETE RESTRICT')
    expect(statements[4]).toContain('ON DELETE RESTRICT')
    expect(statements[5]).toContain('UQ_scenario_overlay_versions_scope_no')
    expect(statements[6]).toContain("WHERE \"status\" = 'PUBLISHED'")
    expect(statements.slice(7)).toEqual([
      'ALTER TABLE "assignment_snapshots" ADD "mapResourceVersion" character varying(220) NOT NULL DEFAULT \'UNRESOLVED\'',
      'ALTER TABLE "assignment_snapshots" ADD "sceneResourceVersion" character varying(220) NOT NULL DEFAULT \'UNRESOLVED\'',
      'ALTER TABLE "assignment_snapshots" ADD "planVersion" character varying(220) NOT NULL DEFAULT \'UNRESOLVED\''
    ])
  })

  it("reverts every operation in reverse dependency order", async () => {
    const statements: string[] = []
    const runner = { query: async (sql: string) => { statements.push(sql) } }
    await new ScenarioOverlayRevisionAndSnapshotVersions1788912000000().down(runner as never)
    expect(statements[0]).toContain('DROP COLUMN "planVersion"')
    expect(statements.at(-1)).toContain('DROP COLUMN "revision"')
    expect(statements).toContain('DROP INDEX "UQ_scenario_overlay_versions_published_scope"')
    expect(statements).toContain('ALTER TABLE "scenario_overlays" DROP CONSTRAINT "FK_scenario_overlays_region_package"')
  })
})
