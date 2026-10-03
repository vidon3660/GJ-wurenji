<script setup lang="ts">
import { computed, ref } from "vue"
import V3RegionMap from "./V3RegionMap.vue"
import V3AreaPlanningMap from "./V3AreaPlanningMap.vue"
import V3LogisticsRouteMap from "./V3LogisticsRouteMap.vue"
import V3LogisticsRuntimeMap from "./V3LogisticsRuntimeMap.vue"
import V3ShowRuntimeMap from "./V3ShowRuntimeMap.vue"

defineOptions({ inheritAttrs: false })

const props = defineProps<{ renderer?: "region" | "logistics-route" | "logistics-runtime" | "show-runtime" | "area-planning" }>()
const rendererByName = {
  region: V3RegionMap,
  "logistics-route": V3LogisticsRouteMap,
  "logistics-runtime": V3LogisticsRuntimeMap,
  "show-runtime": V3ShowRuntimeMap,
  "area-planning": V3AreaPlanningMap
} as const
// Renderer variants intentionally expose different props; the unified
// boundary forwards attrs at runtime and should not produce a static prop
// intersection in the template type checker.
const renderer = computed<any>(() => rendererByName[props.renderer ?? "region"])

const mapRef = ref<any>(null)

/**
 * Unified map entry point. Scene workspaces provide business props and
 * permissions; the Cesium renderer, layer registry and map events stay in
 * V3RegionMap so every caller uses the same map contract.
 */
defineExpose({
  focusEditorFeature: (id: string) => mapRef.value?.focusEditorFeature(id),
  focusMapRegion: () => mapRef.value?.focusMapRegion()
})
</script>

<template>
  <component :is="renderer" ref="mapRef" v-bind="$attrs" />
</template>
