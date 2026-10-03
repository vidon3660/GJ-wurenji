import { Module } from "@nestjs/common"
import { TypeOrmModule } from "@nestjs/typeorm"
import { StudentProjectEntity } from "../assignments/assignment.entities.js"
import { AssessmentWindowGuard } from "./assessment-window.guard.js"
import { AssessmentWindowService } from "./assessment-window.service.js"

@Module({
  imports: [TypeOrmModule.forFeature([StudentProjectEntity])],
  providers: [AssessmentWindowService, AssessmentWindowGuard],
  exports: [AssessmentWindowService, AssessmentWindowGuard]
})
export class AssessmentWindowModule {}
