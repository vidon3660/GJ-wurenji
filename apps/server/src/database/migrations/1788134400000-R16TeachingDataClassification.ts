import type { MigrationInterface, QueryRunner } from "typeorm"

export class R16TeachingDataClassification1788134400000 implements MigrationInterface {
  name = "R16TeachingDataClassification1788134400000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assignment_drafts" ADD "isDemo" boolean NOT NULL DEFAULT false`)
    await queryRunner.query(`ALTER TABLE "assignment_drafts" ADD "isAcceptanceData" boolean NOT NULL DEFAULT false`)
    await queryRunner.query(`ALTER TABLE "assignment_snapshots" ADD "isDemo" boolean NOT NULL DEFAULT false`)
    await queryRunner.query(`ALTER TABLE "assignment_snapshots" ADD "isAcceptanceData" boolean NOT NULL DEFAULT false`)

    const acceptancePattern = "(P[0-9]+|R[0-9]+|STU-[0-9]+|TEA-[0-9]+|APP-[0-9]+|ROU-[0-9]+|ORD-[0-9]+|RPT-[0-9]+|SCN-[0-9]+|BROWSER|ACCEPTANCE|INTEGRATION|SMOKE|TEST|测试|验收)"
    const demoPattern = "(DEMO|演示)"
    await queryRunner.query(`UPDATE "assignment_drafts" SET "isAcceptanceData" = true WHERE "title" ~* $1`, [acceptancePattern])
    await queryRunner.query(`UPDATE "assignment_drafts" SET "isDemo" = true WHERE "title" ~* $1 AND "isAcceptanceData" = false`, [demoPattern])
    await queryRunner.query(`
      UPDATE "assignment_snapshots" AS snapshot
      SET "isDemo" = draft."isDemo", "isAcceptanceData" = draft."isAcceptanceData"
      FROM "assignment_drafts" AS draft
      WHERE snapshot."draftId" = draft."id"
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assignment_snapshots" DROP COLUMN "isAcceptanceData", DROP COLUMN "isDemo"`)
    await queryRunner.query(`ALTER TABLE "assignment_drafts" DROP COLUMN "isAcceptanceData", DROP COLUMN "isDemo"`)
  }
}
