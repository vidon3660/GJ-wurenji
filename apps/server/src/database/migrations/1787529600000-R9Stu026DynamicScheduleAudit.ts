import { MigrationInterface, QueryRunner } from "typeorm"

export class R9Stu026DynamicScheduleAudit1787529600000 implements MigrationInterface {
  name = "R9Stu026DynamicScheduleAudit1787529600000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" ADD COLUMN "mode" character varying(20) NOT NULL DEFAULT 'SINGLE'`)
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" ADD COLUMN "eventId" uuid`)
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" ADD COLUMN "affectedOrderIds" jsonb NOT NULL DEFAULT '[]'::jsonb`)
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" ADD COLUMN "affectedAircraftIds" jsonb NOT NULL DEFAULT '[]'::jsonb`)
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" ADD COLUMN "affectedRouteIds" jsonb NOT NULL DEFAULT '[]'::jsonb`)
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" ADD COLUMN "contentHash" character varying(64) NOT NULL DEFAULT ''`)
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" ADD COLUMN "submittedById" uuid`)
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" ADD CONSTRAINT "CK_logistics_dynamic_schedule_mode" CHECK ("mode" IN ('SINGLE','BATCH','GLOBAL'))`)
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" ADD CONSTRAINT "FK_logistics_dynamic_schedule_event" FOREIGN KEY ("eventId") REFERENCES "runtime_events"("id") ON DELETE SET NULL`)
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" ADD CONSTRAINT "FK_logistics_dynamic_schedule_submitted_user" FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE RESTRICT`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" DROP CONSTRAINT "FK_logistics_dynamic_schedule_submitted_user"`)
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" DROP CONSTRAINT "FK_logistics_dynamic_schedule_event"`)
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" DROP CONSTRAINT "CK_logistics_dynamic_schedule_mode"`)
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" DROP COLUMN "submittedById"`)
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" DROP COLUMN "contentHash"`)
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" DROP COLUMN "affectedRouteIds"`)
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" DROP COLUMN "affectedAircraftIds"`)
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" DROP COLUMN "affectedOrderIds"`)
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" DROP COLUMN "eventId"`)
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" DROP COLUMN "mode"`)
  }
}
