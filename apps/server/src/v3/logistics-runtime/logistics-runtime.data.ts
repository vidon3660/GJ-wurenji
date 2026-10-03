import { ConflictException, Injectable } from "@nestjs/common"
import type {
  LogisticsAircraftInstanceView,
  LogisticsScheduleItemInput,
  LogisticsScheduleItemView,
  LogisticsScheduleVersionView,
  LogisticsSchedulingOrderView,
  LogisticsSchedulingRouteView,
  V3LogisticsNode
} from "@wurenji/shared"
import { EntityManager } from "typeorm"
import { LogisticsRoutePlanVersionEntity, LogisticsWaypointEntity } from "../logistics-route/logistics-route.entities.js"
import { parseRegionCatalogItem } from "../resources/region-catalog.js"
import { ResourcePackageEntity } from "../resources/resource-package.entity.js"
import {
  LogisticsAircraftInstanceEntity,
  LogisticsDispatchItemEntity,
  LogisticsOrderEntity,
  LogisticsScheduleVersionEntity
} from "../logistics-scheduling/logistics-scheduling.entities.js"

export interface LogisticsRuntimeScheduleRecords {
  version: LogisticsScheduleVersionEntity
  orders: LogisticsOrderEntity[]
  aircraft: LogisticsAircraftInstanceEntity[]
  routeVersion: LogisticsRoutePlanVersionEntity
  orderViews: LogisticsSchedulingOrderView[]
  aircraftViews: LogisticsAircraftInstanceView[]
  routeViews: LogisticsSchedulingRouteView[]
  scheduleItems: LogisticsScheduleItemView[]
  logisticsNodes: V3LogisticsNode[]
}

@Injectable()
export class LogisticsRuntimeDataService {
  async loadSubmittedSchedule(manager: EntityManager, projectId: string): Promise<LogisticsRuntimeScheduleRecords> {
    const [version, orders, aircraft, routeVersion] = await Promise.all([
      manager.findOne(LogisticsScheduleVersionEntity, {
        where: { project: { id: projectId }, status: "SUBMITTED" },
        relations: { items: { order: true, aircraft: true, outboundRoute: true, returnRoute: true } },
        order: { versionNo: "DESC" }
      }),
      manager.find(LogisticsOrderEntity, { where: { batch: { project: { id: projectId } } }, order: { code: "ASC" } }),
      manager.find(LogisticsAircraftInstanceEntity, { where: { project: { id: projectId } }, order: { code: "ASC" } }),
      manager.findOne(LogisticsRoutePlanVersionEntity, {
        where: { project: { id: projectId }, status: "SUBMITTED" },
        relations: { routes: { waypoints: true } },
        order: { versionNo: "DESC" }
      })
    ])
    if (!version || !routeVersion) throw new ConflictException("正式初始调度或正式航线方案不存在")
    const regionPackage = await manager.findOne(ResourcePackageEntity, {
      where: { id: version.project.snapshot.config.regionPackageId, packageType: "REGION" }
    })
    const region = regionPackage ? parseRegionCatalogItem(regionPackage) : null
    if (!region) throw new ConflictException("项目引用的物流区域资源不可用")
    const orderViews = orders.map((order) => this.serializeOrder(order, version.items?.some((item) => item.order.id === order.id) ?? false))
    const aircraftViews = aircraft.map((item) => this.serializeAircraft(item))
    const routeViews = this.serializeRoutes(routeVersion)
    return {
      version,
      orders,
      aircraft,
      routeVersion,
      orderViews,
      aircraftViews,
      routeViews,
      scheduleItems: this.computedItems(version),
      logisticsNodes: region.logisticsNodes ?? []
    }
  }

  serializeScheduleVersion(version: LogisticsScheduleVersionEntity): LogisticsScheduleVersionView {
    return {
      id: version.id,
      versionNo: version.versionNo,
      sourceDraftRevision: version.sourceDraftRevision,
      status: version.status,
      items: this.inputItems(version),
      checkResult: version.checkResult,
      createdBy: version.createdBy.displayName,
      createdAt: version.createdAt.toISOString(),
      submittedAt: version.submittedAt?.toISOString() ?? null
    }
  }

  inputItems(version: LogisticsScheduleVersionEntity): LogisticsScheduleItemInput[] {
    return sortedItems(version.items).map((item) => ({
      id: item.itemKey,
      orderId: item.order.id,
      aircraftId: item.aircraft.id,
      outboundRouteId: item.outboundRoute.id,
      returnRouteId: item.returnRoute.id,
      plannedTakeoffTimeMs: item.plannedTakeoffTimeMs
    }))
  }

  computedItems(version: LogisticsScheduleVersionEntity): LogisticsScheduleItemView[] {
    return sortedItems(version.items).map((item) => ({
      id: item.itemKey,
      orderId: item.order.id,
      aircraftId: item.aircraft.id,
      outboundRouteId: item.outboundRoute.id,
      returnRouteId: item.returnRoute.id,
      plannedTakeoffTimeMs: item.plannedTakeoffTimeMs,
      orderCode: item.order.code,
      aircraftCode: item.aircraft.code,
      destinationNodeId: item.order.destinationNodeId,
      arrivalTimeMs: item.arrivalTimeMs,
      returnStartTimeMs: item.returnStartTimeMs,
      landingTimeMs: item.landingTimeMs,
      nextAvailableTimeMs: item.nextAvailableTimeMs,
      batteryAfterMissionPercent: item.batteryAfterMissionPercent
    }))
  }

  serializeOrder(order: LogisticsOrderEntity, scheduled: boolean): LogisticsSchedulingOrderView {
    return {
      id: order.id,
      code: order.code,
      destinationNodeId: order.destinationNodeId,
      releaseTimeMs: order.releaseTimeMs,
      priority: order.priority,
      earliestStartTimeMs: order.earliestStartTimeMs,
      latestArrivalTimeMs: order.latestArrivalTimeMs,
      status: scheduled ? "SCHEDULED" : order.releaseTimeMs > 0 ? "UNRELEASED" : "UNASSIGNED"
    }
  }

  serializeAircraft(item: LogisticsAircraftInstanceEntity): LogisticsAircraftInstanceView {
    return { id: item.id, code: item.code, modelCode: item.modelCode, initialBatteryPercent: item.initialBatteryPercent, availableAtMs: item.availableAtMs, status: item.status }
  }

  serializeRoutes(version: LogisticsRoutePlanVersionEntity): LogisticsSchedulingRouteView[] {
    return [...(version.routes ?? [])].sort((left, right) => left.routeKey.localeCompare(right.routeKey)).map((route) => {
      const metric = version.validationResult?.routeMetrics.find((item) => item.routeId === route.routeKey)
      return {
        id: route.id,
        versionId: version.id,
        versionNo: version.versionNo,
        validationStatus: version.validationResult?.status ?? "INFEASIBLE",
        route: {
          id: route.routeKey,
          name: route.name,
          mode: route.mode ?? "FIXED_ROUND_TRIP",
          destinationNodeId: route.destinationNodeId,
          direction: route.direction,
          role: route.role,
          groupCode: route.groupCode,
          departureNodeId: route.departureNodeId,
          arrivalNodeId: route.arrivalNodeId,
          protectionRadiusMeters: route.protectionRadiusMeters,
          waitingNodeIds: route.waitingNodeIds,
          alternateLandingNodeIds: route.alternateLandingNodeIds,
          emergencyAreaNodeIds: route.emergencyAreaNodeIds,
          entryDirectionDegrees: route.entryDirectionDegrees,
          exitDirectionDegrees: route.exitDirectionDegrees,
          waypoints: [...(route.waypoints ?? [])].sort((left, right) => left.sequence - right.sequence).map((waypoint: LogisticsWaypointEntity) => ({
            id: waypoint.waypointKey,
            name: waypoint.name,
            position: { longitude: waypoint.longitude, latitude: waypoint.latitude },
            altitudeMeters: waypoint.altitudeMeters,
            segmentAltitudeMeters: waypoint.segmentAltitudeMeters,
            speedMps: waypoint.speedMps,
            nodeId: waypoint.nodeId,
            locked: waypoint.locked
          }))
        },
        distanceMeters: metric?.distanceMeters ?? 0,
        flightTimeMs: Math.max(1_000, Math.round((metric?.flightTimeSeconds ?? 60) * 1_000)),
        batteryConsumptionPercent: metric?.batteryConsumptionPercent ?? 10
      }
    })
  }
}

function sortedItems(items: LogisticsDispatchItemEntity[] | undefined): LogisticsDispatchItemEntity[] {
  return [...(items ?? [])].sort((left, right) => left.sequence - right.sequence)
}
