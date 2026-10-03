import { MigrationInterface, QueryRunner } from "typeorm"

export class R20RuntimeEventSimulationTimes1788652800000 implements MigrationInterface {
  name = "R20RuntimeEventSimulationTimes1788652800000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "runtime_events" ADD "triggeredSimulationTimeMs" bigint`)
    await queryRunner.query(`ALTER TABLE "runtime_events" ADD "resolvedSimulationTimeMs" bigint`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "runtime_events" DROP COLUMN "resolvedSimulationTimeMs"`)
    await queryRunner.query(`ALTER TABLE "runtime_events" DROP COLUMN "triggeredSimulationTimeMs"`)
  }
}
