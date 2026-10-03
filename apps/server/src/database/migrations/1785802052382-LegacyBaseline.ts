import { MigrationInterface, QueryRunner } from "typeorm";

export class LegacyBaseline1785802052382 implements MigrationInterface {
    name = 'LegacyBaseline1785802052382'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "postgis"`);
        await queryRunner.query(`
            CREATE TABLE "users" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "email" character varying(200) NOT NULL,
                "displayName" character varying(120) NOT NULL,
                "role" character varying(20) NOT NULL,
                "passwordHash" character varying(200) NOT NULL,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_97672ac88f789774dd47f7c8be" ON "users" ("email")
        `);
        await queryRunner.query(`
            CREATE TABLE "practices" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "title" character varying(160) NOT NULL,
                "type" character varying(40) NOT NULL,
                "status" character varying(20) NOT NULL DEFAULT 'DRAFT',
                "sceneDraft" jsonb NOT NULL,
                "publishedScene" jsonb,
                "sceneVersion" integer NOT NULL DEFAULT '0',
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                "createdById" uuid NOT NULL,
                CONSTRAINT "PK_0934829c5859a843625e6ff1c34" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "solutions" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "draft" jsonb NOT NULL,
                "revision" integer NOT NULL DEFAULT '1',
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                "practiceId" uuid NOT NULL,
                "studentId" uuid NOT NULL,
                CONSTRAINT "PK_05589f12803f420b119df2f6170" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_5f4c1530b5e3c76e9c709da447" ON "solutions" ("practiceId", "studentId")
        `);
        await queryRunner.query(`
            CREATE TABLE "solution_versions" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "version" integer NOT NULL,
                "snapshot" jsonb NOT NULL,
                "sceneSnapshot" jsonb NOT NULL,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "solutionId" uuid NOT NULL,
                CONSTRAINT "PK_55012b08bb943aabbd5534c6a81" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "simulation_runs" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "status" character varying(20) NOT NULL DEFAULT 'QUEUED',
                "progress" integer NOT NULL DEFAULT '0',
                "summary" jsonb,
                "resultPath" character varying(500),
                "errorMessage" text,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                "solutionVersionId" uuid NOT NULL,
                CONSTRAINT "PK_e721bc4d4fe17be8cab15c245e9" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "submissions" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "submittedAt" TIMESTAMP NOT NULL DEFAULT now(),
                "practiceId" uuid NOT NULL,
                "studentId" uuid NOT NULL,
                "solutionVersionId" uuid NOT NULL,
                "simulationRunId" uuid NOT NULL,
                CONSTRAINT "PK_10b3be95b8b2fb1e482e07d706b" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_c00a9d6d4e76eb922a5b086a27" ON "submissions" ("practiceId", "studentId")
        `);
        await queryRunner.query(`
            CREATE TABLE "courses" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "code" character varying(60) NOT NULL,
                "name" character varying(160) NOT NULL,
                "term" character varying(80) NOT NULL,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                "createdById" uuid NOT NULL,
                CONSTRAINT "PK_3f70a487cc718ad8eda4e6d58c9" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_86b3589486bac01d2903e22471" ON "courses" ("code")
        `);
        await queryRunner.query(`
            CREATE TABLE "course_classes" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "code" character varying(60) NOT NULL,
                "name" character varying(160) NOT NULL,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                "courseId" uuid NOT NULL,
                "createdById" uuid NOT NULL,
                CONSTRAINT "PK_05ac0244dd8944211770d0cda55" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_84a1b0bc2e95b0438b97697b88" ON "course_classes" ("courseId", "code")
        `);
        await queryRunner.query(`
            CREATE TABLE "class_members" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "classroomId" uuid NOT NULL,
                "studentId" uuid NOT NULL,
                CONSTRAINT "PK_c06d2c3bc732509dcbbab8d5730" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_f84dad502d2b8d8dae8dd41b68" ON "class_members" ("classroomId", "studentId")
        `);
        await queryRunner.query(`
            CREATE TABLE "onboarding_states" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "guideKey" character varying(80) NOT NULL,
                "version" integer NOT NULL,
                "skipped" boolean NOT NULL DEFAULT false,
                "completedAt" TIMESTAMP NOT NULL DEFAULT now(),
                "userId" uuid NOT NULL,
                CONSTRAINT "PK_6d6c8e47268bb17679e7c724dfb" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_a254e41d3d73a29111c16ec8ee" ON "onboarding_states" ("userId", "guideKey", "version")
        `);
        await queryRunner.query(`
            CREATE TABLE "exercise_templates" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "title" character varying(160) NOT NULL,
                "type" character varying(40) NOT NULL,
                "difficulty" character varying(30) NOT NULL,
                "summary" text NOT NULL,
                "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
                "status" character varying(20) NOT NULL DEFAULT 'DRAFT',
                "currentVersion" integer NOT NULL DEFAULT '1',
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                "createdById" uuid NOT NULL,
                CONSTRAINT "PK_4502e934f85783b907cc9142253" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "exercise_versions" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "version" integer NOT NULL,
                "taskBrief" text NOT NULL,
                "sceneSnapshot" jsonb NOT NULL,
                "referenceAnswer" jsonb NOT NULL,
                "evaluationScheme" jsonb NOT NULL,
                "publishedAt" TIMESTAMP WITH TIME ZONE,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "templateId" uuid NOT NULL,
                CONSTRAINT "PK_97868ca8b331f94493ec6d6849c" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_79806ecfbe4e11fcbca75ae1a5" ON "exercise_versions" ("templateId", "version")
        `);
        await queryRunner.query(`
            CREATE TABLE "teaching_assignments" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "title" character varying(160) NOT NULL,
                "status" character varying(20) NOT NULL DEFAULT 'PUBLISHED',
                "availableAt" TIMESTAMP WITH TIME ZONE NOT NULL,
                "dueAt" TIMESTAMP WITH TIME ZONE NOT NULL,
                "leaderboardEnabled" boolean NOT NULL DEFAULT false,
                "leaderboardDisplayLimit" integer NOT NULL DEFAULT '10',
                "leaderboardDisplayMode" character varying(20) NOT NULL DEFAULT 'ANONYMIZED',
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                "classroomId" uuid NOT NULL,
                "practiceId" uuid NOT NULL,
                "exerciseVersionId" uuid,
                "createdById" uuid NOT NULL,
                CONSTRAINT "PK_baf0d10098561a9840957b512e0" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_a2083280b17e565a135f170e77" ON "teaching_assignments" ("classroomId", "practiceId")
        `);
        await queryRunner.query(`
            CREATE TABLE "grades" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "status" character varying(20) NOT NULL DEFAULT 'AUTO',
                "autoScore" double precision NOT NULL,
                "totalScore" double precision NOT NULL,
                "passed" boolean NOT NULL,
                "hardConstraintsPassed" boolean NOT NULL,
                "teacherAdjustment" double precision NOT NULL DEFAULT '0',
                "teacherFeedback" text,
                "dimensions" jsonb NOT NULL,
                "metrics" jsonb NOT NULL,
                "revision" integer NOT NULL DEFAULT '1',
                "resultFileReady" boolean NOT NULL DEFAULT false,
                "publishedAt" TIMESTAMP WITH TIME ZONE,
                "evaluatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                "submissionId" uuid NOT NULL,
                "practiceId" uuid NOT NULL,
                "studentId" uuid NOT NULL,
                "assignmentId" uuid,
                CONSTRAINT "PK_4740fb6f5df2505a48649f1687b" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_d9d3e0c4ac49ec8411b52f2fb8" ON "grades" ("submissionId")
        `);
        await queryRunner.query(`
            CREATE TABLE "result_files" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "revision" integer NOT NULL,
                "storagePath" character varying(500) NOT NULL,
                "sha256" character varying(64) NOT NULL,
                "mimeType" character varying(100) NOT NULL DEFAULT 'application/pdf',
                "size" integer NOT NULL,
                "active" boolean NOT NULL DEFAULT true,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "gradeId" uuid NOT NULL,
                CONSTRAINT "PK_24a7c8144a20728177f06f885c8" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_e8762f454f49515dd8ce8f104e" ON "result_files" ("gradeId", "revision")
        `);
        await queryRunner.query(`
            ALTER TABLE "practices"
            ADD CONSTRAINT "FK_1151f374bb6a60d2bfb5ef898c8" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "solutions"
            ADD CONSTRAINT "FK_e015a65a8fa261ec953bb52bb6e" FOREIGN KEY ("practiceId") REFERENCES "practices"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "solutions"
            ADD CONSTRAINT "FK_63e2bfc4710e5f00d73222727ae" FOREIGN KEY ("studentId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "solution_versions"
            ADD CONSTRAINT "FK_628658c879ccbff895cdce32ba6" FOREIGN KEY ("solutionId") REFERENCES "solutions"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "simulation_runs"
            ADD CONSTRAINT "FK_9bd4591c7a45201f74bf7f74124" FOREIGN KEY ("solutionVersionId") REFERENCES "solution_versions"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "submissions"
            ADD CONSTRAINT "FK_41a38e207f7632cc54a784d86d3" FOREIGN KEY ("practiceId") REFERENCES "practices"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "submissions"
            ADD CONSTRAINT "FK_4fc99318a291abd7e2a50f50851" FOREIGN KEY ("studentId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "submissions"
            ADD CONSTRAINT "FK_ae12e1e21159b0ca51dd4ff295c" FOREIGN KEY ("solutionVersionId") REFERENCES "solution_versions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "submissions"
            ADD CONSTRAINT "FK_c38156178a27fd373a5a7f65d9f" FOREIGN KEY ("simulationRunId") REFERENCES "simulation_runs"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "courses"
            ADD CONSTRAINT "FK_3fff66ead8c0964a1805eb194b3" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "course_classes"
            ADD CONSTRAINT "FK_544fb0b514e25450ff04f454a92" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "course_classes"
            ADD CONSTRAINT "FK_7a1203a35bb8eff171460e43b50" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "class_members"
            ADD CONSTRAINT "FK_ff7edde3925bec26d98a701a10e" FOREIGN KEY ("classroomId") REFERENCES "course_classes"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "class_members"
            ADD CONSTRAINT "FK_380d103d0300fd69bcaa6dfa76a" FOREIGN KEY ("studentId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "onboarding_states"
            ADD CONSTRAINT "FK_6b52482d5ea3416668fe735fb12" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "exercise_templates"
            ADD CONSTRAINT "FK_4c0b52848265929d37450895479" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "exercise_versions"
            ADD CONSTRAINT "FK_702e125819363ef2e1751627342" FOREIGN KEY ("templateId") REFERENCES "exercise_templates"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "teaching_assignments"
            ADD CONSTRAINT "FK_5841a2e3e53b74800d53e03bf09" FOREIGN KEY ("classroomId") REFERENCES "course_classes"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "teaching_assignments"
            ADD CONSTRAINT "FK_1cadd92a7edc91a5551bdd5049b" FOREIGN KEY ("practiceId") REFERENCES "practices"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "teaching_assignments"
            ADD CONSTRAINT "FK_52d0b0ff45d65b3d21bc7f6f821" FOREIGN KEY ("exerciseVersionId") REFERENCES "exercise_versions"("id") ON DELETE
            SET NULL ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "teaching_assignments"
            ADD CONSTRAINT "FK_0aefaa6eb570810fdfdccae113e" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "grades"
            ADD CONSTRAINT "FK_d9d3e0c4ac49ec8411b52f2fb87" FOREIGN KEY ("submissionId") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "grades"
            ADD CONSTRAINT "FK_51a1e5d1fa55790b64ee6c109f1" FOREIGN KEY ("practiceId") REFERENCES "practices"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "grades"
            ADD CONSTRAINT "FK_fcfc027e4e5fb37a4372e688070" FOREIGN KEY ("studentId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "grades"
            ADD CONSTRAINT "FK_9a4ec29a3b29310f9fe8999bf3f" FOREIGN KEY ("assignmentId") REFERENCES "teaching_assignments"("id") ON DELETE
            SET NULL ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "result_files"
            ADD CONSTRAINT "FK_3675e165c7c891f40b7a3545d31" FOREIGN KEY ("gradeId") REFERENCES "grades"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "result_files" DROP CONSTRAINT "FK_3675e165c7c891f40b7a3545d31"
        `);
        await queryRunner.query(`
            ALTER TABLE "grades" DROP CONSTRAINT "FK_9a4ec29a3b29310f9fe8999bf3f"
        `);
        await queryRunner.query(`
            ALTER TABLE "grades" DROP CONSTRAINT "FK_fcfc027e4e5fb37a4372e688070"
        `);
        await queryRunner.query(`
            ALTER TABLE "grades" DROP CONSTRAINT "FK_51a1e5d1fa55790b64ee6c109f1"
        `);
        await queryRunner.query(`
            ALTER TABLE "grades" DROP CONSTRAINT "FK_d9d3e0c4ac49ec8411b52f2fb87"
        `);
        await queryRunner.query(`
            ALTER TABLE "teaching_assignments" DROP CONSTRAINT "FK_0aefaa6eb570810fdfdccae113e"
        `);
        await queryRunner.query(`
            ALTER TABLE "teaching_assignments" DROP CONSTRAINT "FK_52d0b0ff45d65b3d21bc7f6f821"
        `);
        await queryRunner.query(`
            ALTER TABLE "teaching_assignments" DROP CONSTRAINT "FK_1cadd92a7edc91a5551bdd5049b"
        `);
        await queryRunner.query(`
            ALTER TABLE "teaching_assignments" DROP CONSTRAINT "FK_5841a2e3e53b74800d53e03bf09"
        `);
        await queryRunner.query(`
            ALTER TABLE "exercise_versions" DROP CONSTRAINT "FK_702e125819363ef2e1751627342"
        `);
        await queryRunner.query(`
            ALTER TABLE "exercise_templates" DROP CONSTRAINT "FK_4c0b52848265929d37450895479"
        `);
        await queryRunner.query(`
            ALTER TABLE "onboarding_states" DROP CONSTRAINT "FK_6b52482d5ea3416668fe735fb12"
        `);
        await queryRunner.query(`
            ALTER TABLE "class_members" DROP CONSTRAINT "FK_380d103d0300fd69bcaa6dfa76a"
        `);
        await queryRunner.query(`
            ALTER TABLE "class_members" DROP CONSTRAINT "FK_ff7edde3925bec26d98a701a10e"
        `);
        await queryRunner.query(`
            ALTER TABLE "course_classes" DROP CONSTRAINT "FK_7a1203a35bb8eff171460e43b50"
        `);
        await queryRunner.query(`
            ALTER TABLE "course_classes" DROP CONSTRAINT "FK_544fb0b514e25450ff04f454a92"
        `);
        await queryRunner.query(`
            ALTER TABLE "courses" DROP CONSTRAINT "FK_3fff66ead8c0964a1805eb194b3"
        `);
        await queryRunner.query(`
            ALTER TABLE "submissions" DROP CONSTRAINT "FK_c38156178a27fd373a5a7f65d9f"
        `);
        await queryRunner.query(`
            ALTER TABLE "submissions" DROP CONSTRAINT "FK_ae12e1e21159b0ca51dd4ff295c"
        `);
        await queryRunner.query(`
            ALTER TABLE "submissions" DROP CONSTRAINT "FK_4fc99318a291abd7e2a50f50851"
        `);
        await queryRunner.query(`
            ALTER TABLE "submissions" DROP CONSTRAINT "FK_41a38e207f7632cc54a784d86d3"
        `);
        await queryRunner.query(`
            ALTER TABLE "simulation_runs" DROP CONSTRAINT "FK_9bd4591c7a45201f74bf7f74124"
        `);
        await queryRunner.query(`
            ALTER TABLE "solution_versions" DROP CONSTRAINT "FK_628658c879ccbff895cdce32ba6"
        `);
        await queryRunner.query(`
            ALTER TABLE "solutions" DROP CONSTRAINT "FK_63e2bfc4710e5f00d73222727ae"
        `);
        await queryRunner.query(`
            ALTER TABLE "solutions" DROP CONSTRAINT "FK_e015a65a8fa261ec953bb52bb6e"
        `);
        await queryRunner.query(`
            ALTER TABLE "practices" DROP CONSTRAINT "FK_1151f374bb6a60d2bfb5ef898c8"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_e8762f454f49515dd8ce8f104e"
        `);
        await queryRunner.query(`
            DROP TABLE "result_files"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_d9d3e0c4ac49ec8411b52f2fb8"
        `);
        await queryRunner.query(`
            DROP TABLE "grades"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_a2083280b17e565a135f170e77"
        `);
        await queryRunner.query(`
            DROP TABLE "teaching_assignments"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_79806ecfbe4e11fcbca75ae1a5"
        `);
        await queryRunner.query(`
            DROP TABLE "exercise_versions"
        `);
        await queryRunner.query(`
            DROP TABLE "exercise_templates"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_a254e41d3d73a29111c16ec8ee"
        `);
        await queryRunner.query(`
            DROP TABLE "onboarding_states"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_f84dad502d2b8d8dae8dd41b68"
        `);
        await queryRunner.query(`
            DROP TABLE "class_members"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_84a1b0bc2e95b0438b97697b88"
        `);
        await queryRunner.query(`
            DROP TABLE "course_classes"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_86b3589486bac01d2903e22471"
        `);
        await queryRunner.query(`
            DROP TABLE "courses"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_c00a9d6d4e76eb922a5b086a27"
        `);
        await queryRunner.query(`
            DROP TABLE "submissions"
        `);
        await queryRunner.query(`
            DROP TABLE "simulation_runs"
        `);
        await queryRunner.query(`
            DROP TABLE "solution_versions"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_5f4c1530b5e3c76e9c709da447"
        `);
        await queryRunner.query(`
            DROP TABLE "solutions"
        `);
        await queryRunner.query(`
            DROP TABLE "practices"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_97672ac88f789774dd47f7c8be"
        `);
        await queryRunner.query(`
            DROP TABLE "users"
        `);
    }

}
