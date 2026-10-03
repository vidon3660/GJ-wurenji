import { MigrationInterface, QueryRunner } from "typeorm"

export class R19RuntimeResourceVersions1788566400000 implements MigrationInterface {
  name = "R19RuntimeResourceVersions1788566400000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "runtime_sessions" ADD "mode" character varying(20)`)
    await queryRunner.query(`ALTER TABLE "runtime_sessions" ADD "mapResourceVersion" character varying(220)`)
    await queryRunner.query(`ALTER TABLE "runtime_sessions" ADD "sceneResourceVersion" character varying(220)`)
    await queryRunner.query(`ALTER TABLE "runtime_sessions" ADD "planVersion" character varying(220)`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "runtime_sessions" DROP COLUMN "mode"`)
    await queryRunner.query(`ALTER TABLE "runtime_sessions" DROP COLUMN "planVersion"`)
    await queryRunner.query(`ALTER TABLE "runtime_sessions" DROP COLUMN "sceneResourceVersion"`)
    await queryRunner.query(`ALTER TABLE "runtime_sessions" DROP COLUMN "mapResourceVersion"`)
  }
}
