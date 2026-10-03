import { MigrationInterface, QueryRunner } from "typeorm"

export class R0JobOutbox1786579200000 implements MigrationInterface {
  name = "R0JobOutbox1786579200000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "jobs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "jobType" character varying(100) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'PENDING', "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "result" jsonb NOT NULL DEFAULT '{}'::jsonb, "priority" integer NOT NULL DEFAULT 0,
        "attempts" integer NOT NULL DEFAULT 0, "maxAttempts" integer NOT NULL DEFAULT 5,
        "availableAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "leaseOwner" character varying(160),
        "leaseExpiresAt" TIMESTAMP WITH TIME ZONE, "heartbeatAt" TIMESTAMP WITH TIME ZONE,
        "lastError" text, "correlationId" uuid NOT NULL, "idempotencyKey" character varying(200),
        "sourceOutboxEventId" uuid, "finishedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_jobs" PRIMARY KEY ("id"), CONSTRAINT "UQ_jobs_idempotency_key" UNIQUE ("idempotencyKey"),
        CONSTRAINT "UQ_jobs_source_outbox" UNIQUE ("sourceOutboxEventId"),
        CONSTRAINT "CK_jobs_status" CHECK ("status" IN ('PENDING','RUNNING','RETRY_WAIT','SUCCEEDED','DEAD_LETTER','CANCELLED')),
        CONSTRAINT "CK_jobs_attempts" CHECK ("attempts" >= 0 AND "maxAttempts" > 0 AND "attempts" <= "maxAttempts"),
        CONSTRAINT "CK_jobs_priority" CHECK ("priority" BETWEEN -1000 AND 1000)
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_jobs_claim" ON "jobs" ("status", "priority" DESC, "availableAt", "createdAt")`)
    await queryRunner.query(`CREATE INDEX "IDX_jobs_lease" ON "jobs" ("leaseExpiresAt") WHERE "status" = 'RUNNING'`)
    await queryRunner.query(`CREATE INDEX "IDX_jobs_correlation" ON "jobs" ("correlationId")`)
    await queryRunner.query(`
      CREATE TABLE "outbox_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "eventType" character varying(100) NOT NULL,
        "jobType" character varying(100) NOT NULL, "aggregateType" character varying(80) NOT NULL,
        "aggregateId" character varying(160) NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'PENDING',
        "payload" jsonb NOT NULL DEFAULT '{}'::jsonb, "priority" integer NOT NULL DEFAULT 0,
        "attempts" integer NOT NULL DEFAULT 0, "maxAttempts" integer NOT NULL DEFAULT 5,
        "availableAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "leaseOwner" character varying(160),
        "leaseExpiresAt" TIMESTAMP WITH TIME ZONE, "lastError" text, "correlationId" uuid NOT NULL,
        "publishedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_outbox_events" PRIMARY KEY ("id"),
        CONSTRAINT "CK_outbox_events_status" CHECK ("status" IN ('PENDING','PROCESSING','PUBLISHED','FAILED')),
        CONSTRAINT "CK_outbox_events_attempts" CHECK ("attempts" >= 0 AND "maxAttempts" > 0),
        CONSTRAINT "CK_outbox_events_priority" CHECK ("priority" BETWEEN -1000 AND 1000)
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_outbox_claim" ON "outbox_events" ("status", "availableAt", "createdAt")`)
    await queryRunner.query(`CREATE INDEX "IDX_outbox_lease" ON "outbox_events" ("leaseExpiresAt") WHERE "status" = 'PROCESSING'`)
    await queryRunner.query(`CREATE INDEX "IDX_outbox_aggregate" ON "outbox_events" ("aggregateType", "aggregateId")`)
    await queryRunner.query(`CREATE INDEX "IDX_outbox_correlation" ON "outbox_events" ("correlationId")`)
    await queryRunner.query(`ALTER TABLE "jobs" ADD CONSTRAINT "FK_jobs_source_outbox" FOREIGN KEY ("sourceOutboxEventId") REFERENCES "outbox_events"("id") ON DELETE RESTRICT`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "jobs" CASCADE`)
    await queryRunner.query(`DROP TABLE "outbox_events" CASCADE`)
  }
}
