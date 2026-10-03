import { Module } from "@nestjs/common"
import { TypeOrmModule } from "@nestjs/typeorm"
import { AuthModule } from "../../auth/auth.module.js"
import { UserEntity } from "../../entities.js"
import { ActivityModule } from "../activities/activity.module.js"
import { ProjectActivityEventEntity } from "../activities/activity-event.entity.js"
import { FileAssetEntity } from "../files/file-asset.entity.js"
import { FileAssetModule } from "../files/file-asset.module.js"
import { StudentProjectEntity, StudentProjectStageEntity } from "../assignments/assignment.entities.js"
import { ProjectEvaluationEntity, RuntimeAlertEntity, RuntimeEventEntity, RuntimeSessionEntity, StudentRuntimeActionEntity } from "../runtime/runtime.entities.js"
import { VtlProjectPlanEntity } from "../vtl-inspection/vtl-inspection.entities.js"
import { VtlReorganizationEntity, VtlRuntimeSnapshotEntity } from "../vtl-runtime/vtl-runtime.entities.js"
import { ShowProjectReportEntity } from "../show-review/show-review.entities.js"
import { VtlReviewController } from "./vtl-review.controller.js"
import { VtlReviewService } from "./vtl-review.service.js"
import { JobInfrastructureModule } from "../jobs/job-infrastructure.module.js"
import { JobEntity, OutboxEventEntity } from "../jobs/job.entities.js"
import { ResourcePackageModule } from "../resources/resource-package.module.js"
import { AssessmentWindowModule } from "../assessment/assessment-window.module.js"

@Module({
  imports: [AuthModule, ActivityModule, AssessmentWindowModule, FileAssetModule, ResourcePackageModule, JobInfrastructureModule, TypeOrmModule.forFeature([
    UserEntity,
    ProjectActivityEventEntity,
    StudentProjectEntity,
    StudentProjectStageEntity,
    ProjectEvaluationEntity,
    RuntimeSessionEntity,
    RuntimeEventEntity,
    RuntimeAlertEntity,
    StudentRuntimeActionEntity,
    VtlProjectPlanEntity,
    VtlRuntimeSnapshotEntity,
    VtlReorganizationEntity,
    ShowProjectReportEntity,
    FileAssetEntity,
    JobEntity,
    OutboxEventEntity
  ])],
  controllers: [VtlReviewController],
  providers: [VtlReviewService],
  exports: [VtlReviewService]
})
export class VtlReviewModule {}
