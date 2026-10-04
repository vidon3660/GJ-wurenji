import { describe, expect, it } from "vitest"
import { parseShowProgramCsv } from "./show-program-import.js"

describe("show program CSV import", () => {
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
