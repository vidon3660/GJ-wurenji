import { MigrationInterface, QueryRunner } from "typeorm"

export class R0SignedResourcePackages1786665600000 implements MigrationInterface {
  name = "R0SignedResourcePackages1786665600000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "resource_packages" ADD "source" character varying(30) NOT NULL DEFAULT 'BUILT_IN'`)
    await queryRunner.query(`ALTER TABLE "resource_packages" ADD "archiveManifest" jsonb`)
    await queryRunner.query(`ALTER TABLE "resource_packages" ADD "signatureKeyId" character varying(120)`)
    await queryRunner.query(`ALTER TABLE "resource_packages" ADD "validationChecks" jsonb NOT NULL DEFAULT '[]'::jsonb`)
    await queryRunner.query(`ALTER TABLE "resource_packages" ADD "validatedAt" TIMESTAMP WITH TIME ZONE`)
    await queryRunner.query(`ALTER TABLE "resource_packages" ADD "rejectionReason" text`)
    await queryRunner.query(`ALTER TABLE "resource_packages" ADD "archiveAssetId" uuid`)
    await queryRunner.query(`ALTER TABLE "resource_packages" ADD CONSTRAINT "FK_resource_packages_archive_asset" FOREIGN KEY ("archiveAssetId") REFERENCES "file_assets"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_resource_packages_archive_asset" ON "resource_packages" ("archiveAssetId") WHERE "archiveAssetId" IS NOT NULL`)
    await queryRunner.query(`
      CREATE TABLE "resource_package_validation_runs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "packageId" uuid NOT NULL,
        "status" character varying(20) NOT NULL, "archiveSha256" character varying(64) NOT NULL,
        "signatureKeyId" character varying(120), "checks" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "errorMessage" text, "actorId" uuid NOT NULL,
        "completedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_resource_package_validation_runs" PRIMARY KEY ("id"),
        CONSTRAINT "CK_resource_package_validation_status" CHECK ("status" IN ('PASSED','FAILED'))
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_resource_package_validation_package" ON "resource_package_validation_runs" ("packageId", "createdAt")`)
    await queryRunner.query(`ALTER TABLE "resource_package_validation_runs" ADD CONSTRAINT "FK_resource_package_validation_package" FOREIGN KEY ("packageId") REFERENCES "resource_packages"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "resource_package_validation_runs" ADD CONSTRAINT "FK_resource_package_validation_actor" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`
      CREATE TABLE "resource_package_lifecycle_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "packageId" uuid NOT NULL,
        "packageType" character varying(40) NOT NULL, "name" character varying(120) NOT NULL,
        "version" character varying(40) NOT NULL, "action" character varying(20) NOT NULL,
        "previousPackageId" uuid, "reason" text, "actorId" uuid NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_resource_package_lifecycle_events" PRIMARY KEY ("id"),
        CONSTRAINT "CK_resource_package_lifecycle_action" CHECK ("action" IN ('UPLOADED','PREFLIGHT_PASSED','PREFLIGHT_FAILED','ACTIVATED','RETIRED','ROLLED_BACK'))
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_resource_package_lifecycle_package" ON "resource_package_lifecycle_events" ("packageId", "createdAt")`)
    await queryRunner.query(`CREATE INDEX "IDX_resource_package_lifecycle_name" ON "resource_package_lifecycle_events" ("packageType", "name", "createdAt")`)
    await queryRunner.query(`ALTER TABLE "resource_package_lifecycle_events" ADD CONSTRAINT "FK_resource_package_lifecycle_package" FOREIGN KEY ("packageId") REFERENCES "resource_packages"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "resource_package_lifecycle_events" ADD CONSTRAINT "FK_resource_package_lifecycle_actor" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "resource_packages" ALTER COLUMN "status" SET DEFAULT 'UPLOADED'`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "resource_packages" ALTER COLUMN "status" SET DEFAULT 'STAGED'`)
    await queryRunner.query(`DROP TABLE "resource_package_lifecycle_events" CASCADE`)
    await queryRunner.query(`DROP TABLE "resource_package_validation_runs" CASCADE`)
    await queryRunner.query(`DROP INDEX "UQ_resource_packages_archive_asset"`)
    await queryRunner.query(`ALTER TABLE "resource_packages" DROP CONSTRAINT "FK_resource_packages_archive_asset"`)
    await queryRunner.query(`ALTER TABLE "resource_packages" DROP COLUMN "archiveAssetId"`)
    await queryRunner.query(`ALTER TABLE "resource_packages" DROP COLUMN "rejectionReason"`)
    await queryRunner.query(`ALTER TABLE "resource_packages" DROP COLUMN "validatedAt"`)
    await queryRunner.query(`ALTER TABLE "resource_packages" DROP COLUMN "validationChecks"`)
    await queryRunner.query(`ALTER TABLE "resource_packages" DROP COLUMN "signatureKeyId"`)
    await queryRunner.query(`ALTER TABLE "resource_packages" DROP COLUMN "archiveManifest"`)
    await queryRunner.query(`ALTER TABLE "resource_packages" DROP COLUMN "source"`)
  }
}
