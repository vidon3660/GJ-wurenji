import { MigrationInterface, QueryRunner } from "typeorm"

export class R2ShowRuntime1786924800000 implements MigrationInterface {
  name = "R2ShowRuntime1786924800000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "show_runtime_group_snapshots" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL,
        "sessionId" uuid NOT NULL, "sequence" integer NOT NULL, "simulationTimeMs" bigint NOT NULL,
        "phase" character varying(40) NOT NULL, "reason" character varying(40) NOT NULL,
        "totals" jsonb NOT NULL, "groups" jsonb NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_show_runtime_group_snapshots" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_show_runtime_group_snapshots_sequence" UNIQUE ("sessionId", "sequence"),
        CONSTRAINT "CK_show_runtime_group_snapshots_phase" CHECK ("phase" IN ('READY','TAKEOFF_PREPARATION','BATCH_TAKEOFF','TRANSIT_TO_SHOW','PERFORMANCE','RETURN_TO_LAUNCH','BATCH_LANDING','COMPLETED','ABORTED')),
        CONSTRAINT "CK_show_runtime_group_snapshots_reason" CHECK ("reason" IN ('START','PHASE','EVENT','ACTION','COMPLETE','ABORT')),
        CONSTRAINT "CK_show_runtime_group_snapshots_values" CHECK ("sequence" > 0 AND "simulationTimeMs" >= 0)
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_show_runtime_group_snapshots_project_time" ON "show_runtime_group_snapshots" ("projectId", "simulationTimeMs")`)
    await queryRunner.query(`
      CREATE TABLE "show_operational_reports" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL,
        "reportType" character varying(30) NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'DRAFT',
        "revision" integer NOT NULL DEFAULT 1, "snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "submittedById" uuid, "submittedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_show_operational_reports" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_show_operational_reports_project_type" UNIQUE ("projectId", "reportType"),
        CONSTRAINT "CK_show_operational_reports_type" CHECK ("reportType" IN ('TAKEOFF','FLIGHT_END')),
        CONSTRAINT "CK_show_operational_reports_status" CHECK ("status" IN ('DRAFT','SUBMITTED')),
        CONSTRAINT "CK_show_operational_reports_revision" CHECK ("revision" > 0)
      )
    `)
    await queryRunner.query(`ALTER TABLE "show_runtime_group_snapshots" ADD CONSTRAINT "FK_show_runtime_group_snapshots_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "show_runtime_group_snapshots" ADD CONSTRAINT "FK_show_runtime_group_snapshots_session" FOREIGN KEY ("sessionId") REFERENCES "runtime_sessions"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "show_operational_reports" ADD CONSTRAINT "FK_show_operational_reports_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "show_operational_reports" ADD CONSTRAINT "FK_show_operational_reports_submitter" FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE RESTRICT`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "show_operational_reports" CASCADE`)
    await queryRunner.query(`DROP TABLE "show_runtime_group_snapshots" CASCADE`)
  }
}
