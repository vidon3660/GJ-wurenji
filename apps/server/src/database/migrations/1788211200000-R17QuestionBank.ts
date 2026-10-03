import type { MigrationInterface, QueryRunner } from "typeorm"

export class R17QuestionBank1788211200000 implements MigrationInterface {
  name = "R17QuestionBank1788211200000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "question_banks" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "title" character varying(160) NOT NULL,
        "sceneType" character varying(40),
        "summary" text NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'DRAFT',
        "currentVersion" integer NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "createdById" uuid NOT NULL,
        CONSTRAINT "PK_question_banks" PRIMARY KEY ("id"),
        CONSTRAINT "FK_question_banks_created_by" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `)
    await queryRunner.query(`
      CREATE TABLE "question_bank_versions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "version" integer NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'DRAFT',
        "questions" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "changeNote" text,
        "publishedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "bankId" uuid NOT NULL,
        "createdById" uuid NOT NULL,
        CONSTRAINT "PK_question_bank_versions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_question_bank_versions_bank_version" UNIQUE ("bankId", "version"),
        CONSTRAINT "FK_question_bank_versions_bank" FOREIGN KEY ("bankId") REFERENCES "question_banks"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_question_bank_versions_created_by" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `)
    await queryRunner.query(`
      CREATE TABLE "question_attempts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "status" character varying(20) NOT NULL DEFAULT 'IN_PROGRESS',
        "revision" integer NOT NULL DEFAULT 1,
        "autoScore" double precision NOT NULL DEFAULT 0,
        "teacherScore" double precision,
        "maxScore" double precision NOT NULL DEFAULT 0,
        "submittedAt" TIMESTAMP WITH TIME ZONE,
        "reviewedAt" TIMESTAMP WITH TIME ZONE,
        "reviewComment" text NOT NULL DEFAULT '',
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "projectId" uuid NOT NULL,
        "bankVersionId" uuid NOT NULL,
        "studentId" uuid NOT NULL,
        "reviewedById" uuid,
        CONSTRAINT "PK_question_attempts" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_question_attempts_project_version" UNIQUE ("projectId", "bankVersionId"),
        CONSTRAINT "FK_question_attempts_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_question_attempts_bank_version" FOREIGN KEY ("bankVersionId") REFERENCES "question_bank_versions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_question_attempts_student" FOREIGN KEY ("studentId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_question_attempts_reviewed_by" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `)
    await queryRunner.query(`
      CREATE TABLE "question_responses" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "questionCode" character varying(80) NOT NULL,
        "answer" jsonb,
        "autoScore" double precision,
        "maxScore" double precision NOT NULL,
        "judgment" character varying(20) NOT NULL DEFAULT 'UNANSWERED',
        "evidence" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "teacherScore" double precision,
        "teacherComment" text NOT NULL DEFAULT '',
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "attemptId" uuid NOT NULL,
        CONSTRAINT "PK_question_responses" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_question_responses_attempt_code" UNIQUE ("attemptId", "questionCode"),
        CONSTRAINT "FK_question_responses_attempt" FOREIGN KEY ("attemptId") REFERENCES "question_attempts"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "question_responses"`)
    await queryRunner.query(`DROP TABLE "question_attempts"`)
    await queryRunner.query(`DROP TABLE "question_bank_versions"`)
    await queryRunner.query(`DROP TABLE "question_banks"`)
  }
}
