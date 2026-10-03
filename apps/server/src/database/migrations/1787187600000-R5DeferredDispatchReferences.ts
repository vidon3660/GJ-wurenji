import { MigrationInterface, QueryRunner } from "typeorm"

export class R5DeferredDispatchReferences1787187600000 implements MigrationInterface {
  name = "R5DeferredDispatchReferences1787187600000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "logistics_dispatch_items" DROP CONSTRAINT "FK_logistics_dispatch_order"`)
    await queryRunner.query(`ALTER TABLE "logistics_dispatch_items" DROP CONSTRAINT "FK_logistics_dispatch_aircraft"`)
    await queryRunner.query(`ALTER TABLE "logistics_dispatch_items" DROP CONSTRAINT "FK_logistics_dispatch_outbound"`)
    await queryRunner.query(`ALTER TABLE "logistics_dispatch_items" DROP CONSTRAINT "FK_logistics_dispatch_return"`)
    await queryRunner.query(`ALTER TABLE "logistics_dispatch_items" ADD CONSTRAINT "FK_logistics_dispatch_order" FOREIGN KEY ("orderId") REFERENCES "logistics_orders"("id") ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED`)
    await queryRunner.query(`ALTER TABLE "logistics_dispatch_items" ADD CONSTRAINT "FK_logistics_dispatch_aircraft" FOREIGN KEY ("aircraftId") REFERENCES "logistics_aircraft_instances"("id") ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED`)
    await queryRunner.query(`ALTER TABLE "logistics_dispatch_items" ADD CONSTRAINT "FK_logistics_dispatch_outbound" FOREIGN KEY ("outboundRouteId") REFERENCES "logistics_routes"("id") ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED`)
    await queryRunner.query(`ALTER TABLE "logistics_dispatch_items" ADD CONSTRAINT "FK_logistics_dispatch_return" FOREIGN KEY ("returnRouteId") REFERENCES "logistics_routes"("id") ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "logistics_dispatch_items" DROP CONSTRAINT "FK_logistics_dispatch_order"`)
    await queryRunner.query(`ALTER TABLE "logistics_dispatch_items" DROP CONSTRAINT "FK_logistics_dispatch_aircraft"`)
    await queryRunner.query(`ALTER TABLE "logistics_dispatch_items" DROP CONSTRAINT "FK_logistics_dispatch_outbound"`)
    await queryRunner.query(`ALTER TABLE "logistics_dispatch_items" DROP CONSTRAINT "FK_logistics_dispatch_return"`)
    await queryRunner.query(`ALTER TABLE "logistics_dispatch_items" ADD CONSTRAINT "FK_logistics_dispatch_order" FOREIGN KEY ("orderId") REFERENCES "logistics_orders"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "logistics_dispatch_items" ADD CONSTRAINT "FK_logistics_dispatch_aircraft" FOREIGN KEY ("aircraftId") REFERENCES "logistics_aircraft_instances"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "logistics_dispatch_items" ADD CONSTRAINT "FK_logistics_dispatch_outbound" FOREIGN KEY ("outboundRouteId") REFERENCES "logistics_routes"("id") ON DELETE RESTRICT`)
    await queryRunner.query(`ALTER TABLE "logistics_dispatch_items" ADD CONSTRAINT "FK_logistics_dispatch_return" FOREIGN KEY ("returnRouteId") REFERENCES "logistics_routes"("id") ON DELETE RESTRICT`)
  }
}
