import { Module } from "@nestjs/common"
import { TypeOrmModule } from "@nestjs/typeorm"
import { AuthModule } from "../../auth/auth.module.js"
import { UserEntity } from "../../entities.js"
import { ActivityModule } from "../activities/activity.module.js"
import { ResourcePackageEntity } from "../resources/resource-package.entity.js"
import { ProjectActivityCounterEntity, StudentProjectEntity, StudentProjectStageEntity } from "../assignments/assignment.entities.js"
import { LogisticsRouteEntity, LogisticsRoutePlanVersionEntity, LogisticsWaypointEntity } from "../logistics-route/logistics-route.entities.js"
import {
  LogisticsAircraftInstanceEntity,
  LogisticsDispatchItemEntity,
  LogisticsOrderBatchEntity,
  LogisticsOrderEntity,
  LogisticsScheduleVersionEntity
} from "../logistics-scheduling/logistics-scheduling.entities.js"
import { RuntimeAlertEntity, RuntimeEventEntity, RuntimeSessionEntity, StudentRuntimeActionEntity } from "../runtime/runtime.entities.js"
import { LogisticsReadinessService } from "./logistics-readiness.service.js"
import { LogisticsRuntimeController } from "./logistics-runtime.controller.js"
import { LogisticsRuntimeDataService } from "./logistics-runtime.data.js"
import { LogisticsDynamicScheduleVersionEntity, LogisticsRuntimeReadinessEntity, LogisticsRuntimeSnapshotEntity } from "./logistics-runtime.entities.js"
import { LogisticsRuntimeService } from "./logistics-runtime.service.js"
import { AssessmentWindowModule } from "../assessment/assessment-window.module.js"

@Module({
  imports: [
    AuthModule,
    AssessmentWindowModule,
    ActivityModule,
    TypeOrmModule.forFeature([
      UserEntity,
      StudentProjectEntity,
      StudentProjectStageEntity,
      ProjectActivityCounterEntity,
      LogisticsRoutePlanVersionEntity,
      LogisticsRouteEntity,
      LogisticsWaypointEntity,
      LogisticsOrderBatchEntity,
      LogisticsOrderEntity,
      LogisticsAircraftInstanceEntity,
      LogisticsScheduleVersionEntity,
      LogisticsDispatchItemEntity,
      RuntimeSessionEntity,
      RuntimeEventEntity,
      RuntimeAlertEntity,
      StudentRuntimeActionEntity,
      LogisticsRuntimeReadinessEntity,
      LogisticsRuntimeSnapshotEntity,
      LogisticsDynamicScheduleVersionEntity,
      ResourcePackageEntity
    ])
  ],
  controllers: [LogisticsRuntimeController],
  providers: [LogisticsRuntimeDataService, LogisticsRuntimeService, LogisticsReadinessService],
  exports: [LogisticsRuntimeService, LogisticsRuntimeDataService]
})
export class LogisticsRuntimeModule {}
