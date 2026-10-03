import { Module } from "@nestjs/common"
import { TypeOrmModule } from "@nestjs/typeorm"
import { FileAssetEntity } from "./file-asset.entity.js"
import { V3FileStorageService } from "./file-storage.service.js"

@Module({
  imports: [TypeOrmModule.forFeature([FileAssetEntity])],
  providers: [V3FileStorageService],
  exports: [TypeOrmModule, V3FileStorageService]
})
export class FileAssetModule {}
