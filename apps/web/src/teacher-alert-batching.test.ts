import { describe, expect, it } from "vitest"
import { processTeacherAlertBatches, splitTeacherAlertIdsIntoBatches } from "./teacher-alert-batching"

describe("teacher alert batching", () => {
  it.each([
    [0, []],
    [1, [1]],
    [100, [100]],
    [101, [100, 1]],
    [201, [100, 100, 1]]
  ])("splits %i alert IDs into batches", (count, expectedSizes) => {
    const ids = Array.from({ length: count }, (_, index) => `alert-${index}`)
    expect(splitTeacherAlertIdsIntoBatches(ids).map((batch) => batch.length)).toEqual(expectedSizes)
    expect(splitTeacherAlertIdsIntoBatches(ids).flat()).toEqual(ids)
  })

  it("rejects an invalid batch size", () => {
    expect(() => splitTeacherAlertIdsIntoBatches([], 0)).toThrow("告警批次大小必须是正整数")
    expect(() => splitTeacherAlertIdsIntoBatches([], 1.5)).toThrow("告警批次大小必须是正整数")
  })

  it("processes every batch and reports progress", async () => {
    const progress: Array<[number, number, number]> = []
    const results = await processTeacherAlertBatches(["a", "b", "c"], async (batch) => batch.join(","), (batchIndex, batchCount, batchSize) => {
      progress.push([batchIndex, batchCount, batchSize])
    }, 2)
    expect(results).toEqual(["a,b", "c"])
    expect(progress).toEqual([[1, 2, 2], [2, 2, 1]])
  })

  it("keeps unprocessed IDs when a later batch fails", async () => {
    const sent: string[][] = []
    await expect(processTeacherAlertBatches(["a", "b", "c"], async (batch) => {
      sent.push(batch)
      if (batch[0] === "c") throw new Error("temporary failure")
      return batch
    }, undefined, 2)).rejects.toMatchObject({
      processedCount: 2,
      remainingIds: ["c"]
    })
    expect(sent).toEqual([["a", "b"], ["c"]])
  })
})
