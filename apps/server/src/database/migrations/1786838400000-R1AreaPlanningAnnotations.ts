import { MigrationInterface, QueryRunner } from "typeorm"

export class R1AreaPlanningAnnotations1786838400000 implements MigrationInterface {
  name = "R1AreaPlanningAnnotations1786838400000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "show_area_plan_drafts" ADD "annotations" jsonb NOT NULL DEFAULT '[]'::jsonb`)
    await queryRunner.query(`ALTER TABLE "show_area_plan_versions" ADD "annotations" jsonb NOT NULL DEFAULT '[]'::jsonb`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "show_area_plan_versions" DROP COLUMN "annotations"`)
    await queryRunner.query(`ALTER TABLE "show_area_plan_drafts" DROP COLUMN "annotations"`)
  }
}
