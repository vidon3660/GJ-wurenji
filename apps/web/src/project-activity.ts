import type { V3ActivityEventType, V3ActivityEventView } from "@wurenji/shared"

const activityLabels = {
  ASSIGNMENT_CREATED: "任务已创建",
  ASSIGNMENT_COPIED: "任务已复制",
  ASSIGNMENT_PUBLISHED: "任务已发布",
  ASSIGNMENT_RESOURCES_UPDATED: "任务资源已更新",
  ASSIGNMENT_WITHDRAWN: "任务已撤回",
  ASSIGNMENT_DELETED: "草稿已删除",
  ASSIGNMENT_ENDED: "任务已结束",
  ASSIGNMENT_ARCHIVED: "任务已归档",
  PROJECT_ASSIGNED: "项目已分配",
  ASSESSMENT_RETAKE_CREATED: "补考项目已创建",
  STAGE_STARTED: "阶段已开始",
  AREA_DRAFT_SAVED: "区域草稿已保存",
  AREA_DRAFT_CHECKED: "区域规则已检查",
  AREA_SNAPSHOT_CREATED: "区域版本已保存",
  AREA_PLAN_SUBMITTED: "区域方案已提交",
  AREA_PLAN_ACCEPTED: "区域方案已通过",
  AREA_PLAN_RETURNED: "区域方案已退回",
  DOCUMENTS_PROVISIONED: "申报母版已创建",
  DOCUMENT_SAVED: "申报材料已保存",
  DOCUMENT_SUBMITTED: "申报材料已提交",
  DOCUMENT_VIEWED: "教师已查看材料",
  DOCUMENT_RETURNED: "申报材料已退回",
  DOCUMENT_RESUBMITTED: "申报材料已重新提交",
  PREFLIGHT_SAVED: "飞前检查已保存",
  PREFLIGHT_COMPLETED: "飞前准备已完成",
  T60_CLOCK_STARTED: "仿真时钟已启动",
  T60_REPORT_SUBMITTED: "T-60 申请已提交",
  RUNTIME_SESSION_CREATED: "运行会话已创建",
  RUNTIME_RESTARTED: "运行已从检查点重训",
  TAKEOFF_REPORTED: "实际起飞动态已记录",
  RUNTIME_STARTED: "固定表演程序已启动",
  RUNTIME_CLOCK_CHANGED: "运行速度已调整",
  RUNTIME_EVENT_TRIGGERED: "运行事件已发生",
  RUNTIME_EVENT_DISCOVERED: "运行告警已发现",
  RUNTIME_EVENT_ESCALATED: "运行事件已升级",
  RUNTIME_EVENT_RESOLVED: "运行事件已控制",
  RUNTIME_ACTION_APPLIED: "飞行处置已执行",
  RUNTIME_COMPLETED: "固定表演程序已完成",
  RUNTIME_ABORTED: "固定表演程序已中止",
  RUNTIME_EMERGENCY_SUBMITTED: "巡检事件处置已提交",
  TEACHER_RUNTIME_INTERVENTION: "教师已执行训练干预",
  FLIGHT_END_REPORT_SUBMITTED: "飞行结束报备已提交",
  REVIEW_SUMMARY_SAVED: "飞后总结已保存",
  REVIEW_SUMMARY_SUBMITTED: "飞后总结已提交",
  REVIEW_ANNOTATION_ADDED: "教师已添加时间轴讲评",
  EVALUATION_SAVED: "综合评价已保存",
  EVALUATION_PUBLISHED: "综合评价已发布",
  REPORT_GENERATED: "最终项目报告已生成",
  LOGISTICS_REGION_SAVED: "物流区域分析已保存",
  LOGISTICS_REGION_CONFIRMED: "物流区域分析已确认",
  LOGISTICS_ROUTE_DRAFT_SAVED: "物流航线草稿已保存",
  LOGISTICS_ROUTE_CHECKED: "物流航线规则已检查",
  LOGISTICS_ROUTE_VERSION_CREATED: "物流航线版本已保存",
  LOGISTICS_ROUTE_VALIDATED: "物流航线往返已验证",
  LOGISTICS_ROUTE_PLAN_SUBMITTED: "固定物流航线方案已提交",
  LOGISTICS_ORDER_BATCH_GENERATED: "物流订单批次已生成",
  LOGISTICS_SCHEDULE_DRAFT_SAVED: "物流调度草稿已保存",
  LOGISTICS_SCHEDULE_BATCH_ADJUSTED: "物流任务已批量调整",
  LOGISTICS_SCHEDULE_CHECKED: "物流调度已核定",
  LOGISTICS_SCHEDULE_VERSION_CREATED: "物流调度版本已保存",
  LOGISTICS_SCHEDULE_VERSION_RESTORED: "物流调度版本已恢复",
  LOGISTICS_INITIAL_SCHEDULE_SUBMITTED: "物流初始调度已提交",
  LOGISTICS_READINESS_SAVED: "运行准备结论已保存",
  LOGISTICS_READINESS_CONFIRMED: "运行准备已确认",
  LOGISTICS_RUNTIME_SESSION_CREATED: "物流运行会话已创建",
  LOGISTICS_RUNTIME_RESTARTED: "物流运行已从检查点重训",
  LOGISTICS_RUNTIME_STARTED: "物流配送运行已启动",
  LOGISTICS_RUNTIME_CLOCK_CHANGED: "物流运行时钟已调整",
  LOGISTICS_RUNTIME_EVENT_TRIGGERED: "物流训练事件已触发",
  LOGISTICS_RUNTIME_EVENT_DISCOVERED: "物流运行告警已发现",
  LOGISTICS_RUNTIME_EVENT_ESCALATED: "物流运行事件已升级",
  LOGISTICS_RUNTIME_EVENT_RESOLVED: "物流运行事件已控制",
  LOGISTICS_RUNTIME_ACTION_APPLIED: "物流应急处置已执行",
  LOGISTICS_DYNAMIC_SCHEDULE_CREATED: "动态调度版本已创建",
  LOGISTICS_DYNAMIC_SCHEDULE_SUBMITTED: "动态调度版本已生效",
  LOGISTICS_RUNTIME_COMPLETED: "物流配送运行已完成",
  LOGISTICS_REVIEW_SUMMARY_SAVED: "物流复盘总结已保存",
  LOGISTICS_REVIEW_SUMMARY_SUBMITTED: "物流复盘总结已提交",
  LOGISTICS_EVALUATION_SAVED: "物流评价已保存",
  LOGISTICS_EVALUATION_PUBLISHED: "物流评价已发布",
  LOGISTICS_REPORT_GENERATED: "物流项目报告已生成",
  QUESTION_BANK_CREATED: "题库已创建",
  QUESTION_BANK_VERSION_CREATED: "题库版本已创建",
  QUESTION_BANK_PUBLISHED: "题库版本已发布",
  QUESTION_BANK_VERSION_ARCHIVED: "题库空草稿已归档",
  QUESTION_ATTEMPT_SAVED: "题库作答已保存",
  QUESTION_ATTEMPT_SUBMITTED: "题库作答已提交",
  QUESTION_ATTEMPT_REGRADED: "题库作答已重新判定",
  QUESTION_ATTEMPT_REVIEWED: "题库作答已复核",
  TEACHER_ALERT_FOLLOW_UP_UPDATED: "教师告警跟踪已更新"
} satisfies Record<V3ActivityEventType, string>

export function projectActivityLabel(type: V3ActivityEventType): string {
  return activityLabels[type]
}

export function projectActivitySummary(event: V3ActivityEventView): string {
  const { eventType, payload, result } = event
  if (eventType === "ASSIGNMENT_RESOURCES_UPDATED") return `资源修订 R${result.resourceRevision ?? "-"} · 更新 ${result.changedCount ?? 0} 项`
  if (eventType === "ASSIGNMENT_ENDED" || eventType === "ASSIGNMENT_WITHDRAWN") return text(payload.reason, "任务状态已更新")
  if (eventType === "PROJECT_ASSIGNED") return "项目已加入学生工作台"
  if (eventType === "ASSESSMENT_RETAKE_CREATED") return `第 ${result.attemptNumber ?? "-"} 次考核 · ${text(payload.reason, "已记录补考原因")}`
  if (eventType === "STAGE_STARTED") return "学生已进入本阶段"
  if (eventType === "AREA_DRAFT_SAVED") return `${result.featureCount ?? 0} 个区域要素 · ${result.annotationCount ?? 0} 个标注`
  if (eventType === "AREA_DRAFT_CHECKED") return result.passed === true ? "检查通过" : `发现 ${result.evidenceCount ?? 0} 项问题`
  if (eventType === "AREA_PLAN_SUBMITTED" || eventType === "AREA_SNAPSHOT_CREATED") return `区域版本 V${result.versionNo ?? "-"}`
  if (eventType === "AREA_PLAN_ACCEPTED" || eventType === "AREA_PLAN_RETURNED") return text(payload.comment, "区域审核状态已更新")
  if (eventType === "DOCUMENTS_PROVISIONED") return `已创建 ${result.documentCount ?? 0} 份申报材料`
  if (eventType === "DOCUMENT_SAVED" || eventType === "DOCUMENT_SUBMITTED" || eventType === "DOCUMENT_RESUBMITTED") return `文档版本 V${result.versionNo ?? "-"}`
  if (eventType === "DOCUMENT_RETURNED" || eventType === "DOCUMENT_VIEWED") return text(payload.comment, "材料状态已更新")
  if (eventType === "PREFLIGHT_SAVED") return `${result.confirmedCount ?? 0}/${result.itemCount ?? 0} 项已确认`
  if (eventType === "PREFLIGHT_COMPLETED") return `起飞决策：${result.decision ?? "-"}`
  if (eventType === "T60_CLOCK_STARTED") return `仿真时钟 ${result.rate ?? "-"}x`
  if (eventType === "T60_REPORT_SUBMITTED") return "起飞前一小时申请已留痕"
  if (eventType === "RUNTIME_SESSION_CREATED") return `${result.totalAircraft ?? 0} 架 · ${result.groupCount ?? 0} 个分组`
  if (eventType === "RUNTIME_RESTARTED" || eventType === "LOGISTICS_RUNTIME_RESTARTED") return `第 ${result.attemptNo ?? "-"} 次训练 · ${result.nodeLabel ?? result.nodeCode ?? "检查点"}`
  if (eventType === "TAKEOFF_REPORTED") return `实际起飞 ${result.actualTakeoffCount ?? 0} 架`
  if (eventType === "RUNTIME_STARTED") return `运行速度 ${result.clockRate ?? "-"}x`
  if (eventType === "RUNTIME_CLOCK_CHANGED") return `调整为 ${result.clockRate ?? "-"}x`
  if (eventType === "RUNTIME_EVENT_TRIGGERED" || eventType === "RUNTIME_EVENT_ESCALATED") return `${payload.code ?? "运行事件"} · 影响 ${result.affectedCount ?? payload.affectedCount ?? 0} 架`
  if (eventType === "RUNTIME_EVENT_DISCOVERED") return `告警级别 ${result.severity ?? "-"}`
  if (eventType === "RUNTIME_EVENT_RESOLVED") return `控制方式：${result.recoveryMode ?? "学生处置"}`
  if (eventType === "RUNTIME_ACTION_APPLIED") return `${payload.actionCode ?? "处置"} · ${result.eventControlled === true ? "事件已控制" : "结果已记录"}`
  if (eventType === "RUNTIME_COMPLETED" || eventType === "RUNTIME_ABORTED") return String(result.status ?? "运行已结束")
  if (eventType === "TEACHER_RUNTIME_INTERVENTION") return text(payload.message, text(payload.action, "训练干预"))
  if (eventType === "FLIGHT_END_REPORT_SUBMITTED") return `正常 ${result.normalLandedCount ?? 0} · 异常 ${result.abnormalCount ?? 0}`
  if (eventType === "REVIEW_SUMMARY_SAVED" || eventType === "REVIEW_SUMMARY_SUBMITTED" || eventType === "LOGISTICS_REVIEW_SUMMARY_SAVED" || eventType === "LOGISTICS_REVIEW_SUMMARY_SUBMITTED") return `总结 ${result.summaryLength ?? 0} 字`
  if (eventType === "REVIEW_ANNOTATION_ADDED") return `讲评 ${result.commentLength ?? 0} 字`
  if (eventType === "EVALUATION_SAVED" || eventType === "EVALUATION_PUBLISHED" || eventType === "LOGISTICS_EVALUATION_SAVED" || eventType === "LOGISTICS_EVALUATION_PUBLISHED") return `综合得分 ${result.totalScore ?? "-"}`
  if (eventType === "REPORT_GENERATED" || eventType === "LOGISTICS_REPORT_GENERATED") return `${result.format ?? "报告"} · ${result.filename ?? "文件已生成"}`
  if (eventType === "LOGISTICS_REGION_SAVED" || eventType === "LOGISTICS_REGION_CONFIRMED") return `${result.selectedDeliveryPointCount ?? 0} 个配送点`
  if (eventType === "LOGISTICS_ROUTE_DRAFT_SAVED") return `${result.routeCount ?? 0} 条航线`
  if (eventType === "LOGISTICS_ROUTE_CHECKED") return result.passed === true ? "检查通过" : `硬冲突 ${result.conflictCount ?? 0} 项`
  if (eventType === "LOGISTICS_ROUTE_VERSION_CREATED") return `航线版本 V${result.versionNo ?? "-"}`
  if (eventType === "LOGISTICS_ROUTE_VALIDATED") return `第 ${result.attemptNo ?? "-"} 次 · ${result.status ?? "-"}`
  if (eventType === "LOGISTICS_ROUTE_PLAN_SUBMITTED") return `正式版本 V${result.versionNo ?? "-"}`
  if (eventType === "LOGISTICS_ORDER_BATCH_GENERATED") return `${result.orderCount ?? 0} 单 · ${result.aircraftCount ?? 0} 架`
  if (eventType === "LOGISTICS_SCHEDULE_DRAFT_SAVED") return `${result.itemCount ?? 0} 班任务`
  if (eventType === "LOGISTICS_SCHEDULE_BATCH_ADJUSTED") return `${result.orderCount ?? 0} 条任务 · ${formatMinuteShift(result.takeoffShiftMs)} 时刻偏移`
  if (eventType === "LOGISTICS_SCHEDULE_CHECKED") return `${result.status ?? "-"} · 冲突 ${result.conflictCount ?? 0}`
  if (eventType === "LOGISTICS_SCHEDULE_VERSION_CREATED" || eventType === "LOGISTICS_SCHEDULE_VERSION_RESTORED") return `调度版本 V${result.versionNo ?? "-"}`
  if (eventType === "LOGISTICS_INITIAL_SCHEDULE_SUBMITTED") return `正式调度 V${result.versionNo ?? "-"}`
  if (eventType === "LOGISTICS_READINESS_SAVED" || eventType === "LOGISTICS_READINESS_CONFIRMED") return `通过 ${result.passCount ?? 0} 项 · 阻断 ${result.failCount ?? 0} 项`
  if (eventType === "LOGISTICS_RUNTIME_SESSION_CREATED" || eventType === "LOGISTICS_RUNTIME_STARTED") return `${result.taskCount ?? result.itemCount ?? 0} 班 · ${result.clockRate ?? "-"}x`
  if (eventType === "LOGISTICS_RUNTIME_CLOCK_CHANGED") return `${result.status ?? "-"} · ${result.clockRate ?? "-"}x`
  if (eventType === "LOGISTICS_RUNTIME_EVENT_TRIGGERED" || eventType === "LOGISTICS_RUNTIME_EVENT_DISCOVERED" || eventType === "LOGISTICS_RUNTIME_EVENT_ESCALATED") return `${payload.code ?? payload.eventSubtype ?? "运行事件"} · ${result.severity ?? "-"}`
  if (eventType === "LOGISTICS_RUNTIME_EVENT_RESOLVED") return `${result.eventSubtype ?? payload.eventSubtype ?? "运行事件"} · 已控制`
  if (eventType === "LOGISTICS_RUNTIME_ACTION_APPLIED") return `${payload.actionCode ?? "处置"} · ${result.applied === true ? "已执行" : "已记录"}`
  if (eventType === "LOGISTICS_DYNAMIC_SCHEDULE_CREATED" || eventType === "LOGISTICS_DYNAMIC_SCHEDULE_SUBMITTED") return `动态版本 V${result.versionNo ?? "-"}`
  if (eventType === "LOGISTICS_RUNTIME_COMPLETED") return "运行时刻表已完成"
  if (eventType === "QUESTION_BANK_CREATED") return `${result.questionCount ?? 0} 道题 · 初始版本已创建`
  if (eventType === "QUESTION_BANK_VERSION_CREATED") return `题库版本 V${payload.version ?? "-"} · ${payload.questionCount ?? 0} 道题`
  if (eventType === "QUESTION_BANK_PUBLISHED") return `题库版本 V${payload.version ?? "-"} · ${result.questionCount ?? 0} 道题`
  if (eventType === "QUESTION_BANK_VERSION_ARCHIVED") return `题库版本 V${payload.version ?? "-"} · ${result.bankArchived === true ? "题库已归档" : "已从工作区移出"}`
  if (eventType === "QUESTION_ATTEMPT_SAVED") return `自动得分 ${result.autoScore ?? "-"}`
  if (eventType === "QUESTION_ATTEMPT_SUBMITTED") return `已提交 · 自动得分 ${result.autoScore ?? "-"}`
  if (eventType === "QUESTION_ATTEMPT_REGRADED") return `自动得分 ${result.autoScore ?? "-"} · 待证据 ${result.pendingCount ?? 0} 题`
  if (eventType === "QUESTION_ATTEMPT_REVIEWED") return `教师得分 ${result.teacherScore ?? "-"}`
  return "关键操作已留痕"
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function formatMinuteShift(value: unknown): string {
  const milliseconds = typeof value === "number" ? value : Number(value ?? 0)
  if (!Number.isFinite(milliseconds)) return "0 分钟"
  const minutes = milliseconds / 60_000
  const formatted = Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1)
  return `${minutes > 0 ? "+" : ""}${formatted} 分钟`
}
