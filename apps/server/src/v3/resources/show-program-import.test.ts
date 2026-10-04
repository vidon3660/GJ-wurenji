import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { parseShowProgramCsv } from "./show-program-import.js"
import { ResourcePackageService } from "./resource-package.service.js"

describe("show program CSV import", () => {
  it("blocks activation when the stored pass checks disagree with a reparsed trajectory", async () => {
    const source = collisionCsv()
    const parsed = parseShowProgramCsv(source, "Tampered Show Studio")
    const digest = createHash("sha256").update(source).digest("hex")
    const item = {
      id: "show-tampered",
      packageType: "SHOW_PROGRAM",
      name: "导入表演程序",
      version: "1.0.0",
      schemaVersion: 1,
      minimumPlatformVersion: "0.1.0",
      sha256: digest,
      status: "STAGED",
      source: "IMPORTED_TRAJECTORY",
      manifest: parsed.manifest,
      archiveAsset: { objectKey: "show.csv", storageProvider: "LOCAL", sha256: digest },
      archiveManifest: null,
      validatedAt: new Date(),
      rejectionReason: null,
      validationChecks: parsed.checks.map((check) => ({ ...check, passed: true })),
      activatedAt: null,
      retiredAt: null,
      createdAt: new Date(),
      updatedAt: new Date()
    }
    const manager = {
      query: vi.fn(),
      findOneBy: vi.fn().mockResolvedValue(item),
      save: vi.fn(),
      transaction: vi.fn(async (_isolation: string, callback: (transactionManager: typeof manager) => unknown) => callback(manager)),
      createQueryBuilder: vi.fn()
    }
    manager.createQueryBuilder.mockReturnValue({
      setLock: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      andWhere: vi.fn().mockReturnThis(),
      getMany: vi.fn().mockResolvedValue([])
    })
    const service = new ResourcePackageService(
      { manager, findOneByOrFail: vi.fn().mockResolvedValue(item) } as never,
      undefined as never,
      undefined as never,
      { findOneByOrFail: vi.fn().mockResolvedValue({ id: "admin-1" }) } as never,
      undefined as never,
      { read: vi.fn().mockResolvedValue(source) } as never
    )

    await expect(service.activate("show-tampered", {
      id: "admin-1", email: "admin@example.test", displayName: "管理员", role: "admin"
    })).rejects.toThrow("轨迹间距校验未通过")
    expect(manager.save).not.toHaveBeenCalled()
  })

  it("normalizes a 100-aircraft local ENU choreography into group tracks", () => {
    const parsed = parseShowProgramCsv(csv(100), "Dance Studio X")

    expect(parsed.manifest).toMatchObject({
      aircraftCount: 100,
      durationMs: 10_000,
      maximumAltitudeMeters: 20,
      sourceSoftware: "Dance Studio X"
    })
    expect(parsed.manifest.groupTracks).toHaveLength(1)
    expect(parsed.manifest.groupTracks[0]?.points).toHaveLength(2)
    expect(parsed.checks.every((check) => check.passed)).toBe(true)
  })

  it("accepts common dance-software column aliases", () => {
    const value = Buffer.from(csv(100).toString("utf8").replace("aircraft_id,time_ms,east_m,north_m,up_m", "drone_id,timestamp_ms,x_m,y_m,z_m"), "utf8")

    expect(parseShowProgramCsv(value, "Alias Studio").manifest.aircraftCount).toBe(100)
  })

  it("keeps a 3000-aircraft program at 30 aggregate runtime tracks", () => {
    const parsed = parseShowProgramCsv(csv(3000), "Large Show Studio")

    expect(parsed.manifest.aircraftCount).toBe(3000)
    expect(parsed.manifest.groupTracks).toHaveLength(30)
    expect(parsed.manifest.groupTracks.at(-1)?.groupId).toBe("G30")
  })

  it("rejects a fleet size outside fixed show templates", () => {
    expect(() => parseShowProgramCsv(csv(99), "Dance Studio X")).toThrow("仅支持 100、500、1000 或 3000 架")
  })

  it("rejects duplicate timestamps for one aircraft", () => {
    const value = Buffer.from(`${csv(100).toString("utf8")}\nUAV-001,10000,10,0,20`, "utf8")

    expect(() => parseShowProgramCsv(value, "Dance Studio X")).toThrow("存在重复轨迹点")
  })

  it("rejects imported tracks that converge inside the air separation limits", () => {
    const rows = ["aircraft_id,time_ms,east_m,north_m,up_m"]
    for (let index = 0; index < 100; index += 1) {
      const east = (index % 10) * 8
      const north = Math.floor(index / 10) * 8
      rows.push(`UAV-${String(index + 1).padStart(3, "0")},0,${east},${north},20`)
      rows.push(`UAV-${String(index + 1).padStart(3, "0")},10000,0,0,20`)
    }
    const parsed = parseShowProgramCsv(Buffer.from(rows.join("\n"), "utf8"), "Collision Test")
    expect(parsed.checks.find((check) => check.code === "SHOW_PROGRAM_AIR_CONFLICT")).toMatchObject({ passed: false })
  })

  it("finds a fast crossing between coarse timeline sample points", () => {
    const rows = ["aircraft_id,time_ms,east_m,north_m,up_m"]
    // The aircraft cross at 625 ms, while the former eight-point broad phase
    // sampled 0 and 1250 ms and could miss the pair entirely.
    rows.push("UAV-001,0,-25,0,20", "UAV-001,10000,375,0,20")
    rows.push("UAV-002,0,25,0,20", "UAV-002,10000,-375,0,20")
    for (let index = 2; index < 100; index += 1) {
      const east = 1000 + (index % 10) * 8
      const north = Math.floor(index / 10) * 8
      rows.push(`UAV-${String(index + 1).padStart(3, "0")},0,${east},${north},20`)
      rows.push(`UAV-${String(index + 1).padStart(3, "0")},10000,${east},${north},20`)
    }
    const parsed = parseShowProgramCsv(Buffer.from(rows.join("\n"), "utf8"), "Fast Crossing Test")
    expect(parsed.checks.find((check) => check.code === "SHOW_PROGRAM_AIR_CONFLICT")).toMatchObject({ passed: false })
  })

  it("handles aircraft IDs containing the pair-key separator", () => {
    const rows = ["aircraft_id,time_ms,east_m,north_m,up_m"]
    rows.push("FLIGHT/A,0,0,0,20", "FLIGHT/A,10000,0,0,20")
    rows.push("FLIGHT/B,0,2,0,20", "FLIGHT/B,10000,2,0,20")
    for (let index = 2; index < 100; index += 1) {
      const east = 1000 + (index % 10) * 8
      const north = Math.floor(index / 10) * 8
      rows.push(`UAV-${String(index + 1).padStart(3, "0")},0,${east},${north},20`)
      rows.push(`UAV-${String(index + 1).padStart(3, "0")},10000,${east},${north},20`)
    }
    const parsed = parseShowProgramCsv(Buffer.from(rows.join("\n"), "utf8"), "Slash ID Test")
    expect(parsed.checks.find((check) => check.code === "SHOW_PROGRAM_AIR_CONFLICT")).toMatchObject({ passed: false })
  })

  it("does not report roots outside the segment interval", () => {
    const rows = ["aircraft_id,time_ms,east_m,north_m,up_m"]
    rows.push("UAV-001,0,0,0,20", "UAV-001,10000,0,0,20")
    // Relative distance reaches 5 m only after this interval ends (roots at
    // 2.5 and 7.5 in normalized time), so clamping roots to [0, 1] would
    // falsely turn them into a collision at the endpoint.
    rows.push("UAV-002,0,10,0,20", "UAV-002,10000,8,0,20")
    for (let index = 2; index < 100; index += 1) {
      const east = 1000 + (index % 10) * 8
      const north = Math.floor(index / 10) * 8
      rows.push(`UAV-${String(index + 1).padStart(3, "0")},0,${east},${north},20`)
      rows.push(`UAV-${String(index + 1).padStart(3, "0")},10000,${east},${north},20`)
    }
    const parsed = parseShowProgramCsv(Buffer.from(rows.join("\n"), "utf8"), "Outside Root Test")
    expect(parsed.checks.find((check) => check.code === "SHOW_PROGRAM_AIR_CONFLICT")).toMatchObject({ passed: true })
  })

  it("allows a pair exactly on both configured separation limits", () => {
    const rows = ["aircraft_id,time_ms,east_m,north_m,up_m"]
    rows.push("UAV-001,0,0,0,20", "UAV-001,10000,0,0,20")
    rows.push("UAV-002,0,5,0,23", "UAV-002,10000,5,0,23")
    for (let index = 2; index < 100; index += 1) {
      const east = 1000 + (index % 10) * 8
      const north = Math.floor(index / 10) * 8
      rows.push(`UAV-${String(index + 1).padStart(3, "0")},0,${east},${north},20`)
      rows.push(`UAV-${String(index + 1).padStart(3, "0")},10000,${east},${north},20`)
    }
    const parsed = parseShowProgramCsv(Buffer.from(rows.join("\n"), "utf8"), "Boundary Separation Test")
    expect(parsed.checks.find((check) => check.code === "SHOW_PROGRAM_AIR_CONFLICT")).toMatchObject({ passed: true })
  })

  it("finds a crossing at a non-midpoint using relative segment motion", () => {
    const rows = ["aircraft_id,time_ms,east_m,north_m,up_m"]
    rows.push("UAV-001,0,-10,0,20", "UAV-001,10000,30,0,20")
    rows.push("UAV-002,0,0,-10,20", "UAV-002,10000,0,30,20")
    for (let index = 2; index < 100; index += 1) {
      const east = 100 + (index % 10) * 8
      const north = Math.floor(index / 10) * 8
      rows.push(`UAV-${String(index + 1).padStart(3, "0")},0,${east},${north},20`)
      rows.push(`UAV-${String(index + 1).padStart(3, "0")},10000,${east},${north},20`)
    }
    const parsed = parseShowProgramCsv(Buffer.from(rows.join("\n"), "utf8"), "Crossing Test")
    expect(parsed.checks.find((check) => check.code === "SHOW_PROGRAM_AIR_CONFLICT")).toMatchObject({ passed: false })
  })
})

function collisionCsv(): Buffer {
  const rows = ["aircraft_id,time_ms,east_m,north_m,up_m"]
  for (let index = 0; index < 100; index += 1) {
    const east = index < 2 ? index * 2 : 1000 + (index % 10) * 8
    const north = index < 2 ? 0 : Math.floor(index / 10) * 8
    rows.push(`UAV-${String(index + 1).padStart(3, "0")},0,${east},${north},20`)
    rows.push(`UAV-${String(index + 1).padStart(3, "0")},10000,${east},${north},20`)
  }
  return Buffer.from(rows.join("\n"), "utf8")
}

function csv(aircraftCount: number): Buffer {
  const rows = ["aircraft_id,time_ms,east_m,north_m,up_m"]
  for (let index = 1; index <= aircraftCount; index += 1) {
    const east = ((index - 1) % 50) * 8
    const north = Math.floor((index - 1) / 50) * 8
    rows.push(`UAV-${String(index).padStart(3, "0")},0,${east},${north},0`)
    rows.push(`UAV-${String(index).padStart(3, "0")},10000,${east + 2},${north},20`)
  }
  return Buffer.from(rows.join("\n"), "utf8")
}
