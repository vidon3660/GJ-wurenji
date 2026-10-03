import { Module } from "@nestjs/common"
import { TypeOrmModule } from "@nestjs/typeorm"
import { JobEntity, OutboxEventEntity } from "./job.entities.js"
import { JobQueueService } from "./job-queue.service.js"
import { JobWorkerService } from "./job-worker.service.js"
import { TransactionalOutboxService } from "./transactional-outbox.service.js"

@Module({
  imports: [TypeOrmModule.forFeature([JobEntity, OutboxEventEntity])],
  providers: [JobQueueService, JobWorkerService, TransactionalOutboxService],
  exports: [TypeOrmModule, JobQueueService, JobWorkerService, TransactionalOutboxService]
})
export class JobInfrastructureModule {}
