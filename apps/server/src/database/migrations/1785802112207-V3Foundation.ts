import { MigrationInterface, QueryRunner } from "typeorm";

export class V3Foundation1785802112207 implements MigrationInterface {
    name = 'V3Foundation1785802112207'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "assignment_drafts" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "title" character varying(160) NOT NULL,
                "sceneType" character varying(40) NOT NULL,
                "mode" character varying(20) NOT NULL,
                "status" character varying(20) NOT NULL DEFAULT 'DRAFT',
                "config" jsonb NOT NULL,
                "revision" integer NOT NULL DEFAULT '1',
                "configHash" character varying(64),
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                "sourceExerciseVersionId" uuid,
                "createdById" uuid NOT NULL,
                CONSTRAINT "PK_f71f4a4d309c53073501bd2ea13" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "assignment_snapshots" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "schemaVersion" integer NOT NULL DEFAULT '3',
                "title" character varying(160) NOT NULL,
                "sceneType" character varying(40) NOT NULL,
                "mode" character varying(20) NOT NULL,
                "config" jsonb NOT NULL,
                "resourceRefs" jsonb NOT NULL DEFAULT '[]'::jsonb,
                "checksum" character varying(64) NOT NULL,
                "publishedAt" TIMESTAMP NOT NULL DEFAULT now(),
                "draftId" uuid NOT NULL,
                "publishedById" uuid NOT NULL,
                CONSTRAINT "REL_aa8eb47580e0af2a5d73b24a4c" UNIQUE ("draftId"),
                CONSTRAINT "PK_4e8b295f28c87461c1f454d342b" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_6b0313b3b93914dafcd9b2dbf3" ON "assignment_snapshots" ("checksum")
        `);
        await queryRunner.query(`
            CREATE TABLE "assignment_targets" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "targetType" character varying(20) NOT NULL,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "snapshotId" uuid NOT NULL,
                "classroomId" uuid,
                "studentId" uuid,
                CONSTRAINT "PK_ce6398e71c309ea1d9d611106c8" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "student_projects" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "status" character varying(20) NOT NULL DEFAULT 'NOT_STARTED',
                "currentStageCode" character varying(60) NOT NULL,
                "lastActivityAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                "snapshotId" uuid NOT NULL,
                "studentId" uuid NOT NULL,
                CONSTRAINT "PK_69a4a7f7cdd1a21f1248179e92a" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_15ef47fecd8f7d7d59f22e74ac" ON "student_projects" ("snapshotId", "studentId")
        `);
        await queryRunner.query(`
            CREATE TABLE "student_project_stages" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "stageCode" character varying(60) NOT NULL,
                "sequence" integer NOT NULL,
                "status" character varying(20) NOT NULL,
                "revision" integer NOT NULL DEFAULT '1',
                "submittedAt" TIMESTAMP WITH TIME ZONE,
                "acceptedAt" TIMESTAMP WITH TIME ZONE,
                "returnedAt" TIMESTAMP WITH TIME ZONE,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                "projectId" uuid NOT NULL,
                CONSTRAINT "PK_017e7e24bd0a389e27569db6212" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_0a04c982a52cfd026b71f2064c" ON "student_project_stages" ("projectId", "sequence")
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_c6cc80324d2b34c5112275e79b" ON "student_project_stages" ("projectId", "stageCode")
        `);
        await queryRunner.query(`
            CREATE TABLE "project_activity_counters" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "savedVersionCount" integer NOT NULL DEFAULT '0',
                "validationCount" integer NOT NULL DEFAULT '0',
                "runtimeCount" integer NOT NULL DEFAULT '0',
                "actionCount" integer NOT NULL DEFAULT '0',
                "submissionCount" integer NOT NULL DEFAULT '0',
                "resubmissionCount" integer NOT NULL DEFAULT '0',
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                "projectId" uuid NOT NULL,
                CONSTRAINT "REL_98f5dcad68f4fa828bf6f8b05c" UNIQUE ("projectId"),
                CONSTRAINT "PK_2d2c19d747505e4bbf111f7ba62" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "resource_packages" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "packageType" character varying(40) NOT NULL,
                "name" character varying(120) NOT NULL,
                "version" character varying(40) NOT NULL,
                "schemaVersion" integer NOT NULL DEFAULT '1',
                "minimumPlatformVersion" character varying(40) NOT NULL DEFAULT '0.1.0',
                "sha256" character varying(64) NOT NULL,
                "status" character varying(20) NOT NULL DEFAULT 'STAGED',
                "manifest" jsonb NOT NULL DEFAULT '{}'::jsonb,
                "activatedAt" TIMESTAMP WITH TIME ZONE,
                "retiredAt" TIMESTAMP WITH TIME ZONE,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                "createdById" uuid NOT NULL,
                CONSTRAINT "PK_c88f87bb11814f45fe96483e0be" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "uq_resource_packages_active_name" ON "resource_packages" ("packageType", "name")
            WHERE status = 'ACTIVE'
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_0446cf0b205efa6a94b26d66dc" ON "resource_packages" ("packageType", "name", "version")
        `);
        await queryRunner.query(`
            ALTER TABLE "exercise_templates"
            ALTER COLUMN "tags"
            SET DEFAULT '[]'::jsonb
        `);
        await queryRunner.query(`
            ALTER TABLE "assignment_drafts"
            ADD CONSTRAINT "FK_09a8d94d0808dbd8a5f467b37e4" FOREIGN KEY ("sourceExerciseVersionId") REFERENCES "exercise_versions"("id") ON DELETE
            SET NULL ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "assignment_drafts"
            ADD CONSTRAINT "FK_0321dfa228a54e3680006c81b97" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "assignment_snapshots"
            ADD CONSTRAINT "FK_aa8eb47580e0af2a5d73b24a4c0" FOREIGN KEY ("draftId") REFERENCES "assignment_drafts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "assignment_snapshots"
            ADD CONSTRAINT "FK_2e0f3d64b34a611f3eca8cfb570" FOREIGN KEY ("publishedById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "assignment_targets"
            ADD CONSTRAINT "FK_01056b69ded95fe9a8f0956a23b" FOREIGN KEY ("snapshotId") REFERENCES "assignment_snapshots"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "assignment_targets"
            ADD CONSTRAINT "FK_50ee43574172f7b4d5916276bd6" FOREIGN KEY ("classroomId") REFERENCES "course_classes"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "assignment_targets"
            ADD CONSTRAINT "FK_4e73cac08f30e444365954e6388" FOREIGN KEY ("studentId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "student_projects"
            ADD CONSTRAINT "FK_8d96eb7d2d3d73ebed14ee86037" FOREIGN KEY ("snapshotId") REFERENCES "assignment_snapshots"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "student_projects"
            ADD CONSTRAINT "FK_b5eb05a6c9351fea89c0498ff86" FOREIGN KEY ("studentId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "student_project_stages"
            ADD CONSTRAINT "FK_0e5de5a61c33ae4426a1b254732" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "project_activity_counters"
            ADD CONSTRAINT "FK_98f5dcad68f4fa828bf6f8b05c5" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "resource_packages"
            ADD CONSTRAINT "FK_e641c315cde1f568c11ec523c5f" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "resource_packages" DROP CONSTRAINT "FK_e641c315cde1f568c11ec523c5f"
        `);
        await queryRunner.query(`
            ALTER TABLE "project_activity_counters" DROP CONSTRAINT "FK_98f5dcad68f4fa828bf6f8b05c5"
        `);
        await queryRunner.query(`
            ALTER TABLE "student_project_stages" DROP CONSTRAINT "FK_0e5de5a61c33ae4426a1b254732"
        `);
        await queryRunner.query(`
            ALTER TABLE "student_projects" DROP CONSTRAINT "FK_b5eb05a6c9351fea89c0498ff86"
        `);
        await queryRunner.query(`
            ALTER TABLE "student_projects" DROP CONSTRAINT "FK_8d96eb7d2d3d73ebed14ee86037"
        `);
        await queryRunner.query(`
            ALTER TABLE "assignment_targets" DROP CONSTRAINT "FK_4e73cac08f30e444365954e6388"
        `);
        await queryRunner.query(`
            ALTER TABLE "assignment_targets" DROP CONSTRAINT "FK_50ee43574172f7b4d5916276bd6"
        `);
        await queryRunner.query(`
            ALTER TABLE "assignment_targets" DROP CONSTRAINT "FK_01056b69ded95fe9a8f0956a23b"
        `);
        await queryRunner.query(`
            ALTER TABLE "assignment_snapshots" DROP CONSTRAINT "FK_2e0f3d64b34a611f3eca8cfb570"
        `);
        await queryRunner.query(`
            ALTER TABLE "assignment_snapshots" DROP CONSTRAINT "FK_aa8eb47580e0af2a5d73b24a4c0"
        `);
        await queryRunner.query(`
            ALTER TABLE "assignment_drafts" DROP CONSTRAINT "FK_0321dfa228a54e3680006c81b97"
        `);
        await queryRunner.query(`
            ALTER TABLE "assignment_drafts" DROP CONSTRAINT "FK_09a8d94d0808dbd8a5f467b37e4"
        `);
        await queryRunner.query(`
            ALTER TABLE "exercise_templates"
            ALTER COLUMN "tags"
            SET DEFAULT '[]'
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_0446cf0b205efa6a94b26d66dc"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."uq_resource_packages_active_name"
        `);
        await queryRunner.query(`
            DROP TABLE "resource_packages"
        `);
        await queryRunner.query(`
            DROP TABLE "project_activity_counters"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_c6cc80324d2b34c5112275e79b"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_0a04c982a52cfd026b71f2064c"
        `);
        await queryRunner.query(`
            DROP TABLE "student_project_stages"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_15ef47fecd8f7d7d59f22e74ac"
        `);
        await queryRunner.query(`
            DROP TABLE "student_projects"
        `);
        await queryRunner.query(`
            DROP TABLE "assignment_targets"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_6b0313b3b93914dafcd9b2dbf3"
        `);
        await queryRunner.query(`
            DROP TABLE "assignment_snapshots"
        `);
        await queryRunner.query(`
            DROP TABLE "assignment_drafts"
        `);
    }

}
