import { Module } from "@nestjs/common"
import { TypeOrmModule } from "@nestjs/typeorm"
import { AuthModule } from "../../auth/auth.module.js"
import { UserEntity } from "../../entities.js"
import {
  ClassMemberEntity,
  ClassroomEntity,
  ExerciseVersionEntity
} from "../../education/education.entities.js"
import { ResourcePackageModule } from "../resources/resource-package.module.js"
import { ActivityModule } from "../activities/activity.module.js"
import { ProjectEvaluationEntity, RuntimeAlertEntity } from "../runtime/runtime.entities.js"
import { RuntimeSessionEntity } from "../runtime/runtime.entities.js"
import { ShowProjectDocumentEntity } from "../documents/show-document.entities.js"
import { ShowSimulationClockEntity } from "../show-readiness/show-readiness.entities.js"
import { ShowOperationalReportEntity } from "../show-runtime/show-runtime.entities.js"
import {
  LogisticsRoutePlanDraftEntity,
  LogisticsRoutePlanVersionEntity,
  LogisticsRouteValidationRunEntity
} from "../logistics-route/logistics-route.entities.js"
import {
  LogisticsScheduleDraftEntity,
  LogisticsScheduleVersionEntity
} from "../logistics-scheduling/logistics-scheduling.entities.js"
import {
  AssignmentDraftEntity,
  AssignmentSnapshotEntity,
  AssignmentSnapshotResourceRevisionEntity,
  AssignmentTargetEntity,
  ProjectActivityCounterEntity,
  StudentProjectEntity,
  StudentProjectStageEntity
} from "./assignment.entities.js"
import { V3AssignmentController } from "./assignment.controller.js"
import { V3AssignmentService } from "./assignment.service.js"
import { AssessmentWindowModule } from "../assessment/assessment-window.module.js"
import { QuestionBankVersionEntity } from "../../education/question-bank.entities.js"
import { TeacherAlertFollowUpEntity } from "./teacher-alert-follow-up.entity.js"

@Module({
  imports: [
    AuthModule,
    ActivityModule,
    AssessmentWindowModule,
    ResourcePackageModule,
    TypeOrmModule.forFeature([
      UserEntity,
      ExerciseVersionEntity,
      ClassroomEntity,
      ClassMemberEntity,
      AssignmentDraftEntity,
      AssignmentSnapshotEntity,
      AssignmentSnapshotResourceRevisionEntity,
      AssignmentTargetEntity,
      StudentProjectEntity,
      StudentProjectStageEntity,
      ProjectActivityCounterEntity,
      RuntimeAlertEntity,
      RuntimeSessionEntity,
      ProjectEvaluationEntity,
      ShowProjectDocumentEntity,
      ShowSimulationClockEntity,
      ShowOperationalReportEntity,
      LogisticsRoutePlanDraftEntity,
      LogisticsRoutePlanVersionEntity,
      LogisticsRouteValidationRunEntity,
      LogisticsScheduleDraftEntity,
      LogisticsScheduleVersionEntity,
      QuestionBankVersionEntity,
      TeacherAlertFollowUpEntity
    ])
  ],
  controllers: [V3AssignmentController],
  providers: [V3AssignmentService],
  exports: [V3AssignmentService]
})
export class V3AssignmentModule {}
