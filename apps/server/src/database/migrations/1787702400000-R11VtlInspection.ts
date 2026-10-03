import type { MigrationInterface, QueryRunner } from "typeorm"

export class R11VtlInspection1787702400000 implements MigrationInterface {
  name = "R11VtlInspection1787702400000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "vtl_project_plans" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "projectId" uuid NOT NULL,
        "revision" integer NOT NULL DEFAULT 1,
        "areaConfirmedAt" TIMESTAMP WITH TIME ZONE,
        "taskObjects" jsonb NOT NULL,
        "landingSites" jsonb NOT NULL,
        "aircraftParameters" jsonb NOT NULL,
        "allocation" jsonb NOT NULL,
        "routes" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "checkResult" jsonb,
        "executionPlan" jsonb,
        "updatedById" uuid NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_vtl_project_plans" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_vtl_project_plans_project" UNIQUE ("projectId"),
        CONSTRAINT "CK_vtl_project_plans_revision" CHECK ("revision" > 0),
        CONSTRAINT "FK_vtl_project_plans_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_vtl_project_plans_updated_by" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT
      )
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "vtl_project_plans" CASCADE`)
  }
}
