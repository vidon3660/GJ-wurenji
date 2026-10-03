import { MigrationInterface, QueryRunner } from "typeorm"

export class ScenarioOverlayVersions1788825600000 implements MigrationInterface {
  name = "ScenarioOverlayVersions1788825600000"

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "scenario_overlays" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "sceneType" character varying(40) NOT NULL,
        "regionPackageId" uuid NOT NULL,
        "title" character varying(160) NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "createdById" uuid NOT NULL,
        CONSTRAINT "PK_scenario_overlays" PRIMARY KEY ("id")
      )`)
    await queryRunner.query(`CREATE INDEX "IDX_scenario_overlays_region_creator" ON "scenario_overlays" ("regionPackageId", "createdById")`)
    await queryRunner.query(`
      CREATE TABLE "scenario_overlay_versions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "overlayId" uuid NOT NULL,
        "versionNo" integer NOT NULL,
        "sceneType" character varying(40) NOT NULL,
        "regionPackageId" uuid NOT NULL,
        "title" character varying(160) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'DRAFT',
        "objects" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "checksum" character varying(64) NOT NULL,
        "publishedAt" TIMESTAMP WITH TIME ZONE,
        "archivedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "createdById" uuid NOT NULL,
        CONSTRAINT "PK_scenario_overlay_versions" PRIMARY KEY ("id")
      )`)
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_scenario_overlay_versions_overlay_no" ON "scenario_overlay_versions" ("overlayId", "versionNo")`)
    await queryRunner.query(`CREATE INDEX "IDX_scenario_overlay_versions_region_status" ON "scenario_overlay_versions" ("regionPackageId", "status")`)
    await queryRunner.query(`ALTER TABLE "scenario_overlays" ADD CONSTRAINT "FK_scenario_overlays_creator" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "scenario_overlay_versions" ADD CONSTRAINT "FK_scenario_overlay_versions_overlay" FOREIGN KEY ("overlayId") REFERENCES "scenario_overlays"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "scenario_overlay_versions" ADD CONSTRAINT "FK_scenario_overlay_versions_creator" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT`)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "scenario_overlay_versions" DROP CONSTRAINT "FK_scenario_overlay_versions_creator"`)
    await queryRunner.query(`ALTER TABLE "scenario_overlay_versions" DROP CONSTRAINT "FK_scenario_overlay_versions_overlay"`)
    await queryRunner.query(`ALTER TABLE "scenario_overlays" DROP CONSTRAINT "FK_scenario_overlays_creator"`)
    await queryRunner.query(`DROP INDEX "IDX_scenario_overlay_versions_region_status"`)
    await queryRunner.query(`DROP INDEX "IDX_scenario_overlay_versions_overlay_no"`)
    await queryRunner.query(`DROP TABLE "scenario_overlay_versions"`)
    await queryRunner.query(`DROP INDEX "IDX_scenario_overlays_region_creator"`)
    await queryRunner.query(`DROP TABLE "scenario_overlays"`)
  }
}
