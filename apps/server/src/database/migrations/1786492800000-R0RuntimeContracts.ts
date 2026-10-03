import { MigrationInterface, QueryRunner } from "typeorm"

export class R0RuntimeContracts1786492800000 implements MigrationInterface {
  name = "R0RuntimeContracts1786492800000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "runtime_sessions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'READY', "scenarioSeed" character varying(120) NOT NULL,
        "simulationTimeMs" bigint NOT NULL DEFAULT 0, "revision" integer NOT NULL DEFAULT 1,
        "checkpoint" jsonb NOT NULL DEFAULT '{}'::jsonb, "startedAt" TIMESTAMP WITH TIME ZONE,
        "endedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_runtime_sessions" PRIMARY KEY ("id"),
        CONSTRAINT "CK_runtime_sessions_status" CHECK ("status" IN ('READY','RUNNING','PAUSED','COMPLETED','ABORTED','FAILED')),
        CONSTRAINT "CK_runtime_sessions_revision" CHECK ("revision" > 0 AND "simulationTimeMs" >= 0)
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_runtime_sessions_project_time" ON "runtime_sessions" ("projectId", "createdAt")`)
    await queryRunner.query(`
      CREATE TABLE "runtime_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL, "sessionId" uuid NOT NULL,
        "stageCode" character varying(60) NOT NULL, "code" character varying(80) NOT NULL,
        "category" character varying(60) NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'SCHEDULED',
        "severity" character varying(20) NOT NULL, "scheduledSimulationTimeMs" bigint,
        "triggeredAt" TIMESTAMP WITH TIME ZONE, "resolvedAt" TIMESTAMP WITH TIME ZONE,
        "payload" jsonb NOT NULL DEFAULT '{}'::jsonb, "correlationId" uuid NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_runtime_events" PRIMARY KEY ("id"),
        CONSTRAINT "CK_runtime_events_status" CHECK ("status" IN ('SCHEDULED','ACTIVE','RESOLVED','CANCELLED')),
        CONSTRAINT "CK_runtime_events_severity" CHECK ("severity" IN ('INFO','WARNING','ERROR','CRITICAL')),
        CONSTRAINT "CK_runtime_events_time" CHECK ("scheduledSimulationTimeMs" IS NULL OR "scheduledSimulationTimeMs" >= 0)
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_runtime_events_project_status" ON "runtime_events" ("projectId", "status")`)
    await queryRunner.query(`CREATE INDEX "IDX_runtime_events_session_time" ON "runtime_events" ("sessionId", "scheduledSimulationTimeMs")`)
    await queryRunner.query(`CREATE INDEX "IDX_runtime_events_correlation" ON "runtime_events" ("correlationId")`)
    await queryRunner.query(`
      CREATE TABLE "runtime_alerts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL, "eventId" uuid,
        "stageCode" character varying(60) NOT NULL, "code" character varying(80) NOT NULL,
        "title" character varying(160) NOT NULL, "detail" text NOT NULL, "severity" character varying(20) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'OPEN', "simulationTimeMs" bigint,
        "openedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "acknowledgedAt" TIMESTAMP WITH TIME ZONE,
        "resolvedAt" TIMESTAMP WITH TIME ZONE, "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "correlationId" uuid NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_runtime_alerts" PRIMARY KEY ("id"),
        CONSTRAINT "CK_runtime_alerts_status" CHECK ("status" IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
        CONSTRAINT "CK_runtime_alerts_severity" CHECK ("severity" IN ('INFO','WARNING','ERROR','CRITICAL')),
        CONSTRAINT "CK_runtime_alerts_time" CHECK ("simulationTimeMs" IS NULL OR "simulationTimeMs" >= 0)
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_runtime_alerts_project_status" ON "runtime_alerts" ("projectId", "status")`)
    await queryRunner.query(`CREATE INDEX "IDX_runtime_alerts_severity_time" ON "runtime_alerts" ("severity", "openedAt")`)
    await queryRunner.query(`CREATE INDEX "IDX_runtime_alerts_correlation" ON "runtime_alerts" ("correlationId")`)
    await queryRunner.query(`
      CREATE TABLE "student_runtime_actions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL, "sessionId" uuid NOT NULL,
        "eventId" uuid, "alertId" uuid, "actorId" uuid NOT NULL, "actionCode" character varying(80) NOT NULL,
        "targetType" character varying(60) NOT NULL, "targetId" character varying(120),
        "status" character varying(20) NOT NULL DEFAULT 'REQUESTED', "simulationTimeMs" bigint NOT NULL,
        "payload" jsonb NOT NULL DEFAULT '{}'::jsonb, "result" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "correlationId" uuid NOT NULL, "requestedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "appliedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_student_runtime_actions" PRIMARY KEY ("id"),
        CONSTRAINT "CK_student_runtime_actions_status" CHECK ("status" IN ('REQUESTED','ACCEPTED','REJECTED','APPLIED','FAILED')),
        CONSTRAINT "CK_student_runtime_actions_time" CHECK ("simulationTimeMs" >= 0)
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_student_runtime_actions_project_time" ON "student_runtime_actions" ("projectId", "requestedAt")`)
    await queryRunner.query(`CREATE INDEX "IDX_student_runtime_actions_session_time" ON "student_runtime_actions" ("sessionId", "simulationTimeMs")`)
    await queryRunner.query(`CREATE INDEX "IDX_student_runtime_actions_correlation" ON "student_runtime_actions" ("correlationId")`)
    await queryRunner.query(`
      CREATE TABLE "project_evaluations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'PENDING', "rubricVersion" character varying(120) NOT NULL,
        "objectiveMetrics" jsonb NOT NULL DEFAULT '[]'::jsonb, "teacherScores" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "summary" text NOT NULL DEFAULT '', "totalScore" double precision, "reviewedById" uuid,
        "revision" integer NOT NULL DEFAULT 1, "reviewedAt" TIMESTAMP WITH TIME ZONE,
        "publishedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_project_evaluations" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_project_evaluations_project" UNIQUE ("projectId"),
        CONSTRAINT "CK_project_evaluations_status" CHECK ("status" IN ('PENDING','REVIEWED','PUBLISHED')),
        CONSTRAINT "CK_project_evaluations_score" CHECK ("totalScore" IS NULL OR ("totalScore" >= 0 AND "totalScore" <= 100)),
        CONSTRAINT "CK_project_evaluations_revision" CHECK ("revision" > 0)
      )
    `)
    await queryRunner.query(`ALTER TABLE "runtime_sessions" ADD CONSTRAINT "FK_runtime_sessions_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "runtime_events" ADD CONSTRAINT "FK_runtime_events_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "runtime_events" ADD CONSTRAINT "FK_runtime_events_session" FOREIGN KEY ("sessionId") REFERENCES "runtime_sessions"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "runtime_alerts" ADD CONSTRAINT "FK_runtime_alerts_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "runtime_alerts" ADD CONSTRAINT "FK_runtime_alerts_event" FOREIGN KEY ("eventId") REFERENCES "runtime_events"("id") ON DELETE SET NULL`)
    await queryRunner.query(`ALTER TABLE "student_runtime_actions" ADD CONSTRAINT "FK_student_runtime_actions_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "student_runtime_actions" ADD CONSTRAINT "FK_student_runtime_actions_session" FOREIGN KEY ("sessionId") REFERENCES "runtime_sessions"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "student_runtime_actions" ADD CONSTRAINT "FK_student_runtime_actions_event" FOREIGN KEY ("eventId") REFERENCES "runtime_events"("id") ON DELETE SET NULL`)
    await queryRunner.query(`ALTER TABLE "student_runtime_actions" ADD CONSTRAINT "FK_student_runtime_actions_alert" FOREIGN KEY ("alertId") REFERENCES "runtime_alerts"("id") ON DELETE SET NULL`)
    await queryRunner.query(`ALTER TABLE "student_runtime_actions" ADD CONSTRAINT "FK_student_runtime_actions_actor" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "project_evaluations" ADD CONSTRAINT "FK_project_evaluations_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "project_evaluations" ADD CONSTRAINT "FK_project_evaluations_reviewer" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE RESTRICT`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "project_evaluations" CASCADE`)
    await queryRunner.query(`DROP TABLE "student_runtime_actions" CASCADE`)
    await queryRunner.query(`DROP TABLE "runtime_alerts" CASCADE`)
    await queryRunner.query(`DROP TABLE "runtime_events" CASCADE`)
    await queryRunner.query(`DROP TABLE "runtime_sessions" CASCADE`)
  }
}
