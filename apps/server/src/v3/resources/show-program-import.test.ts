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
})

function csv(aircraftCount: number): Buffer {
  const rows = ["aircraft_id,time_ms,east_m,north_m,up_m"]
  for (let index = 1; index <= aircraftCount; index += 1) {
    rows.push(`UAV-${String(index).padStart(3, "0")},0,${index / 10},0,0`)
    rows.push(`UAV-${String(index).padStart(3, "0")},10000,${index / 10 + 10},0,20`)
  }
  return Buffer.from(rows.join("\n"), "utf8")
}
