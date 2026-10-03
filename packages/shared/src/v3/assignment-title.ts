import type { SceneType } from "../types.js"

export interface TeachingAssignmentTitleInput {
  id: string
  title: string
  sceneType: SceneType
}

export function isUnreadableTeachingTitle(value: string): boolean {
  const title = value.trim()
  if (!title) return true
  const hasQuestionMarks = /[?？]{2,}/.test(title)
  const hasUuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(title)
  const meaningfulText = title.replace(/[?？0-9a-f\s\-_.:：()[\]（）]/gi, "")
  return (hasQuestionMarks && meaningfulText.length < 2) || (hasUuid && meaningfulText.length < 2)
}

export function displayTeachingAssignmentTitle(input: TeachingAssignmentTitleInput): string {
  if (!isUnreadableTeachingTitle(input.title)) return input.title.trim()
  const sceneLabel = input.sceneType === "CITY_SHOW"
    ? "城市编队表演"
    : input.sceneType === "CITY_LOGISTICS"
      ? "城市低空物流"
      : "垂起巡检"
  const traceCode = input.id.replace(/-/g, "").slice(0, 8).toUpperCase()
  return `${sceneLabel}历史教学任务 · ${traceCode}`
}
