import type { MigrationInterface, QueryRunner } from "typeorm"

export class R18RepairInternalAssignmentClassification1788307200000 implements MigrationInterface {
  name = "R18RepairInternalAssignmentClassification1788307200000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    const internalTitlePattern = "(^|[^A-Z0-9])(P[0-9]+|R[0-9]+|STU-[0-9]+|TEA-[0-9]+|APP-[0-9]+|ROU-[0-9]+|ORD-[0-9]+|RPT-[0-9]+|SCN-[0-9]+)([^A-Z0-9]|$)"
    await queryRunner.query(
      `UPDATE "assignment_drafts"
       SET "isAcceptanceData" = true
       WHERE "isDemo" = false
         AND "isAcceptanceData" = false
         AND "title" ~* $1`,
      [internalTitlePattern]
    )
    await queryRunner.query(`
      UPDATE "assignment_snapshots" AS snapshot
      SET "isDemo" = draft."isDemo", "isAcceptanceData" = draft."isAcceptanceData"
      FROM "assignment_drafts" AS draft
      WHERE snapshot."draftId" = draft."id"
    `)
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    return
  }
}
