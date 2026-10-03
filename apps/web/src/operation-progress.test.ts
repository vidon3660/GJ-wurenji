import { describe, expect, it } from "vitest"
import {
  advanceV3OperationProgress,
  completeV3OperationProgress,
  failV3OperationProgress,
  startV3OperationProgress,
  v3OperationStatusLabel,
  v3OperationStepState
} from "./operation-progress"

describe("V3 operation progress", () => {
  const steps = ["保存条件", "提交计算", "汇总结果"]

  it("tracks real client-visible phases without inventing server percentages", () => {
    const started = startV3OperationProgress("批量处理", steps)
    const submitted = advanceV3OperationProgress(started, 1)

    expect(started).toMatchObject({ activeStep: 0, status: "RUNNING", detail: "保存条件" })
    expect(submitted).toMatchObject({ activeStep: 1, status: "RUNNING", detail: "提交计算" })
    expect(v3OperationStatusLabel(submitted)).toBe("第 2/3 步")
    expect(steps.map((_, index) => v3OperationStepState(submitted, index))).toEqual(["COMPLETE", "ACTIVE", "PENDING"])
  })

  it("never moves backwards or beyond the declared phases", () => {
    const submitted = advanceV3OperationProgress(startV3OperationProgress("批量处理", steps), 1)

    expect(advanceV3OperationProgress(submitted, 0).activeStep).toBe(1)
    expect(advanceV3OperationProgress(submitted, 99).activeStep).toBe(2)
  })

  it("retains a concise result for successful and failed operations", () => {
    const started = startV3OperationProgress("批量处理", steps)
    const completed = completeV3OperationProgress(started, "已处理 20 条")
    const failed = failV3OperationProgress(advanceV3OperationProgress(started, 1), "服务暂不可用")

    expect(completed).toMatchObject({ activeStep: 2, status: "SUCCEEDED", result: "已处理 20 条" })
    expect(v3OperationStatusLabel(completed)).toBe("处理完成")
    expect(steps.map((_, index) => v3OperationStepState(completed, index))).toEqual(["COMPLETE", "COMPLETE", "COMPLETE"])
    expect(failed).toMatchObject({ activeStep: 1, status: "FAILED", result: "服务暂不可用" })
    expect(v3OperationStepState(failed, 1)).toBe("FAILED")
  })

  it("rejects an operation without observable phases", () => {
    expect(() => startV3OperationProgress("空操作", [])).toThrow("at least one step")
  })
})
