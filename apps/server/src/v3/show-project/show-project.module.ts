import { Module } from "@nestjs/common"
import { TypeOrmModule } from "@nestjs/typeorm"
import { AuthModule } from "../../auth/auth.module.js"
import { UserEntity } from "../../entities.js"
import { V3AssignmentModule } from "../assignments/assignment.module.js"
import { ActivityModule } from "../activities/activity.module.js"
import {
  ProjectActivityCounterEntity,
  StudentProjectEntity,
  StudentProjectStageEntity
} from "../assignments/assignment.entities.js"
import { ResourcePackageModule } from "../resources/resource-package.module.js"
import { FileAssetModule } from "../files/file-asset.module.js"
import { ShowProjectDocumentVersionEntity } from "../documents/show-document.entities.js"
import { PlanningMapRenderer } from "./planning-map.renderer.js"
import { V3ShowProjectController } from "./show-project.controller.js"
import {
  ShowAreaFeatureEntity,
  ShowAreaPlanDraftEntity,
  ShowAreaPlanVersionEntity
} from "./show-project.entities.js"
import { V3ShowProjectService } from "./show-project.service.js"
import { AssessmentWindowModule } from "../assessment/assessment-window.module.js"

@Module({
  imports: [
    AuthModule,
    ActivityModule,
    FileAssetModule,
    ResourcePackageModule,
    V3AssignmentModule,
    AssessmentWindowModule,
    TypeOrmModule.forFeature([
      UserEntity,
      StudentProjectEntity,
      StudentProjectStageEntity,
      ProjectActivityCounterEntity,
      ShowAreaPlanDraftEntity,
      ShowAreaPlanVersionEntity,
      ShowAreaFeatureEntity,
      ShowProjectDocumentVersionEntity
    ])
  ],
  controllers: [V3ShowProjectController],
  providers: [V3ShowProjectService, PlanningMapRenderer]
})
export class V3ShowProjectModule {}
