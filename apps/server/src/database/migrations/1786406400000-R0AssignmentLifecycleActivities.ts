import { MigrationInterface, QueryRunner } from "typeorm"

export class R0AssignmentLifecycleActivities1786406400000 implements MigrationInterface {
  name = "R0AssignmentLifecycleActivities1786406400000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assignment_drafts" ADD "endedAt" TIMESTAMP WITH TIME ZONE`)
    await queryRunner.query(`ALTER TABLE "assignment_drafts" ADD "archivedAt" TIMESTAMP WITH TIME ZONE`)
    await queryRunner.query(`ALTER TABLE "assignment_drafts" ADD "lifecycleReason" text`)
    await queryRunner.query(`ALTER TABLE "assignment_drafts" ADD CONSTRAINT "CK_assignment_drafts_status" CHECK ("status" IN ('DRAFT', 'PUBLISHED', 'IN_PROGRESS', 'ENDED', 'ARCHIVED'))`)
    await queryRunner.query(`
      CREATE TABLE "project_activity_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "assignmentId" uuid,
        "projectId" uuid,
        "stageCode" character varying(60),
        "actorId" uuid NOT NULL,
        "actorName" character varying(120) NOT NULL,
        "actorRole" character varying(20) NOT NULL,
        "eventType" character varying(60) NOT NULL,
        "objectType" character varying(40) NOT NULL,
        "objectId" uuid,
        "realTime" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "simulationTimeMs" bigint,
        "beforeRevision" integer,
        "afterRevision" integer,
        "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "result" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "correlationId" uuid,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_activity_events" PRIMARY KEY ("id")
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_project_activity_events_assignment_time" ON "project_activity_events" ("assignmentId", "realTime")`)
    await queryRunner.query(`CREATE INDEX "IDX_project_activity_events_project_time" ON "project_activity_events" ("projectId", "realTime")`)
    await queryRunner.query(`CREATE INDEX "IDX_project_activity_events_correlation" ON "project_activity_events" ("correlationId")`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_project_activity_events_correlation"`)
    await queryRunner.query(`DROP INDEX "IDX_project_activity_events_project_time"`)
    await queryRunner.query(`DROP INDEX "IDX_project_activity_events_assignment_time"`)
    await queryRunner.query(`DROP TABLE "project_activity_events"`)
    await queryRunner.query(`ALTER TABLE "assignment_drafts" DROP CONSTRAINT "CK_assignment_drafts_status"`)
    await queryRunner.query(`ALTER TABLE "assignment_drafts" DROP COLUMN "lifecycleReason"`)
    await queryRunner.query(`ALTER TABLE "assignment_drafts" DROP COLUMN "archivedAt"`)
    await queryRunner.query(`ALTER TABLE "assignment_drafts" DROP COLUMN "endedAt"`)
  }
}
