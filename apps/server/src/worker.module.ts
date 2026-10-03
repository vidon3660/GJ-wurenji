import { Module } from "@nestjs/common"
import { TypeOrmModule } from "@nestjs/typeorm"
import { entities } from "./entities.js"
import { educationEntities } from "./education/education.entities.js"
import { questionBankEntities } from "./education/question-bank.entities.js"
import { logisticsEntities } from "./logistics/logistics.entities.js"
import { v3ActivityEntities } from "./v3/activities/activity-event.entity.js"
import { v3AssignmentEntities } from "./v3/assignments/assignment.entities.js"
import { v3DocumentEntities } from "./v3/documents/show-document.entities.js"
import { v3FileEntities } from "./v3/files/file-asset.entity.js"
import { JobInfrastructureModule } from "./v3/jobs/job-infrastructure.module.js"
import { v3JobEntities } from "./v3/jobs/job.entities.js"
import { ShowReportJobHandler } from "./v3/jobs/show-report-job.handler.js"
import { VtlReportJobHandler } from "./v3/jobs/vtl-report-job.handler.js"
import { v3LogisticsRouteEntities } from "./v3/logistics-route/logistics-route.entities.js"
import { v3LogisticsRuntimeEntities } from "./v3/logistics-runtime/logistics-runtime.entities.js"
import { v3LogisticsSchedulingEntities } from "./v3/logistics-scheduling/logistics-scheduling.entities.js"
import { v3ResourceEntities } from "./v3/resources/resource-package.entity.js"
import { scenarioOverlayEntities } from "./v3/resources/scenario-overlay.entity.js"
import { v3RuntimeEntities } from "./v3/runtime/runtime.entities.js"
import { v3ShowProjectEntities } from "./v3/show-project/show-project.entities.js"
import { v3ShowReadinessEntities } from "./v3/show-readiness/show-readiness.entities.js"
import { ShowReviewModule } from "./v3/show-review/show-review.module.js"
import { VtlReviewModule } from "./v3/vtl-review/vtl-review.module.js"
import { v3ShowReviewEntities } from "./v3/show-review/show-review.entities.js"
import { v3ShowRuntimeEntities } from "./v3/show-runtime/show-runtime.entities.js"
import { v3VtlInspectionEntities } from "./v3/vtl-inspection/vtl-inspection.entities.js"
import { v3VtlRuntimeEntities } from "./v3/vtl-runtime/vtl-runtime.entities.js"

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: "postgres",
      url: process.env.DATABASE_URL ?? "postgresql://wurenji@localhost:55432/wurenji",
      entities: [...entities, ...educationEntities, ...questionBankEntities, ...logisticsEntities, ...v3ResourceEntities, ...scenarioOverlayEntities, ...v3ActivityEntities, ...v3AssignmentEntities, ...v3ShowProjectEntities, ...v3RuntimeEntities, ...v3FileEntities, ...v3JobEntities, ...v3DocumentEntities, ...v3ShowReadinessEntities, ...v3ShowRuntimeEntities, ...v3ShowReviewEntities, ...v3LogisticsRouteEntities, ...v3LogisticsSchedulingEntities, ...v3LogisticsRuntimeEntities, ...v3VtlInspectionEntities, ...v3VtlRuntimeEntities],
      synchronize: false,
      logging: process.env.TYPEORM_LOGGING === "true"
    }),
    JobInfrastructureModule,
    ShowReviewModule,
    VtlReviewModule
  ],
  providers: [ShowReportJobHandler, VtlReportJobHandler]
})
export class WorkerModule {}
