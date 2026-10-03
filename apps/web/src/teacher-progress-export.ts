import type { V3TeacherProgressItem } from "@wurenji/shared"

/**
 * Build a spreadsheet-friendly UTF-8 CSV from the currently filtered progress rows.
 * The export intentionally contains teaching status and IDs only; runtime evidence
 * remains behind the project workspace permissions.
 */
export function teacherProgressCsv(items: readonly V3TeacherProgressItem[], formatDate: (value: string) => string = (value) => value) {
  const headers = ["学生", "任务", "场景", "当前阶段", "提交状态", "评价状态", "开放告警", "最近活动", "项目ID"]
  const rows = items.map((item) => [
    item.studentName,
    item.assignmentDisplayTitle || item.assignmentTitle,
    sceneLabel(item.sceneType),
    item.currentStageTitle,
    submissionLabel(item.submissionState),
    evaluationLabel(item.evaluationState),
    String(item.alerts.length),
    formatDate(item.lastActivityAt),
    item.projectId
  ])
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n"
}

function csvCell(value: string) {
  const normalized = String(value ?? "").replace(/\r?\n/g, " ")
  return /[",]/.test(normalized) ? `"${normalized.replace(/"/g, '""')}"` : normalized
}

function sceneLabel(value: V3TeacherProgressItem["sceneType"]) {
  return value === "CITY_SHOW" ? "城市编队表演" : value === "CITY_LOGISTICS" ? "城市低空物流" : "垂起广域巡检"
}

function submissionLabel(value: V3TeacherProgressItem["submissionState"]) {
  return value === "NOT_STARTED" ? "未开始" : value === "IN_PROGRESS" ? "进行中" : "已提交"
}

function evaluationLabel(value: V3TeacherProgressItem["evaluationState"]) {
  return value === "NOT_STARTED" ? "未进入" : value === "PENDING" ? "待评价" : "已发布"
}
