import { MigrationInterface, QueryRunner } from "typeorm"

export class R4LogisticsRoutes1787097600000 implements MigrationInterface {
  name = "R4LogisticsRoutes1787097600000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "logistics_region_analyses" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL,
        "revision" integer NOT NULL DEFAULT 1, "status" character varying(20) NOT NULL DEFAULT 'DRAFT',
        "selectedDeliveryPointIds" jsonb NOT NULL DEFAULT '[]'::jsonb, "notes" text NOT NULL DEFAULT '',
        "submittedAt" TIMESTAMP WITH TIME ZONE, "updatedById" uuid NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_logistics_region_analyses" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_logistics_region_analyses_project" UNIQUE ("projectId"),
        CONSTRAINT "CK_logistics_region_analyses_revision" CHECK ("revision" > 0),
        CONSTRAINT "CK_logistics_region_analyses_status" CHECK ("status" IN ('DRAFT','CONFIRMED'))
      )
    `)
    await queryRunner.query(`
      CREATE TABLE "logistics_route_plan_drafts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL,
        "revision" integer NOT NULL DEFAULT 1, "routes" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "lastCheckResult" jsonb, "updatedById" uuid NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_logistics_route_plan_drafts" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_logistics_route_plan_drafts_project" UNIQUE ("projectId"),
        CONSTRAINT "CK_logistics_route_plan_drafts_revision" CHECK ("revision" > 0)
      )
    `)
    await queryRunner.query(`
      CREATE TABLE "logistics_route_plan_versions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL,
        "versionNo" integer NOT NULL, "sourceDraftRevision" integer NOT NULL,
        "status" character varying(20) NOT NULL, "checkResult" jsonb NOT NULL,
        "validationResult" jsonb, "createdById" uuid NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "validatedAt" TIMESTAMP WITH TIME ZONE,
        "submittedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_logistics_route_plan_versions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_logistics_route_plan_versions_project_version" UNIQUE ("projectId", "versionNo"),
        CONSTRAINT "CK_logistics_route_plan_versions_version" CHECK ("versionNo" > 0 AND "sourceDraftRevision" > 0),
        CONSTRAINT "CK_logistics_route_plan_versions_status" CHECK ("status" IN ('SNAPSHOT','VALIDATED','SUBMITTED'))
      )
    `)
    await queryRunner.query(`
      CREATE TABLE "logistics_routes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "versionId" uuid NOT NULL,
        "routeKey" character varying(80) NOT NULL, "name" character varying(120) NOT NULL,
        "destinationNodeId" character varying(120) NOT NULL, "direction" character varying(20) NOT NULL,
        "role" character varying(20) NOT NULL, "groupCode" character varying(60) NOT NULL,
        "departureNodeId" character varying(120) NOT NULL, "arrivalNodeId" character varying(120) NOT NULL,
        "protectionRadiusMeters" double precision NOT NULL,
        "waitingNodeIds" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "alternateLandingNodeIds" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "emergencyAreaNodeIds" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "entryDirectionDegrees" double precision NOT NULL, "exitDirectionDegrees" double precision NOT NULL,
        CONSTRAINT "PK_logistics_routes" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_logistics_routes_version_key" UNIQUE ("versionId", "routeKey"),
        CONSTRAINT "CK_logistics_routes_direction" CHECK ("direction" IN ('OUTBOUND','RETURN')),
        CONSTRAINT "CK_logistics_routes_role" CHECK ("role" IN ('PRIMARY','ALTERNATE')),
        CONSTRAINT "CK_logistics_routes_protection" CHECK ("protectionRadiusMeters" BETWEEN 10 AND 200)
      )
    `)
    await queryRunner.query(`
      CREATE TABLE "logistics_waypoints" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "routeId" uuid NOT NULL,
        "sequence" integer NOT NULL, "waypointKey" character varying(80) NOT NULL,
        "name" character varying(120) NOT NULL, "longitude" double precision NOT NULL,
        "latitude" double precision NOT NULL, "altitudeMeters" double precision NOT NULL DEFAULT 0,
        "segmentAltitudeMeters" double precision NOT NULL DEFAULT 40, "speedMps" double precision NOT NULL DEFAULT 12,
        "nodeId" character varying(120), "locked" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_logistics_waypoints" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_logistics_waypoints_route_sequence" UNIQUE ("routeId", "sequence"),
        CONSTRAINT "UQ_logistics_waypoints_route_key" UNIQUE ("routeId", "waypointKey"),
        CONSTRAINT "CK_logistics_waypoints_sequence" CHECK ("sequence" >= 0),
        CONSTRAINT "CK_logistics_waypoints_longitude" CHECK ("longitude" BETWEEN -180 AND 180),
        CONSTRAINT "CK_logistics_waypoints_latitude" CHECK ("latitude" BETWEEN -90 AND 90)
      )
    `)
    await queryRunner.query(`
      CREATE TABLE "logistics_route_validation_runs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL,
        "versionId" uuid NOT NULL, "attemptNo" integer NOT NULL,
        "status" character varying(20) NOT NULL, "seed" character varying(120) NOT NULL,
        "result" jsonb NOT NULL, "createdById" uuid NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_logistics_route_validation_runs" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_logistics_route_validation_runs_project_attempt" UNIQUE ("projectId", "attemptNo"),
        CONSTRAINT "CK_logistics_route_validation_runs_attempt" CHECK ("attemptNo" > 0),
        CONSTRAINT "CK_logistics_route_validation_runs_status" CHECK ("status" IN ('PASSED','WITH_RISK','HARD_CONFLICT','INFEASIBLE'))
      )
    `)
    await queryRunner.query(`ALTER TABLE "logistics_region_analyses" ADD CONSTRAINT "FK_logistics_region_analyses_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "logistics_region_analyses" ADD CONSTRAINT "FK_logistics_region_analyses_updated_by" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "logistics_route_plan_drafts" ADD CONSTRAINT "FK_logistics_route_plan_drafts_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "logistics_route_plan_drafts" ADD CONSTRAINT "FK_logistics_route_plan_drafts_updated_by" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "logistics_route_plan_versions" ADD CONSTRAINT "FK_logistics_route_plan_versions_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "logistics_route_plan_versions" ADD CONSTRAINT "FK_logistics_route_plan_versions_created_by" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "logistics_routes" ADD CONSTRAINT "FK_logistics_routes_version" FOREIGN KEY ("versionId") REFERENCES "logistics_route_plan_versions"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "logistics_waypoints" ADD CONSTRAINT "FK_logistics_waypoints_route" FOREIGN KEY ("routeId") REFERENCES "logistics_routes"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "logistics_route_validation_runs" ADD CONSTRAINT "FK_logistics_route_validation_runs_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "logistics_route_validation_runs" ADD CONSTRAINT "FK_logistics_route_validation_runs_version" FOREIGN KEY ("versionId") REFERENCES "logistics_route_plan_versions"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "logistics_route_validation_runs" ADD CONSTRAINT "FK_logistics_route_validation_runs_created_by" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "logistics_route_validation_runs" CASCADE`)
    await queryRunner.query(`DROP TABLE "logistics_waypoints" CASCADE`)
    await queryRunner.query(`DROP TABLE "logistics_routes" CASCADE`)
    await queryRunner.query(`DROP TABLE "logistics_route_plan_versions" CASCADE`)
    await queryRunner.query(`DROP TABLE "logistics_route_plan_drafts" CASCADE`)
    await queryRunner.query(`DROP TABLE "logistics_region_analyses" CASCADE`)
  }
}
