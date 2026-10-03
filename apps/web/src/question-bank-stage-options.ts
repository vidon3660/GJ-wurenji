import { stageDefinitionsFor } from "@wurenji/shared"
import type { SceneType } from "@wurenji/shared"

export interface QuestionBankStageOption {
  value: string
  label: string
}

const sceneLabels: Record<SceneType, string> = {
  CITY_SHOW: "城市编队表演",
  CITY_LOGISTICS: "城市低空物流",
  VTOL_INSPECTION: "垂起广域巡检"
}

const sceneTypes: SceneType[] = ["CITY_SHOW", "CITY_LOGISTICS", "VTOL_INSPECTION"]

export function questionBankStageOptions(sceneType: SceneType | null, currentStageCode = ""): QuestionBankStageOption[] {
  const targetScenes = sceneType ? [sceneType] : sceneTypes
  const options: QuestionBankStageOption[] = [{ value: "", label: "通用 / 不指定阶段" }]
  const knownCodes = new Set<string>()

  for (const targetScene of targetScenes) {
    for (const stage of stageDefinitionsFor(targetScene)) {
      if (knownCodes.has(stage.code)) continue
      knownCodes.add(stage.code)
      options.push({
        value: stage.code,
        label: sceneType ? stage.title : `${sceneLabels[targetScene]} · ${stage.title}`
      })
    }
  }

  const normalizedCurrent = currentStageCode.trim()
  if (normalizedCurrent && !knownCodes.has(normalizedCurrent)) {
    options.push({ value: normalizedCurrent, label: `历史阶段（${normalizedCurrent}）` })
  }
  return options
}
