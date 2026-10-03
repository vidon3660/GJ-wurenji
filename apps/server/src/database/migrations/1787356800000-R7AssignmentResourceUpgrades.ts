import { MigrationInterface, QueryRunner } from "typeorm"

export class R7AssignmentResourceUpgrades1787356800000 implements MigrationInterface {
  name = "R7AssignmentResourceUpgrades1787356800000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assignment_snapshots" ADD "resourceRevision" integer NOT NULL DEFAULT 1`)
    await queryRunner.query(`
      CREATE TABLE "assignment_snapshot_resource_revisions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "snapshotId" uuid NOT NULL,
        "revision" integer NOT NULL,
        "config" jsonb NOT NULL,
        "resourceRefs" jsonb NOT NULL,
        "checksum" character varying(64) NOT NULL,
        "reason" text,
        "changedById" uuid NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_assignment_snapshot_resource_revisions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_assignment_snapshot_resource_revision" UNIQUE ("snapshotId", "revision"),
        CONSTRAINT "CK_assignment_snapshot_resource_revision_positive" CHECK ("revision" > 0)
      )
    `)
    await queryRunner.query(`
      INSERT INTO "assignment_snapshot_resource_revisions" (
        "snapshotId", "revision", "config", "resourceRefs", "checksum", "reason", "changedById", "createdAt"
      )
      SELECT "id", 1, "config", "resourceRefs", "checksum", '初始发布版本', "publishedById", "publishedAt"
      FROM "assignment_snapshots"
    `)
    await queryRunner.query(`ALTER TABLE "assignment_snapshot_resource_revisions" ADD CONSTRAINT "FK_assignment_snapshot_resource_revision_snapshot" FOREIGN KEY ("snapshotId") REFERENCES "assignment_snapshots"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "assignment_snapshot_resource_revisions" ADD CONSTRAINT "FK_assignment_snapshot_resource_revision_user" FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE RESTRICT`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "assignment_snapshot_resource_revisions" CASCADE`)
    await queryRunner.query(`ALTER TABLE "assignment_snapshots" DROP COLUMN "resourceRevision"`)
  }
}
