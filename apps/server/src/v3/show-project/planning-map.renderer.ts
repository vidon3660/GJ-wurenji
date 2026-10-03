import { Injectable } from "@nestjs/common"
import sharp from "sharp"
import type { ShowAreaAnnotationInput, ShowAreaFeatureInput, V3Coordinate, V3RegionCatalogItem } from "@wurenji/shared"
import { areaFeatureView, showAreaFeatureCatalog } from "./area-plan-validation.js"

interface PlanningMapInput {
  taskTitle: string
  studentName: string
  versionNo: number
  submittedAt: Date
  scaleTemplateCode: string
  region: V3RegionCatalogItem
  features: ShowAreaFeatureInput[]
  annotations: ShowAreaAnnotationInput[]
  rendererVersion?: "V1" | "V2"
}

@Injectable()
export class PlanningMapRenderer {
  async render(input: PlanningMapInput): Promise<Buffer> {
    const width = 1600
    const height = 1200
    const mapFrame = { x: 52, y: 132, width: 1090, height: 860 }
    const bounds = coordinateBounds(input.region.boundary)
    const project = projector(bounds, mapFrame)
    const featureViews = input.features.map(areaFeatureView)
    const orderedFeatures = [...featureViews].sort((left, right) => featureRenderOrder(left.type) - featureRenderOrder(right.type))
    const restrictionPolygons = input.region.layers
      .filter((layer) => layer.code === "RESTRICTIONS")
      .flatMap((layer) => layer.features)
      .filter((feature) => feature.geometryType === "POLYGON" && feature.positions && feature.positions.length >= 3)
    const grid = Array.from({ length: 7 }, (_, index) => {
      const x = mapFrame.x + index * mapFrame.width / 6
      const y = mapFrame.y + index * mapFrame.height / 6
      const longitude = bounds.minimumLongitude + index * (bounds.maximumLongitude - bounds.minimumLongitude) / 6
      const latitude = bounds.maximumLatitude - index * (bounds.maximumLatitude - bounds.minimumLatitude) / 6
      return `<line x1="${x}" y1="${mapFrame.y}" x2="${x}" y2="${mapFrame.y + mapFrame.height}" class="grid"/><text x="${x + 3}" y="${mapFrame.y + mapFrame.height - 7}" class="coord">${longitude.toFixed(5)}°E</text><line x1="${mapFrame.x}" y1="${y}" x2="${mapFrame.x + mapFrame.width}" y2="${y}" class="grid"/><text x="${mapFrame.x + 4}" y="${y - 5}" class="coord">${latitude.toFixed(5)}°N</text>`
    }).join("")
    const restrictions = restrictionPolygons.map((feature) => `<polygon points="${pointsAttribute(feature.positions!, project)}" fill="#bd4f46" fill-opacity="0.12" stroke="#a83f38" stroke-width="2" stroke-dasharray="8 6"/>`).join("")
    const renderedFeatures = orderedFeatures.map((feature, index) => {
        const color = showAreaFeatureCatalog[feature.type].color
        const center = project(feature.measurement.centroid)
        return `<polygon points="${pointsAttribute(feature.positions, project)}" fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-width="3"/><circle cx="${center.x}" cy="${center.y}" r="13" fill="${color}"/><text x="${center.x}" y="${center.y + 5}" class="index" text-anchor="middle">${index + 1}</text>`
      }).join("")
    const includeAnnotations = input.rendererVersion !== "V1"
    const renderedAnnotations = includeAnnotations ? input.annotations.map((annotation) => {
      const point = project(annotation.position)
      return `<g><circle cx="${point.x}" cy="${point.y}" r="9" fill="#173e32" stroke="#ffffff" stroke-width="3"/><text x="${point.x + 15}" y="${point.y + 5}" class="annotation">${escapeXml(annotation.label)}</text></g>`
    }).join("") : ""
    const legend = orderedFeatures.map((feature, index) => {
      const color = showAreaFeatureCatalog[feature.type].color
      const y = 197 + index * 47
      return `<rect x="1194" y="${y - 17}" width="18" height="18" fill="${color}" fill-opacity="0.28" stroke="${color}"/><text x="1224" y="${y - 2}" class="legend">${index + 1}. ${escapeXml(showAreaFeatureCatalog[feature.type].title)} · ${escapeXml(feature.label)}</text><text x="1224" y="${y + 17}" class="legend-sub">${formatArea(feature.measurement.areaSquareMeters)} · ${feature.measurement.centroid.longitude.toFixed(6)}, ${feature.measurement.centroid.latitude.toFixed(6)}</text>`
      }).join("")
    const annotationLegend = includeAnnotations ? input.annotations.slice(0, 12).map((annotation, index) => {
      const y = 640 + index * 27
      return `<text x="1224" y="${y}" class="legend-sub">标注 ${index + 1} · ${escapeXml(annotation.label)} · ${annotation.position.longitude.toFixed(6)}, ${annotation.position.latitude.toFixed(6)}</text>`
    }).join("") : ""
    const annotationStyle = includeAnnotations ? `.annotation { font-size: 13px; font-weight: 700; fill: #173e32; }` : ""
    const scale = scaleBar(bounds, mapFrame)
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <style>
          text { font-family: "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; fill: #173e32; }
          .title { font-size: 30px; font-weight: 700; } .meta { font-size: 15px; fill: #587068; }
          .section { font-size: 16px; font-weight: 700; } .grid { stroke: #789087; stroke-width: 1; stroke-opacity: .18; }
          .coord { font-size: 10px; fill: #71847d; } .index { font-size: 13px; font-weight: 700; fill: white; }
          .legend { font-size: 14px; font-weight: 700; } .legend-sub { font-size: 11px; fill: #6a7e76; }
          ${annotationStyle}
          .note { font-size: 12px; fill: #50675f; } .declaration { font-size: 13px; fill: #7e3e39; font-weight: 700; }
        </style>
        <rect width="1600" height="1200" fill="#f7f9f8"/>
        <rect x="0" y="0" width="1600" height="8" fill="#1e6d50"/>
        <text x="52" y="58" class="title">${escapeXml(input.taskTitle)} · 区域规划图</text>
        <text x="52" y="91" class="meta">学生：${escapeXml(input.studentName)}　区域：${escapeXml(input.region.title)}　版本：V${input.versionNo}　规模：${escapeXml(input.scaleTemplateCode)}</text>
        <text x="1548" y="58" class="meta" text-anchor="end">WGS84 / ${escapeXml(input.region.heightDatum)} · ${escapeXml(input.region.terrainResourceVersion)}</text>
        <rect x="${mapFrame.x}" y="${mapFrame.y}" width="${mapFrame.width}" height="${mapFrame.height}" fill="#e7ede9" stroke="#72877e" stroke-width="1"/>
        ${grid}
        <polygon points="${pointsAttribute(input.region.boundary, project)}" fill="#ffffff" fill-opacity=".22" stroke="#1e6d50" stroke-width="4"/>
        ${restrictions}
        ${renderedFeatures}
        ${renderedAnnotations}
        <text x="1188" y="145" class="section">九类功能区图例与关键坐标</text>
        <line x1="1188" y1="157" x2="1548" y2="157" stroke="#c9d4cf"/>
        ${legend}
        ${annotationLegend}
        <g transform="translate(${mapFrame.x + mapFrame.width - 68} ${mapFrame.y + 32})"><path d="M24 0 L42 50 L24 40 L6 50 Z" fill="#173e32"/><text x="24" y="72" text-anchor="middle" class="section">N</text></g>
        <g transform="translate(${mapFrame.x + 28} ${mapFrame.y + mapFrame.height - 54})"><line x1="0" y1="0" x2="${scale.pixelWidth}" y2="0" stroke="#173e32" stroke-width="5"/><line x1="0" y1="-7" x2="0" y2="7" stroke="#173e32" stroke-width="2"/><line x1="${scale.pixelWidth}" y1="-7" x2="${scale.pixelWidth}" y2="7" stroke="#173e32" stroke-width="2"/><text x="${scale.pixelWidth / 2}" y="-12" text-anchor="middle" class="note">${scale.label}</text></g>
        <text x="52" y="1032" class="note">底图：任务冻结区域包 ${escapeXml(input.region.packageVersion)}　限制区以教学资源快照显示　生成时间：${formatDate(input.submittedAt)}</text>
        <line x1="52" y1="1060" x2="1548" y2="1060" stroke="#ccd6d1"/>
        <text x="52" y="1098" class="declaration">教学仿真声明</text>
        <text x="52" y="1127" class="note">内容仅用于教学仿真，不构成真实行政申报、审批、报备、航线划设、运行批准、安全评估、物流运营或无人机控制依据。</text>
        <text x="1548" y="1170" class="meta" text-anchor="end">数据版本 ${escapeXml(input.region.packageVersion)} · 规划版本 V${input.versionNo}</text>
      </svg>`
    return sharp(Buffer.from(svg)).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
  }
}

function coordinateBounds(points: readonly V3Coordinate[]) {
  const longitudes = points.map((point) => point.longitude)
  const latitudes = points.map((point) => point.latitude)
  const minimumLongitude = Math.min(...longitudes)
  const maximumLongitude = Math.max(...longitudes)
  const minimumLatitude = Math.min(...latitudes)
  const maximumLatitude = Math.max(...latitudes)
  const longitudePadding = Math.max((maximumLongitude - minimumLongitude) * 0.04, 0.0001)
  const latitudePadding = Math.max((maximumLatitude - minimumLatitude) * 0.04, 0.0001)
  return {
    minimumLongitude: minimumLongitude - longitudePadding,
    maximumLongitude: maximumLongitude + longitudePadding,
    minimumLatitude: minimumLatitude - latitudePadding,
    maximumLatitude: maximumLatitude + latitudePadding
  }
}

function projector(bounds: ReturnType<typeof coordinateBounds>, frame: { x: number; y: number; width: number; height: number }) {
  return (point: V3Coordinate) => ({
    x: frame.x + (point.longitude - bounds.minimumLongitude) / (bounds.maximumLongitude - bounds.minimumLongitude) * frame.width,
    y: frame.y + (bounds.maximumLatitude - point.latitude) / (bounds.maximumLatitude - bounds.minimumLatitude) * frame.height
  })
}

function pointsAttribute(points: readonly V3Coordinate[], project: ReturnType<typeof projector>): string {
  return points.map((point) => {
    const position = project(point)
    return `${position.x.toFixed(1)},${position.y.toFixed(1)}`
  }).join(" ")
}

function scaleBar(bounds: ReturnType<typeof coordinateBounds>, frame: { width: number }) {
  const centerLatitude = (bounds.minimumLatitude + bounds.maximumLatitude) / 2
  const widthMeters = (bounds.maximumLongitude - bounds.minimumLongitude) * 111_320 * Math.cos(centerLatitude * Math.PI / 180)
  const targetMeters = widthMeters * 0.18
  const steps = [20, 50, 100, 200, 500, 1000, 2000, 3000, 10_000]
  const meters = [...steps].reverse().find((step) => step <= targetMeters) ?? 20
  return {
    pixelWidth: Math.max(35, meters / widthMeters * frame.width),
    label: meters >= 1000 ? `${meters / 1000} km` : `${meters} m`
  }
}

function featureRenderOrder(type: ShowAreaFeatureInput["type"]): number {
  return ({ GEOFENCE: 0, BUFFER: 1, FLIGHT: 2, GROUND_ISOLATION: 3, PERFORMANCE: 4, AUDIENCE: 5, TAKEOFF_LANDING: 6, OPERATION: 7, EMERGENCY_LANDING: 8 } as Record<ShowAreaFeatureInput["type"], number>)[type]
}

function formatArea(area: number): string {
  return area >= 10_000 ? `${(area / 10_000).toFixed(2)} ha` : `${area.toFixed(0)} m²`
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(date)
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;")
}
