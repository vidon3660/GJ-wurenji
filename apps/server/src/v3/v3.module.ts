import { Module } from "@nestjs/common"
import { V3AssignmentModule } from "./assignments/assignment.module.js"
import { ResourcePackageModule } from "./resources/resource-package.module.js"
import { V3ShowProjectModule } from "./show-project/show-project.module.js"
import { ActivityModule } from "./activities/activity.module.js"
import { RuntimeModule } from "./runtime/runtime.module.js"
import { JobInfrastructureModule } from "./jobs/job-infrastructure.module.js"
import { ShowDocumentModule } from "./documents/show-document.module.js"
import { ShowReadinessModule } from "./show-readiness/show-readiness.module.js"
import { ShowRuntimeModule } from "./show-runtime/show-runtime.module.js"
import { ShowReviewModule } from "./show-review/show-review.module.js"
import { LogisticsRouteModule } from "./logistics-route/logistics-route.module.js"
import { LogisticsSchedulingModule } from "./logistics-scheduling/logistics-scheduling.module.js"
import { LogisticsRuntimeModule } from "./logistics-runtime/logistics-runtime.module.js"
import { LogisticsReviewModule } from "./logistics-review/logistics-review.module.js"
import { VtlInspectionModule } from "./vtl-inspection/vtl-inspection.module.js"
import { VtlRuntimeModule } from "./vtl-runtime/vtl-runtime.module.js"
import { VtlReviewModule } from "./vtl-review/vtl-review.module.js"

@Module({
  imports: [ActivityModule, ResourcePackageModule, V3AssignmentModule, V3ShowProjectModule, ShowDocumentModule, ShowReadinessModule, ShowRuntimeModule, ShowReviewModule, LogisticsRouteModule, LogisticsSchedulingModule, LogisticsRuntimeModule, LogisticsReviewModule, VtlInspectionModule, VtlRuntimeModule, VtlReviewModule, RuntimeModule, JobInfrastructureModule]
})
export class V3Module {}
