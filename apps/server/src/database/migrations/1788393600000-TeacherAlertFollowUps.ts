import { MigrationInterface, QueryRunner } from "typeorm"

export class TeacherAlertFollowUps1788393600000 implements MigrationInterface {
  name = "TeacherAlertFollowUps1788393600000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "teacher_alert_follow_ups" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "teacherId" uuid NOT NULL,
        "alertId" uuid NOT NULL,
        "projectId" uuid NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'WATCHING',
        "note" text NOT NULL DEFAULT '',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_teacher_alert_follow_ups" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_teacher_alert_follow_up_teacher_alert" UNIQUE ("teacherId", "alertId"),
        CONSTRAINT "CK_teacher_alert_follow_up_status" CHECK ("status" IN ('WATCHING','CLOSED'))
      )
    `)
    await queryRunner.query(`CREATE INDEX "IDX_teacher_alert_follow_ups_teacher_status" ON "teacher_alert_follow_ups" ("teacherId", "status")`)
    await queryRunner.query(`CREATE INDEX "IDX_teacher_alert_follow_ups_alert" ON "teacher_alert_follow_ups" ("alertId")`)
    await queryRunner.query(`ALTER TABLE "teacher_alert_follow_ups" ADD CONSTRAINT "FK_teacher_alert_follow_ups_teacher" FOREIGN KEY ("teacherId") REFERENCES "users"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "teacher_alert_follow_ups" ADD CONSTRAINT "FK_teacher_alert_follow_ups_alert" FOREIGN KEY ("alertId") REFERENCES "runtime_alerts"("id") ON DELETE CASCADE`)
    await queryRunner.query(`ALTER TABLE "teacher_alert_follow_ups" ADD CONSTRAINT "FK_teacher_alert_follow_ups_project" FOREIGN KEY ("projectId") REFERENCES "student_projects"("id") ON DELETE CASCADE`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "teacher_alert_follow_ups" CASCADE`)
  }
}
