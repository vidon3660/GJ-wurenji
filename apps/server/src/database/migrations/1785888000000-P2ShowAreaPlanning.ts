import { MigrationInterface, QueryRunner } from "typeorm"

export class P2ShowAreaPlanning1785888000000 implements MigrationInterface {
  name = "P2ShowAreaPlanning1785888000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS postgis`)
    await queryRunner.query(`
      CREATE TABLE "show_area_plan_drafts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "revision" integer NOT NULL DEFAULT 1,
        "features" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "projectId" uuid NOT NULL,
        "updatedById" uuid NOT NULL,
        CONSTRAINT "UQ_show_area_plan_drafts_project" UNIQUE ("projectId"),
        CONSTRAINT "PK_show_area_plan_drafts" PRIMARY KEY ("id"),
        CONSTRAINT "CK_show_area_plan_drafts_revision" CHECK ("revision" > 0)
      )
    `)
    await queryRunner.query(`
      CREATE TABLE "file_assets" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "category" character varying(40) NOT NULL,
        "storageProvider" character varying(20) NOT NULL DEFAULT 'LOCAL',
        "objectKey" character varying(500) NOT NULL,
        "originalName" character varying(240) NOT NULL,
        "mimeType" character varying(120) NOT NULL,
        "sizeBytes" integer NOT NULL,
        "sha256" character varying(64) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'AVAILABLE',
        "ownerType" character varying(40) NOT NULL,
        "ownerId" uuid NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "createdById" uuid NOT NULL,
        CONSTRAINT "UQ_file_assets_object_key" UNIQUE ("objectKey"),
        CONSTRAINT "PK_file_assets" PRIMARY KEY ("id"),
        CONSTRAINT "CK_file_assets_size" CHECK ("sizeBytes" >= 0),
        CONSTRAINT "CK_file_assets_status" CHECK ("status" IN ('AVAILABLE', 'ARCHIVED', 'DELETED'))
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_file_assets_owner" ON "file_assets" ("ownerType", "ownerId")`)
    await queryRunner.query(`
      CREATE TABLE "show_area_plan_versions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "versionNo" integer NOT NULL,
        "sourceDraftRevision" integer NOT NULL,
        "status" character varying(30) NOT NULL,
        "terrainSnapshot" jsonb NOT NULL,
        "checkResult" jsonb NOT NULL,
        "reviewComment" text,
        "reviewScore" integer,
        "reviewedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "submittedAt" TIMESTAMP WITH TIME ZONE,
        "projectId" uuid NOT NULL,
        "planningMapAssetId" uuid,
        "reviewedById" uuid,
        "createdById" uuid NOT NULL,
        CONSTRAINT "PK_show_area_plan_versions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_show_area_plan_versions_project_version" UNIQUE ("projectId", "versionNo"),
        CONSTRAINT "CK_show_area_plan_versions_number" CHECK ("versionNo" > 0 AND "sourceDraftRevision" > 0),
        CONSTRAINT "CK_show_area_plan_versions_status" CHECK ("status" IN ('SNAPSHOT', 'GENERATING', 'GENERATION_FAILED', 'SUBMITTED', 'RETURNED', 'ACCEPTED')),
        CONSTRAINT "CK_show_area_plan_versions_score" CHECK ("reviewScore" IS NULL OR ("reviewScore" >= 0 AND "reviewScore" <= 100))
      )
    `)
    await queryRunner.query(`
      CREATE TABLE "show_area_features" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "featureKey" character varying(80) NOT NULL,
        "type" character varying(40) NOT NULL,
        "label" character varying(120) NOT NULL,
        "geometry" geometry(Polygon,4326) NOT NULL,
        "heightDatum" character varying(10),
        "minimumHeightMeters" double precision,
        "maximumHeightMeters" double precision,
        "properties" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "sourceRevision" integer NOT NULL,
        "versionId" uuid NOT NULL,
        "updatedById" uuid NOT NULL,
        CONSTRAINT "PK_show_area_features" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_show_area_features_version_key" UNIQUE ("versionId", "featureKey"),
        CONSTRAINT "CK_show_area_features_type" CHECK ("type" IN ('TAKEOFF_LANDING', 'FLIGHT', 'PERFORMANCE', 'BUFFER', 'GROUND_ISOLATION', 'AUDIENCE', 'OPERATION', 'EMERGENCY_LANDING', 'GEOFENCE')),
        CONSTRAINT "CK_show_area_features_height" CHECK (("heightDatum" IS NULL AND "minimumHeightMeters" IS NULL AND "maximumHeightMeters" IS NULL) OR ("heightDatum" IN ('AGL', 'AMSL') AND "minimumHeightMeters" < "maximumHeightMeters"))
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_show_area_features_version_type" ON "show_area_features" ("versionId", "type")`)
    await queryRunner.query(`CREATE INDEX "IDX_show_area_features_geometry" ON "show_area_features" USING GIST ("geometry")`)
    await queryRunner.query(`ALTER TABLE "show_area_plan_drafts" ADD CONSTRAINT "FK_show_area_plan_drafts_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "show_area_plan_drafts" ADD CONSTRAINT "FK_show_area_plan_drafts_user" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "file_assets" ADD CONSTRAINT "FK_file_assets_user" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "show_area_plan_versions" ADD CONSTRAINT "FK_show_area_plan_versions_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "show_area_plan_versions" ADD CONSTRAINT "FK_show_area_plan_versions_asset" FOREIGN KEY ("planningMapAssetId") REFERENCES "file_assets"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "show_area_plan_versions" ADD CONSTRAINT "FK_show_area_plan_versions_reviewer" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "show_area_plan_versions" ADD CONSTRAINT "FK_show_area_plan_versions_creator" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "show_area_features" ADD CONSTRAINT "FK_show_area_features_version" FOREIGN KEY ("versionId") REFERENCES "show_area_plan_versions"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "show_area_features" ADD CONSTRAINT "FK_show_area_features_user" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "show_area_features" DROP CONSTRAINT "FK_show_area_features_user"`)
    await queryRunner.query(`ALTER TABLE "show_area_features" DROP CONSTRAINT "FK_show_area_features_version"`)
    await queryRunner.query(`ALTER TABLE "show_area_plan_versions" DROP CONSTRAINT "FK_show_area_plan_versions_creator"`)
    await queryRunner.query(`ALTER TABLE "show_area_plan_versions" DROP CONSTRAINT "FK_show_area_plan_versions_reviewer"`)
    await queryRunner.query(`ALTER TABLE "show_area_plan_versions" DROP CONSTRAINT "FK_show_area_plan_versions_asset"`)
    await queryRunner.query(`ALTER TABLE "show_area_plan_versions" DROP CONSTRAINT "FK_show_area_plan_versions_project"`)
    await queryRunner.query(`ALTER TABLE "file_assets" DROP CONSTRAINT "FK_file_assets_user"`)
    await queryRunner.query(`ALTER TABLE "show_area_plan_drafts" DROP CONSTRAINT "FK_show_area_plan_drafts_user"`)
    await queryRunner.query(`ALTER TABLE "show_area_plan_drafts" DROP CONSTRAINT "FK_show_area_plan_drafts_project"`)
    await queryRunner.query(`DROP INDEX "IDX_show_area_features_geometry"`)
    await queryRunner.query(`DROP INDEX "IDX_show_area_features_version_type"`)
    await queryRunner.query(`DROP TABLE "show_area_features"`)
    await queryRunner.query(`DROP TABLE "show_area_plan_versions"`)
    await queryRunner.query(`DROP INDEX "IDX_file_assets_owner"`)
    await queryRunner.query(`DROP TABLE "file_assets"`)
    await queryRunner.query(`DROP TABLE "show_area_plan_drafts"`)
  }
}
