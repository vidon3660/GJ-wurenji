import { Module } from "@nestjs/common"
import { TypeOrmModule } from "@nestjs/typeorm"
import { AuthModule } from "../../auth/auth.module.js"
import { UserEntity } from "../../entities.js"
import { ActivityModule } from "../activities/activity.module.js"
import { ProjectActivityEventEntity } from "../activities/activity-event.entity.js"
import { StudentProjectEntity, StudentProjectStageEntity } from "../assignments/assignment.entities.js"
import { ShowProjectDocumentEntity } from "../documents/show-document.entities.js"
import { FileAssetModule } from "../files/file-asset.module.js"
import { FileAssetEntity } from "../files/file-asset.entity.js"
import { ProjectEvaluationEntity, RuntimeAlertEntity, RuntimeEventEntity, RuntimeSessionEntity, StudentRuntimeActionEntity } from "../runtime/runtime.entities.js"
import { ShowPreflightRecordEntity, ShowSimulationClockEntity } from "../show-readiness/show-readiness.entities.js"
import { ShowAreaPlanVersionEntity } from "../show-project/show-project.entities.js"
import { ShowOperationalReportEntity, ShowRuntimeGroupSnapshotEntity } from "../show-runtime/show-runtime.entities.js"
import { ShowReviewController } from "./show-review.controller.js"
import { ShowProjectReportEntity, ShowReviewAnnotationEntity } from "./show-review.entities.js"
import { ShowReviewService } from "./show-review.service.js"
import { ResourcePackageModule } from "../resources/resource-package.module.js"
import { JobInfrastructureModule } from "../jobs/job-infrastructure.module.js"
import { AssessmentWindowModule } from "../assessment/assessment-window.module.js"

@Module({
  imports: [
    AuthModule,
    ActivityModule,
    FileAssetModule,
    ResourcePackageModule,
    JobInfrastructureModule,
    AssessmentWindowModule,
    TypeOrmModule.forFeature([
      UserEntity,
      StudentProjectEntity,
      StudentProjectStageEntity,
      ProjectEvaluationEntity,
      RuntimeSessionEntity,
      RuntimeEventEntity,
      RuntimeAlertEntity,
      StudentRuntimeActionEntity,
      ShowRuntimeGroupSnapshotEntity,
      ShowOperationalReportEntity,
      ProjectActivityEventEntity,
      ShowAreaPlanVersionEntity,
      ShowProjectDocumentEntity,
      ShowPreflightRecordEntity,
      ShowSimulationClockEntity,
      ShowReviewAnnotationEntity,
      ShowProjectReportEntity,
      FileAssetEntity
    ])
  ],
  controllers: [ShowReviewController],
  providers: [ShowReviewService],
  exports: [ShowReviewService]
})
export class ShowReviewModule {}
