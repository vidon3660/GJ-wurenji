// @vitest-environment jsdom

import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { QuestionnaireView } from "@wurenji/shared"

// The workspace delegates map rendering to Cesium. Keep this interaction test
// focused on the request guard and avoid creating a WebGL context in jsdom.
vi.mock("./components/V3UnifiedMap.vue", () => ({ default: { template: "<div class=\"map-stub\" />" } }))

import V3ProjectWorkspaceView from "./components/V3ProjectWorkspaceView.vue"

import { planningProject as project, planningSnapshot as snapshot } from "./test-fixtures/planning-draft"

const region = {
  packageId: "region-1",
  packageVersion: "1.0.0",
  checksum: "checksum",
  sceneType: "VTOL_INSPECTION",
  regionCode: "TEST",
  title: "测试区域",
  summary: "",
  center: { longitude: 116.3, latitude: 39.9 },
  boundary: [],
  heightDatum: "AMSL",
  terrainResourceVersion: "terrain-v1",
  imageryState: "READY",
  layers: []
} as const

const questionnaire: QuestionnaireView = {
  available: true,
  reason: null,
  actor: "STUDENT",
  canEdit: true,
  canSubmit: false,
  canReview: false,
  canRegrade: false,
  bank: { id: "bank-1", title: "巡检方案任务", sceneType: "VTOL_INSPECTION", summary: "", versionId: "bank-version-1", version: 1 },
  attempt: null,
  questions: [],
  responses: []
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } })
}

describe("V3ProjectWorkspaceView questionnaire entry", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("disables the entry while loading and ignores repeated clicks", async () => {
    let questionnaireCalls = 0
    let resolveSecondRequest!: (response: Response) => void
    const secondRequest = new Promise<Response>((resolve) => { resolveSecondRequest = resolve })
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith("/stages")) return Promise.resolve(jsonResponse(project))
      if (path.includes("/assignments/") && path.endsWith("/snapshot")) return Promise.resolve(jsonResponse(snapshot))
      if (path.includes("/resource-packages/regions/")) return Promise.resolve(jsonResponse(region))
      if (path.endsWith("/activities")) return Promise.resolve(jsonResponse([]))
      if (path.endsWith("/questionnaire")) {
        questionnaireCalls += 1
        return questionnaireCalls === 2 ? secondRequest : Promise.resolve(jsonResponse(questionnaire))
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const wrapper = mount(V3ProjectWorkspaceView, {
      props: { user: { id: "student-1", email: "student@example.com", displayName: "学生", role: "student" }, projectId: project.id },
      global: {
        directives: { loading: {} },
        stubs: {
          V3ProjectModeStatus: true,
          V3ProjectStageNavigation: true,
          V3ProjectSyncState: true,
          V3UnifiedMap: true,
          QuestionnairePanel: true,
          "el-icon": true,
          "el-button": true,
          "el-drawer": true
        }
      }
    })
    await flushPromises()

    const entry = wrapper.get("button.questionnaire-command")
    expect(questionnaireCalls).toBe(1)
    expect(entry.attributes("disabled")).toBeUndefined()

    await entry.trigger("click")
    await flushPromises()
    expect(questionnaireCalls).toBe(2)
    expect(entry.attributes("disabled")).toBeDefined()

    await entry.trigger("click")
    expect(questionnaireCalls).toBe(2)

    resolveSecondRequest(jsonResponse(questionnaire))
    await flushPromises()
    expect(entry.attributes("disabled")).toBeUndefined()

    await entry.trigger("click")
    expect(questionnaireCalls).toBe(2)
    wrapper.unmount()
  })
})

// Keep the shell real; route editor lifecycle has separate component tests.
vi.mock("./components/V3VtlPlanningWorkspace.vue", () => ({ __esModule: true, default: {
  props: ["stage", "project"], emits: ["dirtyChange", "refreshProject"],
  data: () => ({ draft: "" }),
  mounted(this: { $emit: (event: string, value: boolean) => void }) { this.$emit("dirtyChange", false) },
  template: `<section class="planning-editor"><input v-model="draft" aria-label="规划草稿" @input="$emit('dirtyChange', true)" /><button class="refresh-project" @click="$emit('refreshProject')">刷新阶段</button></section>`
} }))

import { ElMessageBox } from "element-plus"
import type { VueWrapper } from "@vue/test-utils"

const planningProject = {
  ...project, currentStageCode: "VTL_ROUTE_PLANNING",
  stages: [
    { ...project.stages[0], stageCode: "VTL_ROUTE_PLANNING", title: "航线规划", status: "IN_PROGRESS" },
    { ...project.stages[0], stageCode: "VTL_TASK_ALLOCATION", title: "分区分配", status: "IN_PROGRESS" },
    { ...project.stages[0], stageCode: "VTL_RUNTIME", title: "仿真运行", status: "LOCKED" }
  ]
}
const navigationWrappers: VueWrapper[] = []
function navigationFetch(overrides: { stages?: () => Promise<Response>; region?: () => Promise<Response> } = {}) {
  return vi.fn((input: RequestInfo | URL) => {
    const path = String(input)
    if (path.endsWith("/stages")) return overrides.stages?.() ?? Promise.resolve(jsonResponse(planningProject))
    if (path.endsWith("/snapshot")) return Promise.resolve(jsonResponse({ ...snapshot, config: { ...snapshot.config, questionBankVersionId: null } }))
    if (path.includes("/regions/")) return overrides.region?.() ?? Promise.resolve(jsonResponse(region))
    if (path.endsWith("/activities")) return Promise.resolve(jsonResponse([]))
    throw new Error(`Unexpected request: ${path}`)
  })
}
async function mountNavigation(fetchMock = navigationFetch()) {
  vi.stubGlobal("fetch", fetchMock)
  const wrapper = mount(V3ProjectWorkspaceView, {
    props: { user: { id: "student-1", email: "student@example.com", displayName: "学生", role: "student" }, projectId: project.id },
    global: {
      directives: { loading: {} },
      stubs: {
        V3ProjectModeStatus: true,
        V3ProjectStageNavigation: {
          props: ["project", "selectedStageCode"],
          template: `<nav><button v-for="stage in project?.stages ?? []" :key="stage.stageCode" :data-stage="stage.stageCode" :aria-pressed="stage.stageCode === selectedStageCode" @click="$emit('select', stage.stageCode)">{{ stage.title }}</button></nav>`
        },
        V3UnifiedMap: true, QuestionnairePanel: true, "el-icon": true,
        "el-button": { template: `<button><slot /></button>` }, "el-drawer": true
      }
    }
  })
  navigationWrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
function draftInput(wrapper: VueWrapper) { return wrapper.get<HTMLInputElement>(".planning-editor input") }
function currentStage(wrapper: VueWrapper) { return wrapper.get("nav button[aria-pressed=true]").attributes("data-stage") }
function pendingConfirmation() {
  let resolve!: (value: never) => void
  const promise = new Promise<never>((yes) => { resolve = yes })
  return { promise, resolve: () => resolve(undefined as never) }
}
describe("V3ProjectWorkspaceView planning navigation", () => {
  afterEach(() => {
    for (const wrapper of navigationWrappers.splice(0)) wrapper.unmount()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  it.each(["back", "stage", "simulation"])("preserves draft and stage after cancelling %s", async (entry) => {
    const confirm = vi.spyOn(ElMessageBox, "confirm").mockRejectedValue("cancel")
    const wrapper = await mountNavigation()
    await draftInput(wrapper).setValue("未保存航线")
    const selector = entry === "back" ? "button[aria-label='返回教学首页']" : entry === "stage" ? "[data-stage='VTL_TASK_ALLOCATION']" : ".simulation-command"
    await wrapper.get(selector).trigger("click")
    await flushPromises()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(currentStage(wrapper)).toBe("VTL_ROUTE_PLANNING")
    expect(draftInput(wrapper).element.value).toBe("未保存航线")
    expect(wrapper.emitted("back")).toBeUndefined()
    expect(wrapper.emitted("onboardingAction")).toBeUndefined()
    const unload = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
  })
  it("shares one confirmation across rapid navigation and guards a second editing stage", async () => {
    const pending = pendingConfirmation()
    const confirm = vi.spyOn(ElMessageBox, "confirm").mockReturnValue(pending.promise)
    const wrapper = await mountNavigation()
    await draftInput(wrapper).setValue("草稿")
    await wrapper.get("[data-stage='VTL_TASK_ALLOCATION']").trigger("click")
    await wrapper.get(".simulation-command").trigger("click")
    await wrapper.get("button[aria-label='返回教学首页']").trigger("click")
    expect(confirm).toHaveBeenCalledTimes(1)
    pending.resolve()
    await flushPromises()
    expect(currentStage(wrapper)).toBe("VTL_TASK_ALLOCATION")
    expect(draftInput(wrapper).element.value).toBe("")
    expect(wrapper.emitted("back")).toBeUndefined()
    await draftInput(wrapper).setValue("第二阶段草稿")
    confirm.mockRejectedValueOnce("cancel")
    await wrapper.get(".simulation-command").trigger("click")
    await flushPromises()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(currentStage(wrapper)).toBe("VTL_TASK_ALLOCATION")
    expect(draftInput(wrapper).element.value).toBe("第二阶段草稿")
  })
  it("keeps the same draft when changing only 2D/3D view", async () => {
    const confirm = vi.spyOn(ElMessageBox, "confirm")
    const wrapper = await mountNavigation()
    await draftInput(wrapper).setValue("共享地图草稿")
    await wrapper.get("button[aria-label='3D 空间理解视角']").trigger("click")
    await wrapper.get("button[aria-label='2D 精确规划视角']").trigger("click")
    expect(draftInput(wrapper).element.value).toBe("共享地图草稿")
    expect(confirm).not.toHaveBeenCalled()
  })
  it.each(["unmount", "project-change"])("ignores late confirmation after %s", async (interruption) => {
    const pending = pendingConfirmation()
    vi.spyOn(ElMessageBox, "confirm").mockReturnValue(pending.promise)
    const wrapper = await mountNavigation()
    await draftInput(wrapper).setValue("草稿")
    await wrapper.get("button[aria-label='返回教学首页']").trigger("click")
    if (interruption === "unmount") wrapper.unmount()
    else await wrapper.setProps({ projectId: "project-2" })
    pending.resolve()
    await flushPromises()
    expect(wrapper.emitted("back")).toBeUndefined()
  })
  it("preserves a draft on failed reconnect and resets it only after successful confirmed reload", async () => {
    let stageCalls = 0
    let failRegion = false
    const fetchMock = navigationFetch({
      stages: () => ++stageCalls === 2 ? Promise.reject(new Error("offline")) : Promise.resolve(jsonResponse(planningProject)),
      region: () => failRegion ? Promise.reject(new Error("region offline")) : Promise.resolve(jsonResponse(region))
    })
    const confirm = vi.spyOn(ElMessageBox, "confirm").mockRejectedValueOnce("cancel").mockResolvedValue(undefined as never)
    const wrapper = await mountNavigation(fetchMock)
    await draftInput(wrapper).setValue("断网前草稿")
    await wrapper.get(".refresh-project").trigger("click")
    await flushPromises()
    await wrapper.get(".service-retry").trigger("click")
    await flushPromises()
    expect(stageCalls).toBe(2)
    expect(draftInput(wrapper).element.value).toBe("断网前草稿")
    failRegion = true
    await wrapper.get(".service-retry").trigger("click")
    await flushPromises()
    expect(stageCalls).toBe(3)
    expect(draftInput(wrapper).element.value).toBe("断网前草稿")
    failRegion = false
    await wrapper.get(".service-retry").trigger("click")
    await flushPromises()
    expect(stageCalls).toBe(4)
    expect(confirm).toHaveBeenCalledTimes(3)
    expect(draftInput(wrapper).element.value).toBe("")
    expect(wrapper.find(".service-retry").exists()).toBe(false)
  })
})
