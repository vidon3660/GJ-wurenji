import { MigrationInterface, QueryRunner } from "typeorm"

/** Adds the immutable version/concurrency fields without rewriting prior migrations. */
export class ScenarioOverlayRevisionAndSnapshotVersions1788912000000 implements MigrationInterface {
  name = "ScenarioOverlayRevisionAndSnapshotVersions1788912000000"

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "scenario_overlay_versions" ADD "revision" integer NOT NULL DEFAULT 1`)
    await queryRunner.query(`ALTER TABLE "scenario_overlay_versions" ADD CONSTRAINT "CHK_scenario_overlay_versions_version_no_positive" CHECK ("versionNo" > 0)`)
    await queryRunner.query(`ALTER TABLE "scenario_overlay_versions" ADD CONSTRAINT "CHK_scenario_overlay_versions_revision_positive" CHECK ("revision" > 0)`)
    await queryRunner.query(`ALTER TABLE "scenario_overlays" ADD CONSTRAINT "FK_scenario_overlays_region_package" FOREIGN KEY ("regionPackageId") REFERENCES "resource_packages"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "scenario_overlay_versions" ADD CONSTRAINT "FK_scenario_overlay_versions_region_package" FOREIGN KEY ("regionPackageId") REFERENCES "resource_packages"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_scenario_overlay_versions_scope_no" ON "scenario_overlay_versions" ("sceneType", "regionPackageId", "title", "versionNo")`)
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_scenario_overlay_versions_published_scope" ON "scenario_overlay_versions" ("sceneType", "regionPackageId", "title") WHERE "status" = 'PUBLISHED'`)
    await queryRunner.query(`ALTER TABLE "assignment_snapshots" ADD "mapResourceVersion" character varying(220) NOT NULL DEFAULT 'UNRESOLVED'`)
    await queryRunner.query(`ALTER TABLE "assignment_snapshots" ADD "sceneResourceVersion" character varying(220) NOT NULL DEFAULT 'UNRESOLVED'`)
    await queryRunner.query(`ALTER TABLE "assignment_snapshots" ADD "planVersion" character varying(220) NOT NULL DEFAULT 'UNRESOLVED'`)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assignment_snapshots" DROP COLUMN "planVersion"`)
    await queryRunner.query(`ALTER TABLE "assignment_snapshots" DROP COLUMN "sceneResourceVersion"`)
    await queryRunner.query(`ALTER TABLE "assignment_snapshots" DROP COLUMN "mapResourceVersion"`)
    await queryRunner.query(`DROP INDEX "UQ_scenario_overlay_versions_published_scope"`)
    await queryRunner.query(`DROP INDEX "UQ_scenario_overlay_versions_scope_no"`)
    await queryRunner.query(`ALTER TABLE "scenario_overlay_versions" DROP CONSTRAINT "FK_scenario_overlay_versions_region_package"`)
    await queryRunner.query(`ALTER TABLE "scenario_overlays" DROP CONSTRAINT "FK_scenario_overlays_region_package"`)
    await queryRunner.query(`ALTER TABLE "scenario_overlay_versions" DROP CONSTRAINT "CHK_scenario_overlay_versions_revision_positive"`)
    await queryRunner.query(`ALTER TABLE "scenario_overlay_versions" DROP CONSTRAINT "CHK_scenario_overlay_versions_version_no_positive"`)
    await queryRunner.query(`ALTER TABLE "scenario_overlay_versions" DROP COLUMN "revision"`)
  }
}
