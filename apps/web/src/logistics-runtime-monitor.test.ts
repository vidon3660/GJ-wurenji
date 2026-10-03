import { describe, expect, it } from "vitest"
import { logisticsDestinationLabel, logisticsRuntimeMonitorMetrics, logisticsTaskTimingPresentation, sortLogisticsRuntimeTasks } from "./logistics-runtime-monitor"

describe("logistics runtime monitor presentation", () => {
  it("projects all ten STU-023 runtime information groups", () => {
    const metrics = logisticsRuntimeMonitorMetrics({
      aircraft: { position: { longitude: 114.0729, latitude: 22.69175, altitudeMeters: 48.5 }, speedMps: 12.3, batteryPercent: 68.4 },
      task: { status: "OUTBOUND" },
      route: { name: "机场-配送点 A", direction: "OUTBOUND", status: "RISK" },
      order: { code: "ORD-20260814-01", status: "DELIVERING" },
      environment: {
        windDirection: "SW",
        windState: "NEAR_LIMIT",
        gustState: "OCCASIONAL",
        rainState: "BELOW_LIMIT",
        positioningQuality: "DEGRADED",
        communicationQuality: "GOOD",
        equipmentState: "WARNING",
        operationState: "RESTRICTED"
      }
    })

    expect(metrics.map(({ code, label }) => ({ code, label }))).toEqual([
      { code: "POSITION", label: "无人机位置" },
      { code: "ROUTE", label: "航线" },
      { code: "TASK_STAGE", label: "任务阶段" },
      { code: "SPEED", label: "速度" },
      { code: "BATTERY", label: "电量" },
      { code: "POSITIONING", label: "定位" },
      { code: "COMMUNICATION", label: "通信" },
      { code: "EQUIPMENT", label: "设备" },
      { code: "ORDER", label: "订单" },
      { code: "ENVIRONMENT", label: "环境状态" }
    ])
    expect(Object.fromEntries(metrics.map((item) => [item.code, item.value]))).toEqual({
      POSITION: "114.072900, 22.691750 · 高度 48.5 m",
      ROUTE: "机场-配送点 A · 去程 · 风险",
      TASK_STAGE: "去程飞行",
      SPEED: "12.3 m/s",
      BATTERY: "68%",
      POSITIONING: "降级",
      COMMUNICATION: "良好",
      EQUIPMENT: "告警",
      ORDER: "ORD-20260814-01 · 配送中",
      ENVIRONMENT: "西南风 · 近限制 · 阵风偶发 · 降雨限制内"
    })
  })

  it("returns ten stable placeholders before a selection is available", () => {
    const metrics = logisticsRuntimeMonitorMetrics({ aircraft: null, task: null, route: null, order: null, environment: null })

    expect(metrics).toHaveLength(10)
    expect(metrics.find((item) => item.code === "POSITION")?.value).toBe("--")
    expect(metrics.find((item) => item.code === "ROUTE")?.value).toBe("待进入航线")
    expect(metrics.find((item) => item.code === "ORDER")?.value).toBe("无关联订单")
  })

  it("sorts the mission board by planned takeoff time with stable ties", () => {
    const tasks = [
      { scheduleItemId: "2", orderCode: "ORD-02", plannedTakeoffTimeMs: 20 },
      { scheduleItemId: "3", orderCode: "ORD-03", plannedTakeoffTimeMs: 10 },
      { scheduleItemId: "1", orderCode: "ORD-01", plannedTakeoffTimeMs: 20 }
    ]

    expect(sortLogisticsRuntimeTasks(tasks).map((task) => task.scheduleItemId)).toEqual(["3", "1", "2"])
  })

  it("uses the region business name for a destination node", () => {
    const region = { logisticsNodes: [{ id: "node-1", name: "教学配送点 A" }] } as Parameters<typeof logisticsDestinationLabel>[0]
    expect(logisticsDestinationLabel(region, "node-1")).toBe("教学配送点 A")
    expect(logisticsDestinationLabel(region, "missing-node")).toBe("missing-node")
  })

  it("explains the authoritative time window and why a task is not executing", () => {
    const base = {
      task: { status: "WAITING_EXECUTION" as const, plannedTakeoffTimeMs: 300_000 },
      order: { status: "SCHEDULED" as const, releaseTimeMs: 60_000, latestArrivalTimeMs: 900_000 },
      aircraft: { status: "ASSIGNED" as const, nextAvailableTimeMs: 0 },
      route: { status: "AVAILABLE" as const },
      simulationTimeMs: 120_000,
      sessionStatus: "RUNNING"
    }

    expect(logisticsTaskTimingPresentation(base)).toEqual({
      windowLabel: "T+00:01:00 - T+00:15:00",
      executionLabel: "等待计划起飞",
      tone: "neutral"
    })
    expect(logisticsTaskTimingPresentation({ ...base, order: { ...base.order, status: "EXPECTED_DELAY" } }).executionLabel).toBe("预计超过最晚送达时刻")
    expect(logisticsTaskTimingPresentation({ ...base, route: { status: "CLOSED" } }).executionLabel).toBe("航线已关闭，等待重新调度")
    expect(logisticsTaskTimingPresentation({ ...base, sessionStatus: "PAUSED" }).executionLabel).toBe("仿真已暂停")
  })
})
