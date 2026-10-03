import { Module } from "@nestjs/common"
import { TypeOrmModule } from "@nestjs/typeorm"
import { UserEntity } from "../../entities.js"
import { AuthModule } from "../../auth/auth.module.js"
import { StudentProjectEntity, StudentProjectStageEntity } from "../assignments/assignment.entities.js"
import { ResourcePackageModule } from "../resources/resource-package.module.js"
import { VtlProjectPlanEntity } from "./vtl-inspection.entities.js"
import { VtlInspectionController } from "./vtl-inspection.controller.js"
import { VtlInspectionService } from "./vtl-inspection.service.js"
import { AssessmentWindowModule } from "../assessment/assessment-window.module.js"

@Module({
  imports: [
    AuthModule,
    AssessmentWindowModule,
    ResourcePackageModule,
    TypeOrmModule.forFeature([UserEntity, StudentProjectEntity, StudentProjectStageEntity, VtlProjectPlanEntity])
  ],
  controllers: [VtlInspectionController],
  providers: [VtlInspectionService],
  exports: [VtlInspectionService]
})
export class VtlInspectionModule {}
