import type { MigrationInterface, QueryRunner } from "typeorm"

export class R8RuntimeAttempts1787443200000 implements MigrationInterface {
  name = "R8RuntimeAttempts1787443200000"

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "runtime_sessions" ADD COLUMN "attemptNo" integer NOT NULL DEFAULT 1`)
    await queryRunner.query(`ALTER TABLE "runtime_sessions" ADD COLUMN "sourceSessionId" uuid`)
    await queryRunner.query(`ALTER TABLE "runtime_sessions" ADD COLUMN "restartNodeCode" varchar(120)`)
    await queryRunner.query(`ALTER TABLE "runtime_sessions" ADD COLUMN "restartSimulationTimeMs" bigint`)
    await queryRunner.query(`
      WITH numbered AS (
        SELECT "id", ROW_NUMBER() OVER (PARTITION BY "projectId" ORDER BY "createdAt", "id") AS attempt_no
        FROM "runtime_sessions"
      )
      UPDATE "runtime_sessions" session
      SET "attemptNo" = numbered.attempt_no
      FROM numbered
      WHERE session."id" = numbered."id"
    `)
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_runtime_sessions_project_attempt" ON "runtime_sessions" ("projectId", "attemptNo")`)
    await queryRunner.query(`ALTER TABLE "runtime_sessions" ADD CONSTRAINT "FK_runtime_sessions_source" FOREIGN KEY ("sourceSessionId") REFERENCES "runtime_sessions"("id") ON DELETE RESTRICT`)

    await queryRunner.query(`ALTER TABLE "runtime_alerts" ADD COLUMN "sessionId" uuid`)
    await queryRunner.query(`
      UPDATE "runtime_alerts" alert
      SET "sessionId" = COALESCE(
        (SELECT event."sessionId" FROM "runtime_events" event WHERE event."id" = alert."eventId"),
        (SELECT session."id" FROM "runtime_sessions" session WHERE session."projectId" = alert."projectId" ORDER BY session."createdAt" DESC LIMIT 1)
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_runtime_alerts_session_opened" ON "runtime_alerts" ("sessionId", "openedAt")`)
    await queryRunner.query(`ALTER TABLE "runtime_alerts" ADD CONSTRAINT "FK_runtime_alerts_session" FOREIGN KEY ("sessionId") REFERENCES "runtime_sessions"("id") ON DELETE CASCADE`)

    await queryRunner.query(`ALTER TABLE "show_runtime_group_snapshots" ADD COLUMN "checkpoint" jsonb NOT NULL DEFAULT '{}'::jsonb`)
    await queryRunner.query(`ALTER TABLE "logistics_runtime_snapshots" ADD COLUMN "checkpoint" jsonb NOT NULL DEFAULT '{}'::jsonb`)

    await queryRunner.query(`ALTER TABLE "show_operational_reports" ADD COLUMN "sessionId" uuid`)
    await queryRunner.query(`
      UPDATE "show_operational_reports" report
      SET "sessionId" = (
        SELECT session."id" FROM "runtime_sessions" session
        WHERE session."projectId" = report."projectId"
        ORDER BY session."createdAt" DESC LIMIT 1
      )
    `)
    await queryRunner.query(`ALTER TABLE "show_operational_reports" ALTER COLUMN "sessionId" SET NOT NULL`)
    await queryRunner.query(`ALTER TABLE "show_operational_reports" DROP CONSTRAINT "UQ_show_operational_reports_project_type"`)
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_show_operational_reports_session_type" ON "show_operational_reports" ("sessionId", "reportType")`)
    await queryRunner.query(`ALTER TABLE "show_operational_reports" ADD CONSTRAINT "FK_show_operational_reports_session" FOREIGN KEY ("sessionId") REFERENCES "runtime_sessions"("id") ON DELETE CASCADE`)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "show_operational_reports" DROP CONSTRAINT "FK_show_operational_reports_session"`)
    await queryRunner.query(`DROP INDEX "IDX_show_operational_reports_session_type"`)
    await queryRunner.query(`ALTER TABLE "show_operational_reports" ADD CONSTRAINT "UQ_show_operational_reports_project_type" UNIQUE ("projectId", "reportType")`)
    await queryRunner.query(`ALTER TABLE "show_operational_reports" DROP COLUMN "sessionId"`)
    await queryRunner.query(`ALTER TABLE "logistics_runtime_snapshots" DROP COLUMN "checkpoint"`)
    await queryRunner.query(`ALTER TABLE "show_runtime_group_snapshots" DROP COLUMN "checkpoint"`)
    await queryRunner.query(`ALTER TABLE "runtime_alerts" DROP CONSTRAINT "FK_runtime_alerts_session"`)
    await queryRunner.query(`DROP INDEX "IDX_runtime_alerts_session_opened"`)
    await queryRunner.query(`ALTER TABLE "runtime_alerts" DROP COLUMN "sessionId"`)
    await queryRunner.query(`ALTER TABLE "runtime_sessions" DROP CONSTRAINT "FK_runtime_sessions_source"`)
    await queryRunner.query(`DROP INDEX "IDX_runtime_sessions_project_attempt"`)
    await queryRunner.query(`ALTER TABLE "runtime_sessions" DROP COLUMN "restartSimulationTimeMs"`)
    await queryRunner.query(`ALTER TABLE "runtime_sessions" DROP COLUMN "restartNodeCode"`)
    await queryRunner.query(`ALTER TABLE "runtime_sessions" DROP COLUMN "sourceSessionId"`)
    await queryRunner.query(`ALTER TABLE "runtime_sessions" DROP COLUMN "attemptNo"`)
  }
}
