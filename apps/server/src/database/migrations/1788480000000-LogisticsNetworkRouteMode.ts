import { MigrationInterface, QueryRunner } from "typeorm"

export class LogisticsNetworkRouteMode1788480000000 implements MigrationInterface {
  name = "LogisticsNetworkRouteMode1788480000000"

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "logistics_routes" ADD COLUMN IF NOT EXISTS "mode" character varying(24) NOT NULL DEFAULT 'FIXED_ROUND_TRIP'`)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "logistics_routes" DROP COLUMN IF EXISTS "mode"`)
  }
}
