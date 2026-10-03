import {
  resolveShowInitialConditions,
  showCommunicationControlLabel,
  showGustLabel,
  showInitialDeviceScopeLabel,
  showInitialDeviceStateLabel,
  showPositioningElectromagneticLabel,
  showRainLabel,
  showTemplateAircraftCount,
  showWindDirectionLabel,
  showWindForceLabel,
  type AssignmentDraftConfig
} from "@wurenji/shared"

export interface ShowTaskInitialConditionsSummary {
  weather: string
  positioningElectromagnetic: string
  communicationControl: string
  device: string
}

export function showTaskInitialConditionsSummary(config: AssignmentDraftConfig): ShowTaskInitialConditionsSummary {
  const initial = resolveShowInitialConditions(config.scenario, showTemplateAircraftCount(config.scaleTemplateCode))
  return {
    weather: `${showWindDirectionLabel(initial.windDirection)} · 风力${showWindForceLabel(initial.windForceState)} · 阵风${showGustLabel(initial.gustState)} · 降雨${showRainLabel(initial.rainState)}`,
    positioningElectromagnetic: showPositioningElectromagneticLabel(initial.positioningElectromagneticState),
    communicationControl: showCommunicationControlLabel(initial.communicationControlState),
    device: initial.deviceState === "NORMAL"
      ? "正常"
      : `${showInitialDeviceStateLabel(initial.deviceState)} · ${showInitialDeviceScopeLabel(initial.deviceImpactScope)} · ${initial.deviceAffectedCount} 架`
  }
}
