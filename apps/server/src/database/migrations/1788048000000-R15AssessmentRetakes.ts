import type { MigrationInterface, QueryRunner } from "typeorm"

export class R15AssessmentRetakes1788048000000 implements MigrationInterface {
  name = "R15AssessmentRetakes1788048000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "student_projects"
        ADD COLUMN "attemptNumber" integer NOT NULL DEFAULT 1,
        ADD COLUMN "retakeOfProjectId" uuid,
        ADD COLUMN "retakeReason" text,
        ADD COLUMN "retakeCreatedById" uuid,
        ADD COLUMN "retakeCreatedAt" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN "assessmentAvailableAtOverride" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN "assessmentDueAtOverride" TIMESTAMP WITH TIME ZONE
    `)
    await queryRunner.query(`DROP INDEX "IDX_15ef47fecd8f7d7d59f22e74ac"`)
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_student_projects_snapshot_student_attempt" ON "student_projects" ("snapshotId", "studentId", "attemptNumber")`)
    await queryRunner.query(`CREATE INDEX "IDX_student_projects_retake_of" ON "student_projects" ("retakeOfProjectId")`)
    await queryRunner.query(`
      ALTER TABLE "student_projects"
        ADD CONSTRAINT "FK_student_projects_retake_original"
          FOREIGN KEY ("retakeOfProjectId") REFERENCES "student_projects"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        ADD CONSTRAINT "FK_student_projects_retake_created_by"
          FOREIGN KEY ("retakeCreatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "student_projects" DROP CONSTRAINT "FK_student_projects_retake_created_by"`)
    await queryRunner.query(`ALTER TABLE "student_projects" DROP CONSTRAINT "FK_student_projects_retake_original"`)
    await queryRunner.query(`DROP INDEX "IDX_student_projects_retake_of"`)
    await queryRunner.query(`DROP INDEX "IDX_student_projects_snapshot_student_attempt"`)
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_15ef47fecd8f7d7d59f22e74ac" ON "student_projects" ("snapshotId", "studentId")`)
    await queryRunner.query(`
      ALTER TABLE "student_projects"
        DROP COLUMN "assessmentDueAtOverride",
        DROP COLUMN "assessmentAvailableAtOverride",
        DROP COLUMN "retakeCreatedAt",
        DROP COLUMN "retakeCreatedById",
        DROP COLUMN "retakeReason",
        DROP COLUMN "retakeOfProjectId",
        DROP COLUMN "attemptNumber"
    `)
  }
}
