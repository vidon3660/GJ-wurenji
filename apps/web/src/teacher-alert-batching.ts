export function splitTeacherAlertIdsIntoBatches(alertIds: readonly string[], batchSize = 100): string[][] {
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error("告警批次大小必须是正整数")
  const batches: string[][] = []
  for (let index = 0; index < alertIds.length; index += batchSize) batches.push([...alertIds.slice(index, index + batchSize)])
  return batches
}

export class TeacherAlertBatchError extends Error {
  constructor(
    message: string,
    readonly processedCount: number,
    readonly remainingIds: string[],
    readonly cause?: unknown
  ) {
    super(message)
    this.name = "TeacherAlertBatchError"
  }
}

export async function processTeacherAlertBatches<T>(
  alertIds: readonly string[],
  sendBatch: (batch: string[]) => Promise<T>,
  onProgress?: (batchIndex: number, batchCount: number, batchSize: number) => void,
  batchSize = 100
): Promise<T[]> {
  const batches = splitTeacherAlertIdsIntoBatches(alertIds, batchSize)
  const results: T[] = []
  for (const [index, batch] of batches.entries()) {
    onProgress?.(index + 1, batches.length, batch.length)
    try {
      results.push(await sendBatch(batch))
    } catch (error) {
      throw new TeacherAlertBatchError(`第 ${index + 1}/${batches.length} 批告警处理失败`, index * batchSize, alertIds.slice(index * batchSize), error)
    }
  }
  return results
}
