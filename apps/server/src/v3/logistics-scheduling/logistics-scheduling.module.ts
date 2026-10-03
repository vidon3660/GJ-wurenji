import { Module } from "@nestjs/common"
import { TypeOrmModule } from "@nestjs/typeorm"
import { UserEntity } from "../../entities.js"
import { AuthModule } from "../../auth/auth.module.js"
import { ActivityModule } from "../activities/activity.module.js"
import { ProjectActivityCounterEntity, StudentProjectEntity, StudentProjectStageEntity } from "../assignments/assignment.entities.js"
import { LogisticsRegionAnalysisEntity, LogisticsRouteEntity, LogisticsRoutePlanVersionEntity, LogisticsWaypointEntity } from "../logistics-route/logistics-route.entities.js"
import { LogisticsSchedulingController } from "./logistics-scheduling.controller.js"
import {
  LogisticsAircraftInstanceEntity,
  LogisticsDispatchItemEntity,
  LogisticsOrderBatchEntity,
  LogisticsOrderEntity,
  LogisticsScheduleDraftEntity,
  LogisticsScheduleVersionEntity
} from "./logistics-scheduling.entities.js"
import { LogisticsSchedulingService } from "./logistics-scheduling.service.js"
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
      LogisticsRegionAnalysisEntity,
      LogisticsRoutePlanVersionEntity,
      LogisticsRouteEntity,
      LogisticsWaypointEntity,
      LogisticsOrderBatchEntity,
      LogisticsOrderEntity,
      LogisticsAircraftInstanceEntity,
      LogisticsScheduleDraftEntity,
      LogisticsScheduleVersionEntity,
      LogisticsDispatchItemEntity
    ])
  ],
  controllers: [LogisticsSchedulingController],
  providers: [LogisticsSchedulingService],
  exports: [LogisticsSchedulingService]
})
export class LogisticsSchedulingModule {}
