import { describe, expect, it, vi } from "vitest"
import { ConflictException } from "@nestjs/common"
import { ScenarioOverlayService } from "./scenario-overlay.service.js"

const teacher = { id: "teacher-1", role: "teacher", displayName: "教师" } as const

function serviceWith(version: Record<string, unknown>) {
  const current = {
    id: "version-1",
    revision: 4,
    status: "DRAFT",
    sceneType: "CITY_LOGISTICS",
    regionPackageId: "region-1",
    title: "覆盖层",
    objects: [],
    overlay: { id: "overlay-1", createdBy: { id: teacher.id, displayName: teacher.displayName } },
    createdBy: { id: teacher.id, displayName: teacher.displayName },
    ...version
  }
  const manager = { findOne: vi.fn().mockResolvedValue(current), save: vi.fn(), transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(manager)) }
  const versions = { manager } as never
  const overlays = {} as never
  const resources = { findRegion: vi.fn().mockResolvedValue({ sceneType: "CITY_LOGISTICS", boundary: [], layers: [] }) } as never
  return { service: new ScenarioOverlayService(overlays, versions, resources), manager }
}

describe("scenario overlay lifecycle concurrency", () => {
  it("rejects a stale draft update with ConflictException", async () => {
    const { service, manager } = serviceWith({ revision: 4 })
    await expect(service.update("version-1", teacher, { expectedRevision: 3, objects: [] })).rejects.toBeInstanceOf(ConflictException)
    expect(manager.save).not.toHaveBeenCalled()
  })

  it("rejects mutation of a published version", async () => {
    const { service, manager } = serviceWith({ status: "PUBLISHED" })
    await expect(service.update("version-1", teacher, { expectedRevision: 4, objects: [] })).rejects.toBeInstanceOf(ConflictException)
    expect(manager.save).not.toHaveBeenCalled()
  })
})
