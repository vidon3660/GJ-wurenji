import type { ShowT60ConfirmationView, ShowT60SubmissionView } from "@wurenji/shared"

export interface ShowT60StoredSubmissionSnapshot {
  snapshotVersion: 1
  submission: ShowT60SubmissionView & {
    reportCode: string
    submittedBy: NonNullable<ShowT60SubmissionView["submittedBy"]>
    simulationTimeMs: number
  }
  confirmation: ShowT60ConfirmationView
}

export function createShowT60SubmissionSnapshot(input: {
  reportCode: string
  submittedAt: string
  submittedBy: NonNullable<ShowT60SubmissionView["submittedBy"]>
  simulationTimeMs: number
  confirmation: ShowT60ConfirmationView
}): ShowT60StoredSubmissionSnapshot {
  return {
    snapshotVersion: 1,
    submission: {
      reportCode: input.reportCode,
      submittedAt: input.submittedAt,
      submittedBy: { ...input.submittedBy },
      simulationTimeMs: input.simulationTimeMs
    },
    confirmation: structuredClone(input.confirmation)
  }
}

export function parseShowT60SubmissionSnapshot(value: unknown): ShowT60StoredSubmissionSnapshot | null {
  const record = asRecord(value)
  if (!record || record.snapshotVersion !== 1) return null
  const submission = asRecord(record.submission)
  const submittedBy = asRecord(submission?.submittedBy)
  if (
    !submission
    || typeof submission.reportCode !== "string"
    || typeof submission.submittedAt !== "string"
    || !submittedBy
    || typeof submittedBy.id !== "string"
    || typeof submittedBy.displayName !== "string"
    || !Number.isFinite(submission.simulationTimeMs)
    || Number(submission.simulationTimeMs) < 0
    || !isShowT60Confirmation(record.confirmation)
  ) return null
  return {
    snapshotVersion: 1,
    submission: {
      reportCode: submission.reportCode,
      submittedAt: submission.submittedAt,
      submittedBy: { id: submittedBy.id, displayName: submittedBy.displayName },
      simulationTimeMs: Number(submission.simulationTimeMs)
    },
    confirmation: structuredClone(record.confirmation)
  }
}

export function parseLegacyShowT60Confirmation(value: unknown): ShowT60ConfirmationView | null {
  return isShowT60Confirmation(value) ? structuredClone(value) : null
}

function isShowT60Confirmation(value: unknown): value is ShowT60ConfirmationView {
  const record = asRecord(value)
  return Boolean(
    record
    && typeof record.projectName === "string"
    && typeof record.plannedStartAt === "string"
    && typeof record.plannedEndAt === "string"
    && (record.takeoffPoint === null || isCoordinate(record.takeoffPoint))
    && Array.isArray(record.airspaceBoundary)
    && record.airspaceBoundary.every(isCoordinate)
    && (record.maximumHeightMeters === null || Number.isFinite(record.maximumHeightMeters))
    && typeof record.aircraftModel === "string"
    && Number.isFinite(record.aircraftCount)
    && typeof record.contactName === "string"
    && typeof record.contactPhone === "string"
    && asRecord(record.environment)
  )
}

function isCoordinate(value: unknown): boolean {
  const record = asRecord(value)
  return Boolean(record && Number.isFinite(record.longitude) && Number.isFinite(record.latitude))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}
