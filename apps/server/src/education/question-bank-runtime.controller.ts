import { Body, Controller, Get, Param, Post, Put, UseGuards } from "@nestjs/common"
import type { AuthUser, QuestionAttemptRegradeInput, QuestionAttemptReviewInput, QuestionAttemptSaveInput } from "@wurenji/shared"
import { AuthGuard } from "../auth/auth.guard.js"
import { CurrentUser } from "../auth/current-user.js"
import { QuestionBankService } from "./question-bank.service.js"

@Controller("v3/projects")
@UseGuards(AuthGuard)
export class QuestionBankRuntimeController {
  constructor(private readonly questionBanks: QuestionBankService) {}

  @Get(":projectId/questionnaire")
  questionnaire(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser) {
    return this.questionBanks.questionnaire(projectId, user)
  }

  @Put(":projectId/questionnaire")
  save(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser, @Body() body: QuestionAttemptSaveInput) {
    return this.questionBanks.saveQuestionnaire(projectId, user, body, false)
  }

  @Post(":projectId/questionnaire/submit")
  submit(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser, @Body() body: QuestionAttemptSaveInput) {
    return this.questionBanks.saveQuestionnaire(projectId, user, body, true)
  }

  @Post(":projectId/questionnaire/regrade")
  regrade(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser, @Body() body: QuestionAttemptRegradeInput) {
    return this.questionBanks.regradeQuestionnaire(projectId, user, body)
  }

  @Put(":projectId/questionnaire/review")
  review(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser, @Body() body: QuestionAttemptReviewInput) {
    return this.questionBanks.reviewQuestionnaire(projectId, user, body)
  }
}
