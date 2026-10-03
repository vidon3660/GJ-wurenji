import { Module } from "@nestjs/common"
import { TypeOrmModule } from "@nestjs/typeorm"
import { AuthModule } from "../../auth/auth.module.js"
import { UserEntity } from "../../entities.js"
import { ActivityModule } from "../activities/activity.module.js"
import { AssessmentWindowModule } from "../assessment/assessment-window.module.js"
import { ProjectActivityCounterEntity, StudentProjectEntity, StudentProjectStageEntity } from "../assignments/assignment.entities.js"
import { FileAssetModule } from "../files/file-asset.module.js"
import { FileAssetEntity } from "../files/file-asset.entity.js"
import { ResourcePackageModule } from "../resources/resource-package.module.js"
import { ShowAreaFeatureEntity, ShowAreaPlanVersionEntity } from "../show-project/show-project.entities.js"
import { OnlyOfficeCallbackController, ShowDocumentController } from "./show-document.controller.js"
import {
  ShowProjectDocumentEntity,
  ShowProjectDocumentReviewEntity,
  ShowProjectDocumentSessionEntity,
  ShowProjectDocumentVersionEntity
} from "./show-document.entities.js"
import { ShowDocumentService } from "./show-document.service.js"

@Module({
  imports: [
    AuthModule,
    ActivityModule,
    AssessmentWindowModule,
    FileAssetModule,
    ResourcePackageModule,
    TypeOrmModule.forFeature([
      UserEntity,
      StudentProjectEntity,
      StudentProjectStageEntity,
      ProjectActivityCounterEntity,
      FileAssetEntity,
      ShowAreaPlanVersionEntity,
      ShowAreaFeatureEntity,
      ShowProjectDocumentEntity,
      ShowProjectDocumentVersionEntity,
      ShowProjectDocumentReviewEntity,
      ShowProjectDocumentSessionEntity
    ])
  ],
  controllers: [ShowDocumentController, OnlyOfficeCallbackController],
  providers: [ShowDocumentService],
  exports: [ShowDocumentService]
})
export class ShowDocumentModule {}
