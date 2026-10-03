import { Module } from "@nestjs/common"
import { TypeOrmModule } from "@nestjs/typeorm"
import { AuthModule } from "../../auth/auth.module.js"
import { UserEntity } from "../../entities.js"
import { ActivityModule } from "../activities/activity.module.js"
import { ProjectActivityEventEntity } from "../activities/activity-event.entity.js"
import { StudentProjectEntity, StudentProjectStageEntity } from "../assignments/assignment.entities.js"
import { FileAssetModule } from "../files/file-asset.module.js"
import { FileAssetEntity } from "../files/file-asset.entity.js"
import { ProjectEvaluationEntity, RuntimeAlertEntity, RuntimeEventEntity, RuntimeSessionEntity, StudentRuntimeActionEntity } from "../runtime/runtime.entities.js"
import { LogisticsRoutePlanVersionEntity, LogisticsRouteValidationRunEntity } from "../logistics-route/logistics-route.entities.js"
import { LogisticsScheduleVersionEntity } from "../logistics-scheduling/logistics-scheduling.entities.js"
import { LogisticsDynamicScheduleVersionEntity, LogisticsRuntimeSnapshotEntity } from "../logistics-runtime/logistics-runtime.entities.js"
import { LogisticsRuntimeModule } from "../logistics-runtime/logistics-runtime.module.js"
import { ShowProjectReportEntity, ShowReviewAnnotationEntity } from "../show-review/show-review.entities.js"
import { LogisticsReviewController } from "./logistics-review.controller.js"
import { LogisticsReviewService } from "./logistics-review.service.js"
import { ResourcePackageModule } from "../resources/resource-package.module.js"
import { AssessmentWindowModule } from "../assessment/assessment-window.module.js"

@Module({
  imports: [AuthModule, ActivityModule, FileAssetModule, LogisticsRuntimeModule, ResourcePackageModule, AssessmentWindowModule, TypeOrmModule.forFeature([
    UserEntity,
    StudentProjectEntity,
    StudentProjectStageEntity,
    ProjectEvaluationEntity,
    RuntimeSessionEntity,
    RuntimeEventEntity,
    RuntimeAlertEntity,
    StudentRuntimeActionEntity,
    LogisticsRuntimeSnapshotEntity,
    LogisticsDynamicScheduleVersionEntity,
    ProjectActivityEventEntity,
    LogisticsRoutePlanVersionEntity,
    LogisticsRouteValidationRunEntity,
    LogisticsScheduleVersionEntity,
    ShowReviewAnnotationEntity,
    ShowProjectReportEntity,
    FileAssetEntity
  ])],
  controllers: [LogisticsReviewController],
  providers: [LogisticsReviewService]
})
export class LogisticsReviewModule {}
