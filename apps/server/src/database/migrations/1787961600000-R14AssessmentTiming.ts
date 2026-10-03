import type { MigrationInterface, QueryRunner } from "typeorm"

export class R14AssessmentTiming1787961600000 implements MigrationInterface {
  name = "R14AssessmentTiming1787961600000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "student_projects"
        ADD COLUMN "assessmentStartedAt" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN "assessmentDeadlineAt" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN "assessmentSubmittedAt" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN "assessmentEndedAt" TIMESTAMP WITH TIME ZONE
    `)
    await queryRunner.query(`CREATE INDEX "IDX_student_projects_assessment_deadline" ON "student_projects" ("assessmentDeadlineAt")`)
    await queryRunner.query(`
      UPDATE "assignment_drafts"
      SET "config" = jsonb_set("config", '{assessmentDurationMinutes}', '120'::jsonb, true)
      WHERE NOT ("config" ? 'assessmentDurationMinutes')
    `)
    await queryRunner.query(`
      UPDATE "assignment_snapshots"
      SET "config" = jsonb_set("config", '{assessmentDurationMinutes}', '120'::jsonb, true)
      WHERE NOT ("config" ? 'assessmentDurationMinutes')
    `)
    await queryRunner.query(`
      UPDATE "assignment_snapshot_resource_revisions"
      SET "config" = jsonb_set("config", '{assessmentDurationMinutes}', '120'::jsonb, true)
      WHERE NOT ("config" ? 'assessmentDurationMinutes')
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "assignment_snapshot_resource_revisions"
      SET "config" = "config" - 'assessmentDurationMinutes'
    `)
    await queryRunner.query(`
      UPDATE "assignment_snapshots"
      SET "config" = "config" - 'assessmentDurationMinutes'
    `)
    await queryRunner.query(`
      UPDATE "assignment_drafts"
      SET "config" = "config" - 'assessmentDurationMinutes'
    `)
    await queryRunner.query(`DROP INDEX "IDX_student_projects_assessment_deadline"`)
    await queryRunner.query(`
      ALTER TABLE "student_projects"
        DROP COLUMN "assessmentEndedAt",
        DROP COLUMN "assessmentSubmittedAt",
        DROP COLUMN "assessmentDeadlineAt",
        DROP COLUMN "assessmentStartedAt"
    `)
  }
}
