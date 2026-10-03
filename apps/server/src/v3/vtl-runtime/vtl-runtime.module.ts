import { Module } from "@nestjs/common"
import { TypeOrmModule } from "@nestjs/typeorm"
import { AuthModule } from "../../auth/auth.module.js"
import { UserEntity } from "../../entities.js"
import { ActivityModule } from "../activities/activity.module.js"
import { ProjectActivityCounterEntity, StudentProjectEntity, StudentProjectStageEntity } from "../assignments/assignment.entities.js"
import { RuntimeAlertEntity, RuntimeEventEntity, RuntimeSessionEntity, StudentRuntimeActionEntity } from "../runtime/runtime.entities.js"
import { VtlProjectPlanEntity } from "../vtl-inspection/vtl-inspection.entities.js"
import { VtlReorganizationEntity, VtlRuntimeSnapshotEntity } from "./vtl-runtime.entities.js"
import { VtlRuntimeController } from "./vtl-runtime.controller.js"
import { VtlRuntimeService } from "./vtl-runtime.service.js"
import { AssessmentWindowModule } from "../assessment/assessment-window.module.js"

@Module({
  imports: [AuthModule, ActivityModule, AssessmentWindowModule, TypeOrmModule.forFeature([UserEntity, StudentProjectEntity, StudentProjectStageEntity, ProjectActivityCounterEntity, RuntimeSessionEntity, RuntimeEventEntity, RuntimeAlertEntity, StudentRuntimeActionEntity, VtlProjectPlanEntity, VtlRuntimeSnapshotEntity, VtlReorganizationEntity])],
  controllers: [VtlRuntimeController],
  providers: [VtlRuntimeService],
  exports: [VtlRuntimeService]
})
export class VtlRuntimeModule {}
