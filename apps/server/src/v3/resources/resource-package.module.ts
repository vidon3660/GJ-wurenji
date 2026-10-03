import { Module } from "@nestjs/common"
import { TypeOrmModule } from "@nestjs/typeorm"
import { AuthModule } from "../../auth/auth.module.js"
import { UserEntity } from "../../entities.js"
import { ResourcePackageController } from "./resource-package.controller.js"
import { FileAssetModule } from "../files/file-asset.module.js"
import { ResourceArchiveValidator } from "./resource-archive.validator.js"
import { ResourcePackageEntity, ResourcePackageLifecycleEventEntity, ResourcePackageValidationRunEntity } from "./resource-package.entity.js"
import { ResourcePackageService } from "./resource-package.service.js"
import { ScenarioOverlayController } from "./scenario-overlay.controller.js"
import { ScenarioOverlayEntity, ScenarioOverlayVersionEntity } from "./scenario-overlay.entity.js"
import { ScenarioOverlayService } from "./scenario-overlay.service.js"

@Module({
  imports: [AuthModule, FileAssetModule, TypeOrmModule.forFeature([
    ResourcePackageEntity,
    ResourcePackageValidationRunEntity,
    ResourcePackageLifecycleEventEntity,
    UserEntity,
    ScenarioOverlayEntity,
    ScenarioOverlayVersionEntity
  ])],
  controllers: [ResourcePackageController, ScenarioOverlayController],
  providers: [ResourceArchiveValidator, ResourcePackageService, ScenarioOverlayService],
  exports: [ResourcePackageService, ScenarioOverlayService]
})
export class ResourcePackageModule {}
