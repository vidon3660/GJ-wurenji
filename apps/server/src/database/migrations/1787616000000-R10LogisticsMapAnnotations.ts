import { MigrationInterface, QueryRunner } from "typeorm"

export class R10LogisticsMapAnnotations1787616000000 implements MigrationInterface {
  name = "R10LogisticsMapAnnotations1787616000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "logistics_route_plan_drafts" ADD "annotations" jsonb NOT NULL DEFAULT '[]'::jsonb`)
    await queryRunner.query(`ALTER TABLE "logistics_route_plan_versions" ADD "annotations" jsonb NOT NULL DEFAULT '[]'::jsonb`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "logistics_route_plan_versions" DROP COLUMN "annotations"`)
    await queryRunner.query(`ALTER TABLE "logistics_route_plan_drafts" DROP COLUMN "annotations"`)
  }
}
