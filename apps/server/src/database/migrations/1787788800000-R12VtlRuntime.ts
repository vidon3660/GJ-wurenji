import type { MigrationInterface, QueryRunner } from "typeorm"

export class R12VtlRuntime1787788800000 implements MigrationInterface {
  name = "R12VtlRuntime1787788800000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "vtl_runtime_snapshots" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "projectId" uuid NOT NULL,
        "sessionId" uuid NOT NULL,
        "sequence" integer NOT NULL,
        "simulationTimeMs" bigint NOT NULL,
        "reason" character varying(30) NOT NULL,
        "summary" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "aircraft" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "groups" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "taskObjects" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_vtl_runtime_snapshots" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_vtl_runtime_snapshots_session_sequence" UNIQUE ("sessionId", "sequence"),
        CONSTRAINT "CK_vtl_runtime_snapshots_values" CHECK ("sequence" > 0 AND "simulationTimeMs" >= 0),
        CONSTRAINT "FK_vtl_runtime_snapshots_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_vtl_runtime_snapshots_session" FOREIGN KEY ("sessionId") REFERENCES "runtime_sessions"("id") ON DELETE CASCADE
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_vtl_runtime_snapshots_project_time" ON "vtl_runtime_snapshots" ("projectId", "simulationTimeMs")`)
    await queryRunner.query(`
      CREATE TABLE "vtl_reorganization_records" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "projectId" uuid NOT NULL,
        "sessionId" uuid NOT NULL,
        "eventId" uuid,
        "action" character varying(40) NOT NULL,
        "sourceAircraftId" character varying(120),
        "targetAircraftId" character varying(120),
        "sourceGroupId" character varying(120),
        "targetGroupId" character varying(120),
        "taskObjectIds" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "previousTaskOrder" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "nextTaskOrder" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "checkPassed" boolean NOT NULL DEFAULT true,
        "message" text NOT NULL,
        "executedAtMs" bigint NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_vtl_reorganization_records" PRIMARY KEY ("id"),
        CONSTRAINT "CK_vtl_reorganization_records_time" CHECK ("executedAtMs" >= 0),
        CONSTRAINT "FK_vtl_reorganization_records_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_vtl_reorganization_records_session" FOREIGN KEY ("sessionId") REFERENCES "runtime_sessions"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_vtl_reorganization_records_event" FOREIGN KEY ("eventId") REFERENCES "runtime_events"("id") ON DELETE SET NULL
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_vtl_reorganization_records_project_time" ON "vtl_reorganization_records" ("projectId", "executedAtMs")`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "vtl_reorganization_records" CASCADE`)
    await queryRunner.query(`DROP TABLE "vtl_runtime_snapshots" CASCADE`)
  }
}
