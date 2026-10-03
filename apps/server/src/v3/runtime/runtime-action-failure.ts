import { randomUUID } from "node:crypto"
import type { Repository } from "typeorm"
import { runtimeErrorFromMessage } from "./runtime-adapters.js"
import { RuntimeSessionEntity, StudentRuntimeActionEntity } from "./runtime.entities.js"

export interface RejectedRuntimeActionInput {
  projectId: string
  actorId: string
  actionCode: unknown
  requestId: unknown
  targetId?: unknown
  error: unknown
}

/** Persist a rejected request after its business transaction has rolled back. */
export async function persistRejectedRuntimeAction(
  actions: Repository<StudentRuntimeActionEntity>,
  sessions: Repository<RuntimeSessionEntity>,
  input: RejectedRuntimeActionInput
): Promise<void> {
  const session = await sessions.findOne({ where: { projectId: input.projectId }, order: { createdAt: "DESC" } })
  if (!session) return
  const message = input.error instanceof Error ? input.error.message : String(input.error)
  const runtimeError = runtimeErrorFromMessage(message, { sessionId: session.id })
  const actionCode = text(input.actionCode) ?? "UNKNOWN"
  const requestId = text(input.requestId)
  const targetId = text(input.targetId)
  await actions.save(actions.create({
    projectId: input.projectId,
    sessionId: session.id,
    eventId: null,
    alertId: null,
    actorId: input.actorId,
    actionCode,
    targetType: "UNKNOWN",
    targetId,
    status: "REJECTED",
    simulationTimeMs: Number(session.simulationTimeMs),
    payload: { rejected: true, ...(requestId ? { _requestId: requestId } : {}) },
    result: { applied: false, errorCode: runtimeError.code, message },
    correlationId: randomUUID(),
    requestedAt: new Date(),
    appliedAt: null
  }))
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  return normalized ? normalized.slice(0, 120) : null
}
