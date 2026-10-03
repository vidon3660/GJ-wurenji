import { Module } from "@nestjs/common"
import { TypeOrmModule } from "@nestjs/typeorm"
import { PracticeEntity, SolutionEntity, SubmissionEntity, UserEntity } from "../entities.js"
import { AuthModule } from "../auth/auth.module.js"
import { educationEntities } from "./education.entities.js"
import { EducationController } from "./education.controller.js"
import { EducationService } from "./education.service.js"
import { GradeEntity } from "../logistics/logistics.entities.js"
import { questionBankEntities } from "./question-bank.entities.js"
import { QuestionBankService } from "./question-bank.service.js"
import { QuestionBankRuntimeController } from "./question-bank-runtime.controller.js"
import { ActivityModule } from "../v3/activities/activity.module.js"
import { AssessmentWindowModule } from "../v3/assessment/assessment-window.module.js"
import { AssignmentSnapshotEntity, StudentProjectEntity } from "../v3/assignments/assignment.entities.js"
import { ProjectEvaluationEntity } from "../v3/runtime/runtime.entities.js"

@Module({
  imports: [AuthModule, ActivityModule, AssessmentWindowModule, TypeOrmModule.forFeature([UserEntity, PracticeEntity, SolutionEntity, SubmissionEntity, GradeEntity, StudentProjectEntity, AssignmentSnapshotEntity, ProjectEvaluationEntity, ...educationEntities, ...questionBankEntities])],
  controllers: [EducationController, QuestionBankRuntimeController],
  providers: [EducationService, QuestionBankService],
  exports: [EducationService, QuestionBankService]
})
export class EducationModule {}
