import { Module } from "@nestjs/common"
import { TypeOrmModule } from "@nestjs/typeorm"
import { UserEntity } from "../../entities.js"
import { AuthModule } from "../../auth/auth.module.js"
import { ActivityModule } from "../activities/activity.module.js"
import {
  AssignmentDraftEntity,
  ProjectActivityCounterEntity,
  StudentProjectEntity,
  StudentProjectStageEntity
} from "../assignments/assignment.entities.js"
import { ResourcePackageModule } from "../resources/resource-package.module.js"
import { LogisticsRouteController } from "./logistics-route.controller.js"
import {
  LogisticsRegionAnalysisEntity,
  LogisticsRouteEntity,
  LogisticsRoutePlanDraftEntity,
  LogisticsRoutePlanVersionEntity,
  LogisticsRouteValidationRunEntity,
  LogisticsWaypointEntity
} from "./logistics-route.entities.js"
import { LogisticsRouteService } from "./logistics-route.service.js"
import { AssessmentWindowModule } from "../assessment/assessment-window.module.js"

@Module({
  imports: [
    AuthModule,
    AssessmentWindowModule,
    ActivityModule,
    ResourcePackageModule,
    TypeOrmModule.forFeature([
      UserEntity,
      AssignmentDraftEntity,
      StudentProjectEntity,
      StudentProjectStageEntity,
      ProjectActivityCounterEntity,
      LogisticsRegionAnalysisEntity,
      LogisticsRoutePlanDraftEntity,
      LogisticsRoutePlanVersionEntity,
      LogisticsRouteEntity,
      LogisticsWaypointEntity,
      LogisticsRouteValidationRunEntity
    ])
  ],
  controllers: [LogisticsRouteController],
  providers: [LogisticsRouteService],
  exports: [LogisticsRouteService]
})
export class LogisticsRouteModule {}
