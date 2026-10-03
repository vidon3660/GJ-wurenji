import { MigrationInterface, QueryRunner } from "typeorm"

export class R5LogisticsScheduling1787184000000 implements MigrationInterface {
  name = "R5LogisticsScheduling1787184000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "logistics_order_batches" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL,
        "generatorVersion" character varying(40) NOT NULL, "seed" character varying(120) NOT NULL,
        "checksum" character varying(64) NOT NULL, "config" jsonb NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_logistics_order_batches" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_logistics_order_batches_project" UNIQUE ("projectId")
      )
    `)
    await queryRunner.query(`
      CREATE TABLE "logistics_orders" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "batchId" uuid NOT NULL,
        "code" character varying(20) NOT NULL, "destinationNodeId" character varying(120) NOT NULL,
        "releaseTimeMs" integer NOT NULL, "priority" character varying(20) NOT NULL,
        "earliestStartTimeMs" integer NOT NULL, "latestArrivalTimeMs" integer NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'UNASSIGNED',
        CONSTRAINT "PK_logistics_orders" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_logistics_orders_batch_code" UNIQUE ("batchId", "code"),
        CONSTRAINT "CK_logistics_orders_priority" CHECK ("priority" IN ('NORMAL','PRIORITY','URGENT')),
        CONSTRAINT "CK_logistics_orders_status" CHECK ("status" IN ('UNRELEASED','UNASSIGNED','SCHEDULED')),
        CONSTRAINT "CK_logistics_orders_times" CHECK ("releaseTimeMs" >= 0 AND "earliestStartTimeMs" >= "releaseTimeMs" AND "latestArrivalTimeMs" > "earliestStartTimeMs")
      )
    `)
    await queryRunner.query(`
      CREATE TABLE "logistics_aircraft_instances" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL,
        "code" character varying(30) NOT NULL, "modelCode" character varying(60) NOT NULL,
        "initialBatteryPercent" double precision NOT NULL, "availableAtMs" integer NOT NULL DEFAULT 0,
        "status" character varying(20) NOT NULL DEFAULT 'READY',
        CONSTRAINT "PK_logistics_aircraft_instances" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_logistics_aircraft_project_code" UNIQUE ("projectId", "code"),
        CONSTRAINT "CK_logistics_aircraft_battery" CHECK ("initialBatteryPercent" BETWEEN 0 AND 100),
        CONSTRAINT "CK_logistics_aircraft_available" CHECK ("availableAtMs" >= 0),
        CONSTRAINT "CK_logistics_aircraft_status" CHECK ("status" IN ('READY','LOW_BATTERY','UNAVAILABLE'))
      )
    `)
    await queryRunner.query(`
      CREATE TABLE "logistics_schedule_drafts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL,
        "revision" integer NOT NULL DEFAULT 1, "items" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "lastCheckResult" jsonb, "updatedById" uuid NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_logistics_schedule_drafts" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_logistics_schedule_drafts_project" UNIQUE ("projectId"),
        CONSTRAINT "CK_logistics_schedule_drafts_revision" CHECK ("revision" > 0)
      )
    `)
    await queryRunner.query(`
      CREATE TABLE "logistics_schedule_versions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL,
        "versionNo" integer NOT NULL, "sourceDraftRevision" integer NOT NULL,
        "status" character varying(20) NOT NULL, "checkResult" jsonb NOT NULL,
        "createdById" uuid NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "submittedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_logistics_schedule_versions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_logistics_schedule_versions_project_version" UNIQUE ("projectId", "versionNo"),
        CONSTRAINT "CK_logistics_schedule_versions_revision" CHECK ("versionNo" > 0 AND "sourceDraftRevision" > 0),
        CONSTRAINT "CK_logistics_schedule_versions_status" CHECK ("status" IN ('SNAPSHOT','SUBMITTED'))
      )
    `)
    await queryRunner.query(`
      CREATE TABLE "logistics_dispatch_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "versionId" uuid NOT NULL,
        "sequence" integer NOT NULL, "itemKey" character varying(80) NOT NULL,
        "orderId" uuid NOT NULL, "aircraftId" uuid NOT NULL,
        "outboundRouteId" uuid NOT NULL, "returnRouteId" uuid NOT NULL,
        "plannedTakeoffTimeMs" integer NOT NULL, "arrivalTimeMs" integer NOT NULL,
        "returnStartTimeMs" integer NOT NULL, "landingTimeMs" integer NOT NULL,
        "nextAvailableTimeMs" integer NOT NULL, "batteryAfterMissionPercent" double precision NOT NULL,
        CONSTRAINT "PK_logistics_dispatch_items" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_logistics_dispatch_version_sequence" UNIQUE ("versionId", "sequence"),
        CONSTRAINT "UQ_logistics_dispatch_version_key" UNIQUE ("versionId", "itemKey"),
        CONSTRAINT "UQ_logistics_dispatch_version_order" UNIQUE ("versionId", "orderId"),
        CONSTRAINT "CK_logistics_dispatch_sequence" CHECK ("sequence" >= 0),
        CONSTRAINT "CK_logistics_dispatch_times" CHECK ("plannedTakeoffTimeMs" >= 0 AND "arrivalTimeMs" >= "plannedTakeoffTimeMs" AND "returnStartTimeMs" >= "arrivalTimeMs" AND "landingTimeMs" >= "returnStartTimeMs" AND "nextAvailableTimeMs" >= "landingTimeMs")
      )
    `)
    await queryRunner.query(`ALTER TABLE "logistics_order_batches" ADD CONSTRAINT "FK_logistics_order_batches_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "logistics_orders" ADD CONSTRAINT "FK_logistics_orders_batch" FOREIGN KEY ("batchId") REFERENCES "logistics_order_batches"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "logistics_aircraft_instances" ADD CONSTRAINT "FK_logistics_aircraft_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "logistics_schedule_drafts" ADD CONSTRAINT "FK_logistics_schedule_drafts_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "logistics_schedule_drafts" ADD CONSTRAINT "FK_logistics_schedule_drafts_updated_by" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "logistics_schedule_versions" ADD CONSTRAINT "FK_logistics_schedule_versions_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "logistics_schedule_versions" ADD CONSTRAINT "FK_logistics_schedule_versions_created_by" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "logistics_dispatch_items" ADD CONSTRAINT "FK_logistics_dispatch_version" FOREIGN KEY ("versionId") REFERENCES "logistics_schedule_versions"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "logistics_dispatch_items" ADD CONSTRAINT "FK_logistics_dispatch_order" FOREIGN KEY ("orderId") REFERENCES "logistics_orders"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "logistics_dispatch_items" ADD CONSTRAINT "FK_logistics_dispatch_aircraft" FOREIGN KEY ("aircraftId") REFERENCES "logistics_aircraft_instances"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "logistics_dispatch_items" ADD CONSTRAINT "FK_logistics_dispatch_outbound" FOREIGN KEY ("outboundRouteId") REFERENCES "logistics_routes"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "logistics_dispatch_items" ADD CONSTRAINT "FK_logistics_dispatch_return" FOREIGN KEY ("returnRouteId") REFERENCES "logistics_routes"("id") ON DELETE RESTRICT`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "logistics_dispatch_items" CASCADE`)
    await queryRunner.query(`DROP TABLE "logistics_schedule_versions" CASCADE`)
    await queryRunner.query(`DROP TABLE "logistics_schedule_drafts" CASCADE`)
    await queryRunner.query(`DROP TABLE "logistics_aircraft_instances" CASCADE`)
    await queryRunner.query(`DROP TABLE "logistics_orders" CASCADE`)
    await queryRunner.query(`DROP TABLE "logistics_order_batches" CASCADE`)
  }
}
