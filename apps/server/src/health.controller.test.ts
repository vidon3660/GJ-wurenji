import { afterEach, describe, expect, it, vi } from "vitest"
import { HealthController } from "./health.controller.js"

describe("HealthController", () => {
  afterEach(() => {
    delete process.env.PLATFORM_VERSION
  })

  it("reports the deployed platform version", async () => {
    process.env.PLATFORM_VERSION = "1.2.3"
    const dataSource = { isInitialized: true, query: vi.fn().mockResolvedValue([{ ok: 1 }]) }
    const controller = new HealthController(dataSource as never)

    expect(controller.health()).toEqual({ status: "ok", service: "wurenji-app", version: "1.2.3" })
    await expect(controller.readiness()).resolves.toEqual({ status: "ready", database: "ok", version: "1.2.3" })
  })
})
