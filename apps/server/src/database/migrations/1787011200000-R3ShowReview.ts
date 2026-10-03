import { MigrationInterface, QueryRunner } from "typeorm"

export class R3ShowReview1787011200000 implements MigrationInterface {
  name = "R3ShowReview1787011200000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_evaluations" ADD "studentSummary" text NOT NULL DEFAULT ''`)
    await queryRunner.query(`ALTER TABLE "project_evaluations" ADD "studentSubmittedAt" TIMESTAMP WITH TIME ZONE`)
    await queryRunner.query(`
      CREATE TABLE "show_review_annotations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL,
        "evaluationId" uuid NOT NULL, "timelineItemId" character varying(160) NOT NULL,
        "simulationTimeMs" bigint, "comment" text NOT NULL, "createdById" uuid NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_show_review_annotations" PRIMARY KEY ("id")
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_show_review_annotations_project_time" ON "show_review_annotations" ("projectId", "simulationTimeMs")`)
    await queryRunner.query(`
      CREATE TABLE "show_project_reports" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL,
        "evaluationId" uuid NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'DRAFT',
        "revision" integer NOT NULL DEFAULT 1, "format" character varying(10), "assetId" uuid,
        "snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb, "contentHash" character varying(64),
        "generatedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_show_project_reports" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_show_project_reports_project" UNIQUE ("projectId"),
        CONSTRAINT "UQ_show_project_reports_evaluation" UNIQUE ("evaluationId"),
        CONSTRAINT "CK_show_project_reports_status" CHECK ("status" IN ('DRAFT','FINAL')),
        CONSTRAINT "CK_show_project_reports_format" CHECK ("format" IS NULL OR "format" IN ('DOCX','PDF')),
        CONSTRAINT "CK_show_project_reports_revision" CHECK ("revision" > 0)
      )
    `)
    await queryRunner.query(`ALTER TABLE "show_review_annotations" ADD CONSTRAINT "FK_show_review_annotations_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "show_review_annotations" ADD CONSTRAINT "FK_show_review_annotations_evaluation" FOREIGN KEY ("evaluationId") REFERENCES "project_evaluations"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "show_review_annotations" ADD CONSTRAINT "FK_show_review_annotations_creator" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "show_project_reports" ADD CONSTRAINT "FK_show_project_reports_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "show_project_reports" ADD CONSTRAINT "FK_show_project_reports_evaluation" FOREIGN KEY ("evaluationId") REFERENCES "project_evaluations"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "show_project_reports" ADD CONSTRAINT "FK_show_project_reports_asset" FOREIGN KEY ("assetId") REFERENCES "file_assets"("id") ON DELETE RESTRICT`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "show_project_reports" CASCADE`)
    await queryRunner.query(`DROP TABLE "show_review_annotations" CASCADE`)
    await queryRunner.query(`ALTER TABLE "project_evaluations" DROP COLUMN "studentSubmittedAt"`)
    await queryRunner.query(`ALTER TABLE "project_evaluations" DROP COLUMN "studentSummary"`)
  }
}
