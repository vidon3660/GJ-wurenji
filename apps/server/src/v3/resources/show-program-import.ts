import Papa from "papaparse"
import type { ShowProgramManifest, ShowProgramTrackPoint, V3ResourceValidationCheck } from "@wurenji/shared"

interface SourcePoint extends ShowProgramTrackPoint {
  sourceTimeMs: number
}

interface ParsedRow {
  aircraftId: string
  point: SourcePoint
}

export interface ParsedShowProgram {
  manifest: ShowProgramManifest
  checks: V3ResourceValidationCheck[]
}

const supportedAircraftCounts = new Set([100, 500, 1000, 3000])
const maximumRows = 5_000_000
const maximumTrackPoints = 301

export function parseShowProgramCsv(content: Buffer, sourceSoftware: string): ParsedShowProgram {
  const normalizedSoftware = sourceSoftware.trim()
  if (!normalizedSoftware || normalizedSoftware.length > 120) throw new Error("来源舞步软件不能为空且不能超过 120 个字符")
  const text = content.toString("utf8").replace(/^\uFEFF/, "")
  if (!text.trim()) throw new Error("轨迹 CSV 文件为空")
  if (text.includes("\uFFFD")) throw new Error("轨迹 CSV 必须使用 UTF-8 编码")

  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: canonicalHeader
  })
  const parseErrors = parsed.errors
  if (parseErrors.length > 0) {
    const first = parseErrors[0]!
    throw new Error(`轨迹 CSV 解析失败：第 ${(first.row ?? 0) + 2} 行 ${first.message}`)
  }
  const fields = parsed.meta.fields ?? []
  const requiredFields = ["aircraft_id", "time_ms", "east_m", "north_m", "up_m"]
  const missingFields = requiredFields.filter((field) => !fields.includes(field))
  if (missingFields.length > 0) throw new Error(`轨迹 CSV 缺少字段：${missingFields.join("、")}`)
  if (new Set(fields).size !== fields.length) throw new Error("轨迹 CSV 表头存在重复字段或别名冲突")
  if (parsed.data.length > maximumRows) throw new Error(`轨迹 CSV 不能超过 ${maximumRows} 行`)

  const rows = parsed.data.map((row, index) => parseRow(row, index + 2))
  if (rows.length === 0) throw new Error("轨迹 CSV 没有有效数据行")
  const tracks = collectAircraftTracks(rows)
  const aircraftIds = [...tracks.keys()].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
  if (!supportedAircraftCounts.has(aircraftIds.length)) {
    throw new Error(`轨迹包含 ${aircraftIds.length} 架无人机；V1.0 仅支持 100、500、1000 或 3000 架固定规模`)
  }

  const allPoints = rows.map((row) => row.point)
  let minimumSourceTimeMs = Number.POSITIVE_INFINITY
  let maximumSourceTimeMs = Number.NEGATIVE_INFINITY
  for (const point of allPoints) {
    minimumSourceTimeMs = Math.min(minimumSourceTimeMs, point.sourceTimeMs)
    maximumSourceTimeMs = Math.max(maximumSourceTimeMs, point.sourceTimeMs)
  }
  const durationMs = maximumSourceTimeMs - minimumSourceTimeMs
  if (durationMs < 10_000 || durationMs > 1_800_000) throw new Error("轨迹时长必须在 10 秒到 30 分钟之间")

  let maximumAltitudeMeters = 0
  let horizontalRadiusMeters = 0
  let maximumSpeedMetersPerSecond = 0
  for (const [aircraftId, points] of tracks) {
    points.sort((left, right) => left.sourceTimeMs - right.sourceTimeMs)
    if (points.length < 2) throw new Error(`无人机 ${aircraftId} 至少需要 2 个轨迹点`)
    if (points[0]!.sourceTimeMs - minimumSourceTimeMs > 1_000 || maximumSourceTimeMs - points.at(-1)!.sourceTimeMs > 1_000) {
      throw new Error(`无人机 ${aircraftId} 的轨迹没有覆盖完整表演时间轴`)
    }
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]!
      point.timeMs = point.sourceTimeMs - minimumSourceTimeMs
      maximumAltitudeMeters = Math.max(maximumAltitudeMeters, point.upMeters)
      horizontalRadiusMeters = Math.max(horizontalRadiusMeters, Math.hypot(point.eastMeters, point.northMeters))
      if (index === 0) continue
      const previous = points[index - 1]!
      if (point.sourceTimeMs === previous.sourceTimeMs) throw new Error(`无人机 ${aircraftId} 在 ${point.sourceTimeMs} ms 存在重复轨迹点`)
      const distance = Math.hypot(
        point.eastMeters - previous.eastMeters,
        point.northMeters - previous.northMeters,
        point.upMeters - previous.upMeters
      )
      maximumSpeedMetersPerSecond = Math.max(maximumSpeedMetersPerSecond, distance / ((point.sourceTimeMs - previous.sourceTimeMs) / 1000))
    }
  }
  if (maximumAltitudeMeters > 500) throw new Error(`轨迹最大高度 ${round(maximumAltitudeMeters)} m 超过平台 500 m 上限`)
  if (horizontalRadiusMeters > 5_000) throw new Error(`轨迹水平半径 ${round(horizontalRadiusMeters)} m 超过平台 5000 m 上限`)
  if (maximumSpeedMetersPerSecond > 40) throw new Error(`轨迹最大段速度 ${round(maximumSpeedMetersPerSecond)} m/s 超过平台 40 m/s 安全上限`)

  const sourceTimes = [...new Set(allPoints.map((point) => point.sourceTimeMs))].sort((left, right) => left - right)
  const sampledTimes = sampleTimeline(sourceTimes, maximumTrackPoints)
  const groupTracks = buildGroupTracks(aircraftIds, tracks, sampledTimes, minimumSourceTimeMs)
  const checks: V3ResourceValidationCheck[] = [
    { code: "SHOW_PROGRAM_CSV", passed: true, message: "CSV 表头、UTF-8 编码和数值字段校验通过" },
    { code: "SHOW_PROGRAM_SCALE", passed: true, message: `识别 ${aircraftIds.length} 架无人机，与固定规模模板兼容` },
    { code: "SHOW_PROGRAM_TIMELINE", passed: true, message: `轨迹时长 ${round(durationMs / 1000)} 秒，共 ${sourceTimes.length} 个关键时刻` },
    { code: "SHOW_PROGRAM_ENVELOPE", passed: true, message: `最大高度 ${round(maximumAltitudeMeters)} m，水平半径 ${round(horizontalRadiusMeters)} m` },
    {
      code: "SHOW_PROGRAM_KINEMATICS",
      passed: true,
      message: maximumSpeedMetersPerSecond > 20
        ? `最大段速度 ${round(maximumSpeedMetersPerSecond)} m/s，已通过硬限制但建议人工复核机型能力`
        : `最大段速度 ${round(maximumSpeedMetersPerSecond)} m/s，运动学初检通过`
    }
  ]
  return {
    manifest: {
      sceneType: "CITY_SHOW",
      format: "LOCAL_ENU_CSV_V1",
      sourceSoftware: normalizedSoftware,
      aircraftCount: aircraftIds.length,
      groupSize: 100,
      keyframeCount: sourceTimes.length,
      sourceRowCount: rows.length,
      durationMs,
      maximumAltitudeMeters: round(maximumAltitudeMeters),
      horizontalRadiusMeters: round(horizontalRadiusMeters),
      maximumSpeedMetersPerSecond: round(maximumSpeedMetersPerSecond),
      groupTracks
    },
    checks
  }
}

export function isShowProgramManifest(value: unknown): value is ShowProgramManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const manifest = value as Partial<ShowProgramManifest>
  return manifest.sceneType === "CITY_SHOW"
    && manifest.format === "LOCAL_ENU_CSV_V1"
    && typeof manifest.sourceSoftware === "string"
    && typeof manifest.aircraftCount === "number"
    && typeof manifest.durationMs === "number"
    && typeof manifest.maximumAltitudeMeters === "number"
    && typeof manifest.horizontalRadiusMeters === "number"
    && Array.isArray(manifest.groupTracks)
}

function parseRow(row: Record<string, string>, rowNumber: number): ParsedRow {
  const aircraftId = String(row.aircraft_id ?? "").trim()
  if (!aircraftId || aircraftId.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(aircraftId)) throw new Error(`第 ${rowNumber} 行 aircraft_id 无效`)
  const sourceTimeMs = integer(row.time_ms, `第 ${rowNumber} 行 time_ms`, 0, 86_400_000)
  return {
    aircraftId,
    point: {
      sourceTimeMs,
      timeMs: sourceTimeMs,
      eastMeters: number(row.east_m, `第 ${rowNumber} 行 east_m`, -5_000, 5_000),
      northMeters: number(row.north_m, `第 ${rowNumber} 行 north_m`, -5_000, 5_000),
      upMeters: number(row.up_m, `第 ${rowNumber} 行 up_m`, 0, 500)
    }
  }
}

function collectAircraftTracks(rows: ParsedRow[]): Map<string, SourcePoint[]> {
  const tracks = new Map<string, SourcePoint[]>()
  for (const row of rows) {
    const points = tracks.get(row.aircraftId) ?? []
    points.push(row.point)
    tracks.set(row.aircraftId, points)
  }
  return tracks
}

function buildGroupTracks(
  aircraftIds: string[],
  tracks: Map<string, SourcePoint[]>,
  sourceTimes: number[],
  minimumSourceTimeMs: number
) {
  const groups = Math.ceil(aircraftIds.length / 100)
  return Array.from({ length: groups }, (_, groupIndex) => {
    const ids = aircraftIds.slice(groupIndex * 100, (groupIndex + 1) * 100)
    const points = sourceTimes.map((sourceTimeMs) => {
      let eastMeters = 0
      let northMeters = 0
      let upMeters = 0
      for (const id of ids) {
        const point = interpolate(tracks.get(id)!, sourceTimeMs)
        eastMeters += point.eastMeters
        northMeters += point.northMeters
        upMeters += point.upMeters
      }
      return {
        timeMs: sourceTimeMs - minimumSourceTimeMs,
        eastMeters: round(eastMeters / ids.length),
        northMeters: round(northMeters / ids.length),
        upMeters: round(upMeters / ids.length)
      }
    })
    return { groupId: `G${String(groupIndex + 1).padStart(2, "0")}`, points }
  })
}

function interpolate(points: SourcePoint[], sourceTimeMs: number): SourcePoint {
  if (sourceTimeMs <= points[0]!.sourceTimeMs) return points[0]!
  if (sourceTimeMs >= points.at(-1)!.sourceTimeMs) return points.at(-1)!
  let low = 0
  let high = points.length - 1
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    if (points[middle]!.sourceTimeMs <= sourceTimeMs) low = middle
    else high = middle
  }
  const left = points[low]!
  const right = points[high]!
  const ratio = (sourceTimeMs - left.sourceTimeMs) / (right.sourceTimeMs - left.sourceTimeMs)
  return {
    sourceTimeMs,
    timeMs: sourceTimeMs,
    eastMeters: left.eastMeters + (right.eastMeters - left.eastMeters) * ratio,
    northMeters: left.northMeters + (right.northMeters - left.northMeters) * ratio,
    upMeters: left.upMeters + (right.upMeters - left.upMeters) * ratio
  }
}

function sampleTimeline(values: number[], maximum: number): number[] {
  if (values.length <= maximum) return values
  const sampled = Array.from({ length: maximum }, (_, index) => values[Math.round(index * (values.length - 1) / (maximum - 1))]!)
  return [...new Set(sampled)]
}

function canonicalHeader(value: string): string {
  const normalized = value.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s-]+/g, "_")
  const aliases: Record<string, string> = {
    drone_id: "aircraft_id",
    droneid: "aircraft_id",
    aircraftid: "aircraft_id",
    timestamp_ms: "time_ms",
    x: "east_m",
    x_m: "east_m",
    east: "east_m",
    y: "north_m",
    y_m: "north_m",
    north: "north_m",
    z: "up_m",
    z_m: "up_m",
    altitude_m: "up_m",
    altitude: "up_m"
  }
  return aliases[normalized] ?? normalized
}

function number(value: unknown, label: string, minimum: number, maximum: number): number {
  const normalized = Number(value)
  if (!Number.isFinite(normalized) || normalized < minimum || normalized > maximum) throw new Error(`${label} 必须在 ${minimum} 到 ${maximum} 之间`)
  return normalized
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  const normalized = number(value, label, minimum, maximum)
  if (!Number.isInteger(normalized)) throw new Error(`${label} 必须为整数`)
  return normalized
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
