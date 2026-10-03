import { afterEach, describe, expect, it } from "vitest"
import { calculateRetryDelayMs } from "./job-queue.service.js"

describe("job retry policy", () => {
  const previousBaseDelay = process.env.JOB_RETRY_BASE_DELAY_MS
  const previousMaximumDelay = process.env.JOB_RETRY_MAX_DELAY_MS

  afterEach(() => {
    restoreEnvironment("JOB_RETRY_BASE_DELAY_MS", previousBaseDelay)
    restoreEnvironment("JOB_RETRY_MAX_DELAY_MS", previousMaximumDelay)
  })

  it("uses bounded exponential backoff", () => {
    process.env.JOB_RETRY_BASE_DELAY_MS = "100"
    process.env.JOB_RETRY_MAX_DELAY_MS = "500"

    expect([1, 2, 3, 4, 5].map(calculateRetryDelayMs)).toEqual([100, 200, 400, 500, 500])
  })
})

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
