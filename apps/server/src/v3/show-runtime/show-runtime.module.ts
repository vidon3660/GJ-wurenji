import { Module } from "@nestjs/common"
import { TypeOrmModule } from "@nestjs/typeorm"
import { AuthModule } from "../../auth/auth.module.js"
import { UserEntity } from "../../entities.js"
import { ActivityModule } from "../activities/activity.module.js"
import {
  AssignmentDraftEntity,
  ProjectActivityCounterEntity,
  StudentProjectEntity,
  StudentProjectStageEntity
} from "../assignments/assignment.entities.js"
import {
  RuntimeAlertEntity,
  RuntimeEventEntity,
  RuntimeSessionEntity,
  StudentRuntimeActionEntity
} from "../runtime/runtime.entities.js"
import { ShowPreflightRecordEntity, ShowSimulationClockEntity } from "../show-readiness/show-readiness.entities.js"
import { ShowAreaFeatureEntity, ShowAreaPlanVersionEntity } from "../show-project/show-project.entities.js"
import { ResourcePackageEntity } from "../resources/resource-package.entity.js"
import { ShowRuntimeController } from "./show-runtime.controller.js"
import { ShowOperationalReportEntity, ShowRuntimeGroupSnapshotEntity } from "./show-runtime.entities.js"
import { ShowRuntimeService } from "./show-runtime.service.js"
import { AssessmentWindowModule } from "../assessment/assessment-window.module.js"

@Module({
  imports: [
    AuthModule,
    AssessmentWindowModule,
    ActivityModule,
    TypeOrmModule.forFeature([
      UserEntity,
      AssignmentDraftEntity,
      StudentProjectEntity,
      StudentProjectStageEntity,
      ProjectActivityCounterEntity,
      RuntimeSessionEntity,
      RuntimeEventEntity,
      RuntimeAlertEntity,
      StudentRuntimeActionEntity,
      ShowPreflightRecordEntity,
      ShowSimulationClockEntity,
      ShowAreaPlanVersionEntity,
      ShowAreaFeatureEntity,
      ResourcePackageEntity,
      ShowRuntimeGroupSnapshotEntity,
      ShowOperationalReportEntity
    ])
  ],
  controllers: [ShowRuntimeController],
  providers: [ShowRuntimeService]
})
export class ShowRuntimeModule {}
