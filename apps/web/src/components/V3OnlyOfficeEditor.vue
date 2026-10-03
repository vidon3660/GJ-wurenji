<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue"

const props = defineProps<{ publicApiUrl: string; config: Record<string, unknown> }>()
const emit = defineEmits<{ ready: []; error: [message: string] }>()
const editorId = `onlyoffice-${crypto.randomUUID()}`
const loading = ref(true)
let editor: { destroyEditor?: () => void } | null = null

onMounted(async () => {
  try {
    await loadOnlyOfficeScript(props.publicApiUrl)
    const DocsAPI = (window as unknown as { DocsAPI?: { DocEditor: new (id: string, config: Record<string, unknown>) => { destroyEditor?: () => void } } }).DocsAPI
    if (!DocsAPI) throw new Error("ONLYOFFICE 编辑器脚本未就绪")
    editor = new DocsAPI.DocEditor(editorId, {
      ...props.config,
      events: {
        onAppReady: () => {
          loading.value = false
          emit("ready")
        },
        onError: (event: { data?: { errorCode?: number; errorDescription?: string } }) => {
          loading.value = false
          emit("error", event.data?.errorDescription || `编辑器错误 ${event.data?.errorCode ?? ""}`)
        }
      }
    })
  } catch (error) {
    loading.value = false
    emit("error", error instanceof Error ? error.message : "ONLYOFFICE 编辑器加载失败")
  }
})

onBeforeUnmount(() => editor?.destroyEditor?.())

function loadOnlyOfficeScript(source: string): Promise<void> {
  const existing = document.querySelector<HTMLScriptElement>(`script[data-onlyoffice-source="${CSS.escape(source)}"]`)
  if (existing?.dataset.loaded === "true") return Promise.resolve()
  return new Promise((resolve, reject) => {
    const script = existing ?? document.createElement("script")
    script.dataset.onlyofficeSource = source
    script.addEventListener("load", () => {
      script.dataset.loaded = "true"
      resolve()
    }, { once: true })
    script.addEventListener("error", () => reject(new Error("ONLYOFFICE 服务不可用")), { once: true })
    if (!existing) {
      script.src = source
      document.head.append(script)
    }
  })
}
</script>

<template>
  <div class="onlyoffice-host" v-loading="loading"><div :id="editorId" /></div>
</template>

<style scoped>
.onlyoffice-host,
.onlyoffice-host > div { width: 100%; height: 100%; min-height: 0; }
</style>
