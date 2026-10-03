import { MigrationInterface, QueryRunner } from "typeorm"

export class R6LogisticsRuntime1787270400000 implements MigrationInterface {
  name = "R6LogisticsRuntime1787270400000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "logistics_runtime_readiness" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL, "scheduleVersionId" uuid NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'DRAFT', "revision" integer NOT NULL DEFAULT 1,
        "decision" character varying(40), "decisionBasis" text NOT NULL DEFAULT '', "checks" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "updatedById" uuid NOT NULL, "confirmedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_logistics_runtime_readiness" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_logistics_runtime_readiness_project" UNIQUE ("projectId"),
        CONSTRAINT "CK_logistics_runtime_readiness_status" CHECK ("status" IN ('DRAFT','CONFIRMED')),
        CONSTRAINT "CK_logistics_runtime_readiness_decision" CHECK ("decision" IS NULL OR "decision" IN ('PROCEED','PROCEED_AFTER_ADJUSTMENT','DELAY','CANCEL')),
        CONSTRAINT "CK_logistics_runtime_readiness_revision" CHECK ("revision" > 0)
      )
    `)
    await queryRunner.query(`
      CREATE TABLE "logistics_runtime_snapshots" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL, "sessionId" uuid NOT NULL,
        "sequence" integer NOT NULL, "simulationTimeMs" bigint NOT NULL, "reason" character varying(40) NOT NULL,
        "projection" jsonb NOT NULL, "contentHash" character varying(64) NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_logistics_runtime_snapshots" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_logistics_runtime_snapshots_session_sequence" UNIQUE ("sessionId", "sequence"),
        CONSTRAINT "CK_logistics_runtime_snapshots_values" CHECK ("sequence" > 0 AND "simulationTimeMs" >= 0)
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_logistics_runtime_snapshots_project_time" ON "logistics_runtime_snapshots" ("projectId", "simulationTimeMs")`)
    await queryRunner.query(`
      CREATE TABLE "logistics_dynamic_schedule_versions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL, "parentVersionId" uuid,
        "versionNo" integer NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'DRAFT', "reason" text NOT NULL DEFAULT '',
        "effectiveSimulationTimeMs" bigint NOT NULL, "items" jsonb NOT NULL, "checkResult" jsonb NOT NULL,
        "createdById" uuid NOT NULL, "correlationId" uuid, "submittedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_logistics_dynamic_schedule_versions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_logistics_dynamic_schedule_project_version" UNIQUE ("projectId", "versionNo"),
        CONSTRAINT "CK_logistics_dynamic_schedule_status" CHECK ("status" IN ('DRAFT','SUBMITTED')),
        CONSTRAINT "CK_logistics_dynamic_schedule_values" CHECK ("versionNo" > 0 AND "effectiveSimulationTimeMs" >= 0)
      )
    `)
    await queryRunner.query(`ALTER TABLE "logistics_runtime_readiness" ADD CONSTRAINT "FK_logistics_runtime_readiness_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "logistics_runtime_readiness" ADD CONSTRAINT "FK_logistics_runtime_readiness_schedule" FOREIGN KEY ("scheduleVersionId") REFERENCES "logistics_schedule_versions"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "logistics_runtime_readiness" ADD CONSTRAINT "FK_logistics_runtime_readiness_user" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "logistics_runtime_snapshots" ADD CONSTRAINT "FK_logistics_runtime_snapshots_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "logistics_runtime_snapshots" ADD CONSTRAINT "FK_logistics_runtime_snapshots_session" FOREIGN KEY ("sessionId") REFERENCES "runtime_sessions"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" ADD CONSTRAINT "FK_logistics_dynamic_schedule_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" ADD CONSTRAINT "FK_logistics_dynamic_schedule_parent" FOREIGN KEY ("parentVersionId") REFERENCES "logistics_dynamic_schedule_versions"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "logistics_dynamic_schedule_versions" ADD CONSTRAINT "FK_logistics_dynamic_schedule_user" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "logistics_dynamic_schedule_versions" CASCADE`)
    await queryRunner.query(`DROP TABLE "logistics_runtime_snapshots" CASCADE`)
    await queryRunner.query(`DROP TABLE "logistics_runtime_readiness" CASCADE`)
  }
}
