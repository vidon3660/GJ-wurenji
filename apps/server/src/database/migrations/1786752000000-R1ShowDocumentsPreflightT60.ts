import { MigrationInterface, QueryRunner } from "typeorm"

export class R1ShowDocumentsPreflightT601786752000000 implements MigrationInterface {
  name = "R1ShowDocumentsPreflightT601786752000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "show_project_documents" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL,
        "templateCode" character varying(60) NOT NULL, "title" character varying(160) NOT NULL,
        "filename" character varying(240) NOT NULL, "templatePackageId" uuid NOT NULL,
        "templatePackageVersion" character varying(40) NOT NULL, "templatePackageSha256" character varying(64) NOT NULL,
        "templatePath" character varying(500) NOT NULL, "status" character varying(30) NOT NULL DEFAULT 'NOT_STARTED',
        "revision" integer NOT NULL DEFAULT 1, "currentVersionNo" integer NOT NULL DEFAULT 0,
        "currentAssetId" uuid, "submittedVersionNo" integer, "lastSavedAt" TIMESTAMP WITH TIME ZONE,
        "submittedAt" TIMESTAMP WITH TIME ZONE, "viewedAt" TIMESTAMP WITH TIME ZONE,
        "returnedAt" TIMESTAMP WITH TIME ZONE, "resubmittedAt" TIMESTAMP WITH TIME ZONE,
        "reviewComment" text, "reviewScore" integer, "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_show_project_documents" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_show_project_documents_project_template" UNIQUE ("projectId", "templateCode"),
        CONSTRAINT "CK_show_project_documents_status" CHECK ("status" IN ('NOT_STARTED','EDITING','SUBMITTED','VIEWED','RETURNED','RESUBMITTED')),
        CONSTRAINT "CK_show_project_documents_revision" CHECK ("revision" > 0 AND "currentVersionNo" >= 0),
        CONSTRAINT "CK_show_project_documents_score" CHECK ("reviewScore" IS NULL OR ("reviewScore" >= 0 AND "reviewScore" <= 100))
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_show_project_documents_project" ON "show_project_documents" ("projectId")`)
    await queryRunner.query(`
      CREATE TABLE "show_project_document_versions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "documentId" uuid NOT NULL, "versionNo" integer NOT NULL,
        "kind" character varying(30) NOT NULL, "assetId" uuid NOT NULL, "createdById" uuid NOT NULL,
        "editorSessionId" uuid, "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_show_project_document_versions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_show_project_document_versions_number" UNIQUE ("documentId", "versionNo"),
        CONSTRAINT "CK_show_project_document_versions_kind" CHECK ("kind" IN ('TEMPLATE_COPY','AUTO_SAVE','MANUAL_SAVE','ONLYOFFICE_CALLBACK','SUBMISSION')),
        CONSTRAINT "CK_show_project_document_versions_number" CHECK ("versionNo" > 0)
      )
    `)
    await queryRunner.query(`
      CREATE TABLE "show_project_document_reviews" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "documentId" uuid NOT NULL, "versionNo" integer NOT NULL,
        "action" character varying(20) NOT NULL, "comment" text NOT NULL DEFAULT '', "score" integer,
        "reviewedById" uuid NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_show_project_document_reviews" PRIMARY KEY ("id"),
        CONSTRAINT "CK_show_project_document_reviews_action" CHECK ("action" IN ('VIEWED','RETURNED','COMMENTED')),
        CONSTRAINT "CK_show_project_document_reviews_score" CHECK ("score" IS NULL OR ("score" >= 0 AND "score" <= 100))
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_show_project_document_reviews_time" ON "show_project_document_reviews" ("documentId", "createdAt")`)
    await queryRunner.query(`
      CREATE TABLE "show_project_document_sessions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "documentId" uuid NOT NULL,
        "sessionKey" character varying(160) NOT NULL, "mode" character varying(20) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'OPEN', "actorId" uuid NOT NULL,
        "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "lastCallbackAt" TIMESTAMP WITH TIME ZONE,
        "closedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_show_project_document_sessions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_show_project_document_sessions_key" UNIQUE ("sessionKey"),
        CONSTRAINT "CK_show_project_document_sessions_mode" CHECK ("mode" IN ('EDIT','VIEW')),
        CONSTRAINT "CK_show_project_document_sessions_status" CHECK ("status" IN ('OPEN','CLOSED','EXPIRED'))
      )
    `)
    await queryRunner.query(`
      CREATE TABLE "show_preflight_records" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'DRAFT', "revision" integer NOT NULL DEFAULT 1,
        "items" jsonb NOT NULL DEFAULT '[]'::jsonb, "decision" character varying(40),
        "rationale" text NOT NULL DEFAULT '', "updatedById" uuid NOT NULL,
        "completedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_show_preflight_records" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_show_preflight_records_project" UNIQUE ("projectId"),
        CONSTRAINT "CK_show_preflight_records_status" CHECK ("status" IN ('DRAFT','COMPLETED')),
        CONSTRAINT "CK_show_preflight_records_decision" CHECK ("decision" IS NULL OR "decision" IN ('ALLOW','ALLOW_AFTER_RECTIFICATION','DELAY','CANCEL')),
        CONSTRAINT "CK_show_preflight_records_revision" CHECK ("revision" > 0)
      )
    `)
    await queryRunner.query(`
      CREATE TABLE "show_simulation_clocks" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'RUNNING', "originSimulationTimeMs" bigint NOT NULL DEFAULT 0,
        "originRealTime" TIMESTAMP WITH TIME ZONE NOT NULL, "rate" double precision NOT NULL DEFAULT 60,
        "plannedTakeoffSimulationTimeMs" bigint NOT NULL, "thresholdSimulationTimeMs" bigint NOT NULL,
        "plannedEndSimulationTimeMs" bigint NOT NULL, "revision" integer NOT NULL DEFAULT 1,
        "submittedAt" TIMESTAMP WITH TIME ZONE, "submittedById" uuid, "submissionSnapshot" jsonb,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_show_simulation_clocks" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_show_simulation_clocks_project" UNIQUE ("projectId"),
        CONSTRAINT "CK_show_simulation_clocks_status" CHECK ("status" IN ('RUNNING','PAUSED')),
        CONSTRAINT "CK_show_simulation_clocks_values" CHECK ("originSimulationTimeMs" >= 0 AND "rate" > 0 AND "thresholdSimulationTimeMs" >= 0 AND "plannedTakeoffSimulationTimeMs" > "thresholdSimulationTimeMs" AND "plannedEndSimulationTimeMs" > "plannedTakeoffSimulationTimeMs" AND "revision" > 0)
      )
    `)

    await queryRunner.query(`ALTER TABLE "show_project_documents" ADD CONSTRAINT "FK_show_project_documents_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "show_project_documents" ADD CONSTRAINT "FK_show_project_documents_asset" FOREIGN KEY ("currentAssetId") REFERENCES "file_assets"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "show_project_document_versions" ADD CONSTRAINT "FK_show_project_document_versions_document" FOREIGN KEY ("documentId") REFERENCES "show_project_documents"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "show_project_document_versions" ADD CONSTRAINT "FK_show_project_document_versions_asset" FOREIGN KEY ("assetId") REFERENCES "file_assets"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "show_project_document_versions" ADD CONSTRAINT "FK_show_project_document_versions_creator" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "show_project_document_reviews" ADD CONSTRAINT "FK_show_project_document_reviews_document" FOREIGN KEY ("documentId") REFERENCES "show_project_documents"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "show_project_document_reviews" ADD CONSTRAINT "FK_show_project_document_reviews_reviewer" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "show_project_document_sessions" ADD CONSTRAINT "FK_show_project_document_sessions_document" FOREIGN KEY ("documentId") REFERENCES "show_project_documents"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "show_project_document_sessions" ADD CONSTRAINT "FK_show_project_document_sessions_actor" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "show_preflight_records" ADD CONSTRAINT "FK_show_preflight_records_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "show_preflight_records" ADD CONSTRAINT "FK_show_preflight_records_updater" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "show_simulation_clocks" ADD CONSTRAINT "FK_show_simulation_clocks_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "show_simulation_clocks" ADD CONSTRAINT "FK_show_simulation_clocks_submitter" FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE RESTRICT`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "show_simulation_clocks" CASCADE`)
    await queryRunner.query(`DROP TABLE "show_preflight_records" CASCADE`)
    await queryRunner.query(`DROP TABLE "show_project_document_sessions" CASCADE`)
    await queryRunner.query(`DROP TABLE "show_project_document_reviews" CASCADE`)
    await queryRunner.query(`DROP TABLE "show_project_document_versions" CASCADE`)
    await queryRunner.query(`DROP TABLE "show_project_documents" CASCADE`)
  }
}
