import { MigrationInterface, QueryRunner } from "typeorm"

/** Keep dynamic schedule rows written by older runtimes readable while restoring the current draft/submitted contract. */
export class RepairDynamicScheduleStatusConstraint1788739200000 implements MigrationInterface {
  name = "RepairDynamicScheduleStatusConstraint1788739200000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" DROP CONSTRAINT IF EXISTS "CK_logistics_dynamic_schedule_status"`)
    await queryRunner.query(`
      ALTER TABLE "logistics_dynamic_schedule_versions"
      ADD CONSTRAINT "CK_logistics_dynamic_schedule_version_status"
      CHECK ("status" IN ('DRAFT','SUBMITTED','DRAFT_PREVIEW','COMMITTED','WAITING_SWITCH','PARTIALLY_APPLIED','APPLIED','EXPIRED','REJECTED','CANCELLED','SUPERSEDED','FAILED'))
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" DROP CONSTRAINT IF EXISTS "CK_logistics_dynamic_schedule_version_status"`)
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" ADD CONSTRAINT "CK_logistics_dynamic_schedule_status" CHECK ("status" IN ('DRAFT','SUBMITTED'))`)
  }
}
