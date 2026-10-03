import { Module } from "@nestjs/common"
import { TypeOrmModule } from "@nestjs/typeorm"
import { AuthModule } from "../../auth/auth.module.js"
import { UserEntity } from "../../entities.js"
import { ActivityModule } from "../activities/activity.module.js"
import { AssessmentWindowModule } from "../assessment/assessment-window.module.js"
import { StudentProjectEntity, StudentProjectStageEntity } from "../assignments/assignment.entities.js"
import { ShowProjectDocumentEntity } from "../documents/show-document.entities.js"
import { ShowAreaFeatureEntity, ShowAreaPlanVersionEntity } from "../show-project/show-project.entities.js"
import { ShowReadinessController } from "./show-readiness.controller.js"
import { ShowPreflightRecordEntity, ShowSimulationClockEntity } from "./show-readiness.entities.js"
import { ShowReadinessService } from "./show-readiness.service.js"

@Module({
  imports: [
    AuthModule,
    ActivityModule,
    AssessmentWindowModule,
    TypeOrmModule.forFeature([
      UserEntity,
      StudentProjectEntity,
      StudentProjectStageEntity,
      ShowProjectDocumentEntity,
      ShowAreaPlanVersionEntity,
      ShowAreaFeatureEntity,
      ShowPreflightRecordEntity,
      ShowSimulationClockEntity
    ])
  ],
  controllers: [ShowReadinessController],
  providers: [ShowReadinessService]
})
export class ShowReadinessModule {}
