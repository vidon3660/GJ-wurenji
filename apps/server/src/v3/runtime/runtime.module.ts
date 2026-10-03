import { Module } from "@nestjs/common"
import { TypeOrmModule } from "@nestjs/typeorm"
import { AuthModule } from "../../auth/auth.module.js"
import { V3AssignmentModule } from "../assignments/assignment.module.js"
import { RuntimeController } from "./runtime.controller.js"
import { RuntimeAlertEntity } from "./runtime.entities.js"
import { RuntimeService } from "./runtime.service.js"

@Module({
  imports: [AuthModule, V3AssignmentModule, TypeOrmModule.forFeature([RuntimeAlertEntity])],
  controllers: [RuntimeController],
  providers: [RuntimeService]
})
export class RuntimeModule {}
