import type { EntityManager } from "typeorm"
import { ProjectEvaluationEntity } from "./runtime.entities.js"

/**
 * A new runtime attempt invalidates objective metrics from an unpublished
 * evaluation. Metrics are produced by reviewing a completed run, so keeping
 * them across attempts would allow the question-bank score to refer to a
 * previous route. The caller must invoke this inside the same transaction
 * that creates the RuntimeSession.
 */
export async function clearUnpublishedObjectiveMetrics(manager: EntityManager, projectId: string): Promise<boolean> {
  const evaluation = await manager.findOne(ProjectEvaluationEntity, {
    where: { projectId },
    lock: { mode: "pessimistic_write" }
  })
  if (!evaluation || evaluation.status === "PUBLISHED") return false
  if (!Array.isArray(evaluation.objectiveMetrics) || evaluation.objectiveMetrics.length === 0) return false

  evaluation.objectiveMetrics = []
  await manager.save(evaluation)
  return true
}
