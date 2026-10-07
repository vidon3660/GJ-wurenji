// @vitest-environment jsdom

import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ElMessageBox } from "element-plus"
import type { StudentProjectView, VtlPlanningWorkspaceView } from "@wurenji/shared"

// Keep the real editor and its controls; map rendering is outside these
// navigation and request-lifecycle tests and requires a WebGL context.
vi.mock("./components/V3UnifiedMap.vue", () => ({ default: {
  name: "V3UnifiedMap",
  props: ["vtlPlan", "vtlSelectedAircraftId"],
  emits: ["vtl-aircraft-select"],
  template: "<div class=\"map-stub\" />"
} }))
vi.mock("./components/V3EnvironmentLayerPanel.vue", () => ({ default: { template: "<div />" } }))
vi.mock("./components/V3RuntimePlaybackBar.vue", () => ({ default: { template: "<div />" } }))

import V3VtlPlanningWorkspace from "./components/V3VtlPlanningWorkspace.vue"
import V3UnifiedMap from "./components/V3UnifiedMap.vue"

import { planningRegion as region, planningWorkspace as workspace } from "./test-fixtures/planning-draft"

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } })
}

function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((fulfill) => { resolve = fulfill })
  return { promise, resolve }
}

function deferredConfirmation() {
  let resolve!: () => void
  const promise = new Promise<void>((fulfill) => { resolve = fulfill })
  return { promise, resolve }
}

interface Mutation {
  path: string
  method: string
  body: { expectedRevision?: number; transitionHeightMeters?: number }
}

function mockRequests(
  respond: (mutation: Mutation) => Promise<Response>,
  read: (path: string) => Promise<Response> = () => Promise.resolve(jsonResponse(workspace()))
) {
  const mutations: Mutation[] = []
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path.endsWith("/planning-workspace") && (init?.method ?? "GET") === "GET") return read(path)
    const mutation = { path, method: init?.method ?? "GET", body: JSON.parse(String(init?.body ?? "{}")) as Mutation["body"] }
    mutations.push(mutation)
    return respond(mutation)
  }))
  return mutations
}

const mounted: VueWrapper[] = []

async function mountWorkspace() {
  const wrapper = mount(V3VtlPlanningWorkspace, {
    props: {
      user: { id: "student-1", email: "student@example.com", displayName: "学生", role: "student" },
      project: { id: "project-1", sceneType: "VTOL_INSPECTION", assessmentTiming: { canWrite: true } } as StudentProjectView,
      stage: { stageCode: "VTL_ROUTE_PLANNING", title: "航线规划", status: "IN_PROGRESS", revision: 1, allowedActions: [] } as never,
      region,
      mainLandingSiteId: "main-1",
      visibleLayers: [],
      mapMode: "2d"
    },
    global: { directives: { loading: {} }, stubs: { "el-icon": { template: "<i><slot /></i>" } } }
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}

function command(wrapper: VueWrapper, label: string) {
  const button = wrapper.findAll(".vtl-command-actions button").find((item) => item.text() === label)
  if (!button) throw new Error(`Missing command: ${label}`)
  return button
}

function transitionHeight(wrapper: VueWrapper) {
  return wrapper.get<HTMLInputElement>(".route-parameters input")
}

function aircraftSelect(wrapper: VueWrapper) {
  return wrapper.get<HTMLSelectElement>(".vtl-panel > select")
}

function mapProps(wrapper: VueWrapper) {
  return wrapper.getComponent(V3UnifiedMap).props() as unknown as {
    vtlPlan: VtlPlanningWorkspaceView["plan"]
    vtlSelectedAircraftId: string
  }
}

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("V3VtlPlanningWorkspace draft navigation and completion", () => {
  it("keeps the aircraft and draft after cancelling a switch, then switches after confirmation", async () => {
    const mutations = mockRequests(() => { throw new Error("Switching aircraft must not write a plan") })
    const confirm = vi.spyOn(ElMessageBox, "confirm").mockRejectedValueOnce("cancel").mockResolvedValueOnce(undefined as never)
    const wrapper = await mountWorkspace()
    await transitionHeight(wrapper).setValue("125")
    expect(wrapper.find(".unsaved-state").exists()).toBe(true)

    await aircraftSelect(wrapper).setValue("aircraft-b")
    await flushPromises()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(aircraftSelect(wrapper).element.value).toBe("aircraft-a")
    expect(transitionHeight(wrapper).element.value).toBe("125")
    expect(wrapper.find(".unsaved-state").exists()).toBe(true)

    await aircraftSelect(wrapper).setValue("aircraft-b")
    await flushPromises()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(aircraftSelect(wrapper).element.value).toBe("aircraft-b")
    expect(transitionHeight(wrapper).element.value).toBe("90")
    expect(wrapper.find(".unsaved-state").exists()).toBe(false)
    expect(mutations).toHaveLength(0)
  })

  it("applies the same cancellation and confirmation guard to aircraft selected on the map", async () => {
    const mutations = mockRequests(() => { throw new Error("Selecting an aircraft must not write a plan") })
    const confirm = vi.spyOn(ElMessageBox, "confirm").mockRejectedValueOnce("cancel").mockResolvedValueOnce(undefined as never)
    const wrapper = await mountWorkspace()
    const map = wrapper.getComponent(V3UnifiedMap)
    await transitionHeight(wrapper).setValue("125")

    map.vm.$emit("vtl-aircraft-select", "aircraft-b")
    await flushPromises()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(aircraftSelect(wrapper).element.value).toBe("aircraft-a")
    expect(transitionHeight(wrapper).element.value).toBe("125")
    expect(mapProps(wrapper).vtlSelectedAircraftId).toBe("aircraft-a")

    map.vm.$emit("vtl-aircraft-select", "aircraft-b")
    await flushPromises()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(aircraftSelect(wrapper).element.value).toBe("aircraft-b")
    expect(transitionHeight(wrapper).element.value).toBe("90")
    expect(mapProps(wrapper).vtlSelectedAircraftId).toBe("aircraft-b")
    expect(wrapper.find(".unsaved-state").exists()).toBe(false)
    expect(mutations).toHaveLength(0)
  })

  it("preserves edited route fields when the same project's stage revision refreshes", async () => {
    let readCalls = 0
    const mutations = mockRequests(
      () => { throw new Error("A stage refresh must not save a draft") },
      () => Promise.resolve(jsonResponse(++readCalls === 1 ? workspace() : workspace(8, 60)))
    )
    const wrapper = await mountWorkspace()
    await transitionHeight(wrapper).setValue("125")
    await wrapper.setProps({ stage: { ...wrapper.props("stage"), revision: 2 } })
    await flushPromises()

    expect(transitionHeight(wrapper).element.value).toBe("125")
    expect(wrapper.find(".unsaved-state").exists()).toBe(true)
    expect(aircraftSelect(wrapper).element.value).toBe("aircraft-a")
    expect(mutations).toHaveLength(0)
  })

  it("loads a different project even when the previous project has unsaved edits", async () => {
    const loadedPaths: string[] = []
    mockRequests(
      () => { throw new Error("Changing project must not write the previous draft") },
      (path) => {
        loadedPaths.push(path)
        return Promise.resolve(jsonResponse(path.includes("/project-2/") ? workspace(20, 160, "project-2") : workspace()))
      }
    )
    const wrapper = await mountWorkspace()
    await transitionHeight(wrapper).setValue("125")
    await wrapper.setProps({ project: { ...wrapper.props("project"), id: "project-2" } })
    await flushPromises()

    expect(loadedPaths).toHaveLength(2)
    expect(loadedPaths[1]).toMatch(/\/project-2\/planning-workspace$/)
    expect(mapProps(wrapper).vtlPlan.projectId).toBe("project-2")
    expect(transitionHeight(wrapper).element.value).toBe("160")
    expect(wrapper.find(".unsaved-state").exists()).toBe(false)
  })

  it("ignores the previous project's delayed save and does not complete the new project", async () => {
    const pendingSave = deferredResponse()
    const mutations = mockRequests(
      () => pendingSave.promise,
      (path) => Promise.resolve(jsonResponse(path.includes("/project-2/") ? workspace(20, 160, "project-2") : workspace()))
    )
    const wrapper = await mountWorkspace()
    await transitionHeight(wrapper).setValue("125")
    await command(wrapper, "完成航线规划").trigger("click")
    expect(mutations).toHaveLength(1)
    expect(mutations[0]!.path).toMatch(/\/project-1\/routes\/aircraft-a$/)

    await wrapper.setProps({ project: { ...wrapper.props("project"), id: "project-2" } })
    await flushPromises()
    expect(transitionHeight(wrapper).element.value).toBe("160")
    pendingSave.resolve(jsonResponse(workspace(8, 125)))
    await flushPromises()

    expect(mutations).toHaveLength(1)
    expect(mapProps(wrapper).vtlPlan.projectId).toBe("project-2")
    expect(transitionHeight(wrapper).element.value).toBe("160")
    expect(wrapper.emitted("refreshProject")).toBeUndefined()
    expect(command(wrapper, "保存航线").attributes("disabled")).toBeUndefined()
  })

  it("does not apply an aircraft confirmation that resolves after unmount", async () => {
    const pendingConfirmation = deferredConfirmation()
    const confirm = vi.spyOn(ElMessageBox, "confirm").mockReturnValue(pendingConfirmation.promise as never)
    const mutations = mockRequests(() => { throw new Error("Aircraft confirmation must not write a plan") })
    const wrapper = await mountWorkspace()
    await transitionHeight(wrapper).setValue("125")
    wrapper.getComponent(V3UnifiedMap).vm.$emit("vtl-aircraft-select", "aircraft-b")
    await flushPromises()
    expect(confirm).toHaveBeenCalledTimes(1)
    const state = wrapper.vm as unknown as { selectedAircraftId: string; routeTransitionHeight: number; draftDirty: boolean }
    wrapper.unmount()
    mounted.splice(mounted.indexOf(wrapper), 1)

    pendingConfirmation.resolve()
    await flushPromises()
    expect(state.selectedAircraftId).toBe("aircraft-a")
    expect(state.routeTransitionHeight).toBe(125)
    expect(state.draftDirty).toBe(true)
    expect(mutations).toHaveLength(0)
    expect(wrapper.emitted("refreshProject")).toBeUndefined()
  })

  it("does not apply the previous project's aircraft confirmation to the new project", async () => {
    const pendingConfirmation = deferredConfirmation()
    const confirm = vi.spyOn(ElMessageBox, "confirm").mockReturnValue(pendingConfirmation.promise as never)
    const mutations = mockRequests(
      () => { throw new Error("Aircraft confirmation must not write a plan") },
      (path) => Promise.resolve(jsonResponse(path.includes("/project-2/") ? workspace(20, 160, "project-2") : workspace()))
    )
    const wrapper = await mountWorkspace()
    await transitionHeight(wrapper).setValue("125")
    await aircraftSelect(wrapper).setValue("aircraft-b")
    await flushPromises()
    expect(confirm).toHaveBeenCalledTimes(1)

    await wrapper.setProps({ project: { ...wrapper.props("project"), id: "project-2" } })
    await flushPromises()
    expect(transitionHeight(wrapper).element.value).toBe("160")
    pendingConfirmation.resolve()
    await flushPromises()

    expect(mapProps(wrapper).vtlPlan.projectId).toBe("project-2")
    expect(aircraftSelect(wrapper).element.value).toBe("aircraft-a")
    expect(transitionHeight(wrapper).element.value).toBe("160")
    expect(wrapper.find(".unsaved-state").exists()).toBe(false)
    expect(aircraftSelect(wrapper).attributes("disabled")).toBeUndefined()
    expect(mutations).toHaveLength(0)
  })

  it("saves the edited route before completing with the revision returned by the save", async () => {
    const pendingSave = deferredResponse()
    const mutations = mockRequests(({ method, path }) => {
      if (method === "PUT" && path.endsWith("/routes/aircraft-a")) return pendingSave.promise
      if (method === "POST" && path.endsWith("/routes/complete")) return Promise.resolve(jsonResponse(workspace(9, 125)))
      throw new Error(`Unexpected mutation: ${method} ${path}`)
    })
    const wrapper = await mountWorkspace()
    await transitionHeight(wrapper).setValue("125")
    await command(wrapper, "完成航线规划").trigger("click")
    await flushPromises()

    expect(mutations).toHaveLength(1)
    expect(mutations[0]).toMatchObject({ method: "PUT", body: { expectedRevision: 7, transitionHeightMeters: 125 } })
    pendingSave.resolve(jsonResponse(workspace(8, 125)))
    await flushPromises()

    expect(mutations).toHaveLength(2)
    expect(mutations[1]).toMatchObject({ method: "POST", body: { expectedRevision: 8 } })
    expect(mutations[1]!.path).toMatch(/\/routes\/complete$/)
    expect(wrapper.emitted("refreshProject")).toHaveLength(1)
    expect(wrapper.find(".unsaved-state").exists()).toBe(false)
  })

  it("retains the draft after an offline save, does not complete, and can retry successfully", async () => {
    let saveCalls = 0
    const mutations = mockRequests(({ method, path }) => {
      if (method === "PUT" && path.endsWith("/routes/aircraft-a")) {
        saveCalls += 1
        return saveCalls === 1 ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(jsonResponse(workspace(8, 125)))
      }
      if (method === "POST" && path.endsWith("/routes/complete")) return Promise.resolve(jsonResponse(workspace(9, 125)))
      throw new Error(`Unexpected mutation: ${method} ${path}`)
    })
    const wrapper = await mountWorkspace()
    await transitionHeight(wrapper).setValue("125")
    await command(wrapper, "完成航线规划").trigger("click")
    await flushPromises()

    expect(mutations.map(({ method }) => method)).toEqual(["PUT"])
    expect(transitionHeight(wrapper).element.value).toBe("125")
    expect(wrapper.find(".unsaved-state").exists()).toBe(true)
    expect(wrapper.emitted("refreshProject")).toBeUndefined()
    expect(command(wrapper, "完成航线规划").attributes("disabled")).toBeUndefined()

    await command(wrapper, "完成航线规划").trigger("click")
    await flushPromises()
    expect(mutations.map(({ method }) => method)).toEqual(["PUT", "PUT", "POST"])
    expect(mutations[1]!.body).toMatchObject({ expectedRevision: 7, transitionHeightMeters: 125 })
    expect(mutations[2]!.body.expectedRevision).toBe(8)
    expect(wrapper.emitted("refreshProject")).toHaveLength(1)
  })

  it("prevents duplicate saves and completion while a standalone save is pending", async () => {
    const pendingSave = deferredResponse()
    const mutations = mockRequests(() => pendingSave.promise)
    const wrapper = await mountWorkspace()
    await transitionHeight(wrapper).setValue("125")
    await command(wrapper, "保存航线").trigger("click")
    await command(wrapper, "保存航线").trigger("click")
    await command(wrapper, "完成航线规划").trigger("click")
    await flushPromises()
    expect(mutations).toHaveLength(1)
    expect(mutations[0]!.method).toBe("PUT")

    pendingSave.resolve(jsonResponse(workspace(8, 125)))
    await flushPromises()
    expect(mutations).toHaveLength(1)
    expect(transitionHeight(wrapper).element.value).toBe("125")
    expect(wrapper.find(".unsaved-state").exists()).toBe(false)
  })

  it("keeps save and complete mutually exclusive throughout both requests", async () => {
    const pendingSave = deferredResponse()
    const pendingComplete = deferredResponse()
    const mutations = mockRequests(({ method }) => method === "PUT" ? pendingSave.promise : pendingComplete.promise)
    const wrapper = await mountWorkspace()
    await transitionHeight(wrapper).setValue("125")
    await command(wrapper, "完成航线规划").trigger("click")
    await command(wrapper, "完成航线规划").trigger("click")
    await command(wrapper, "保存航线").trigger("click")
    expect(mutations.map(({ method }) => method)).toEqual(["PUT"])

    pendingSave.resolve(jsonResponse(workspace(8, 125)))
    await flushPromises()
    expect(mutations.map(({ method }) => method)).toEqual(["PUT", "POST"])
    await command(wrapper, "完成航线规划").trigger("click")
    await command(wrapper, "保存航线").trigger("click")
    expect(mutations.map(({ method }) => method)).toEqual(["PUT", "POST"])

    pendingComplete.resolve(jsonResponse(workspace(9, 125)))
    await flushPromises()
    expect(wrapper.emitted("refreshProject")).toHaveLength(1)
  })

  it("does not complete or refresh the parent after an outstanding save resolves following unmount", async () => {
    const pendingSave = deferredResponse()
    const mutations = mockRequests(() => pendingSave.promise)
    const wrapper = await mountWorkspace()
    await transitionHeight(wrapper).setValue("125")
    await command(wrapper, "完成航线规划").trigger("click")
    expect(mutations.map(({ method }) => method)).toEqual(["PUT"])
    wrapper.unmount()
    mounted.splice(mounted.indexOf(wrapper), 1)

    pendingSave.resolve(jsonResponse(workspace(8, 125)))
    await flushPromises()
    expect(mutations.map(({ method }) => method)).toEqual(["PUT"])
    expect(wrapper.emitted("refreshProject")).toBeUndefined()
  })

  it("does not emit a stale refresh when completion resolves after unmount", async () => {
    const pendingComplete = deferredResponse()
    const mutations = mockRequests(({ method }) => method === "PUT" ? Promise.resolve(jsonResponse(workspace(8, 125))) : pendingComplete.promise)
    const wrapper = await mountWorkspace()
    await transitionHeight(wrapper).setValue("125")
    await command(wrapper, "完成航线规划").trigger("click")
    await flushPromises()
    expect(mutations.map(({ method }) => method)).toEqual(["PUT", "POST"])
    wrapper.unmount()
    mounted.splice(mounted.indexOf(wrapper), 1)

    pendingComplete.resolve(jsonResponse(workspace(9, 125)))
    await flushPromises()
    expect(wrapper.emitted("refreshProject")).toBeUndefined()
  })
})
