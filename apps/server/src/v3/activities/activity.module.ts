import { Module } from "@nestjs/common"
import { TypeOrmModule } from "@nestjs/typeorm"
import { ProjectActivityEventEntity } from "./activity-event.entity.js"
import { ActivityLogService } from "./activity-log.service.js"

@Module({
  imports: [TypeOrmModule.forFeature([ProjectActivityEventEntity])],
  providers: [ActivityLogService],
  exports: [ActivityLogService]
})
export class ActivityModule {}
