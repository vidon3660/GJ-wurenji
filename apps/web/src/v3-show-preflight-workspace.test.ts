// @vitest-environment jsdom

import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ShowPreflightWorkspaceView, StudentProjectView } from "@wurenji/shared"
import V3ShowPreflightWorkspace from "./components/V3ShowPreflightWorkspace.vue"

const project = {
  id: "project-1",
  assessmentTiming: { canWrite: true }
} as unknown as StudentProjectView

const workspace: ShowPreflightWorkspaceView = {
  projectId: "project-1",
  canEdit: true,
  revision: 7,
  status: "DRAFT",
  items: [{
    code: "AIRCRAFT_001",
    category: "AIRCRAFT",
    title: "机组状态",
    detail: "设备状态正常",
    sourceStatus: "NORMAL",
    affectedCount: 0,
    confirmed: true,
    resolution: "CONFIRMED",
    resolved: true,
    note: "服务器值"
  }],
  decision: "ALLOW",
  rationale: "检查项已确认，满足起飞条件",
  completedAt: null,
  updatedAt: null
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } })
}

function mountWorkspace() {
  return mount(V3ShowPreflightWorkspace, {
    props: {
      user: { id: "student-1", email: "student@example.com", displayName: "学生", role: "student" },
      project,
      stage: { stageCode: "SHOW_PREFLIGHT", revision: 1 } as never
    },
    global: {
      directives: { loading: {} },
      stubs: {
        "el-button": { props: ["disabled", "loading"], emits: ["click"], template: "<button :disabled=\"disabled\" @click=\"$emit('click')\"><slot /></button>" },
        "el-checkbox": { props: ["modelValue", "disabled"], template: "<input type=\"checkbox\" :disabled=\"disabled\" :checked=\"modelValue\" />" },
        "el-input": { props: ["modelValue", "disabled"], template: "<textarea :disabled=\"disabled\" :value=\"modelValue\" />" },
        "el-select": { props: ["modelValue", "disabled"], template: "<select :disabled=\"disabled\"><slot /></select>" },
        "el-option": { template: "<option><slot /></option>" },
        "el-radio-group": { props: ["modelValue", "disabled"], template: "<div><slot /></div>" },
        "el-radio-button": { template: "<button><slot /></button>" },
        "el-icon": { template: "<i><slot /></i>" }
      }
    }
  })
}

describe("V3ShowPreflightWorkspace save and complete flow", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("keeps edited values and does not complete when saving fails", async () => {
    let putCalls = 0
    let postCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.endsWith("/preflight") && (init?.method ?? "GET") === "GET") return Promise.resolve(jsonResponse(workspace))
      if (path.endsWith("/preflight") && init?.method === "PUT") {
        putCalls += 1
        return Promise.reject(new Error("保存失败"))
      }
      if (path.endsWith("/preflight/complete")) {
        postCalls += 1
        return Promise.resolve(jsonResponse(workspace))
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const wrapper = mountWorkspace()
    await flushPromises()
    const vm = wrapper.vm as unknown as { items: Array<{ note: string }> }
    vm.items[0]!.note = "用户修改值"
    await wrapper.findAll("button").find((button) => button.text().includes("完成飞前准备"))!.trigger("click")
    await flushPromises()

    expect(putCalls).toBe(1)
    expect(postCalls).toBe(0)
    expect(vm.items[0]!.note).toBe("用户修改值")
    wrapper.unmount()
  })

  it("uses the revision returned by the successful save before completing", async () => {
    let putBody: { expectedRevision?: number } | undefined
    let completeBody: { expectedRevision?: number } | undefined
    const saved = { ...workspace, revision: 8 }
    const completed = { ...saved, revision: 9, status: "COMPLETED" as const, completedAt: "2026-10-04T10:00:00.000Z" }
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.endsWith("/preflight") && (init?.method ?? "GET") === "GET") return Promise.resolve(jsonResponse(workspace))
      if (path.endsWith("/preflight") && init?.method === "PUT") {
        putBody = JSON.parse(String(init.body)) as { expectedRevision?: number }
        return Promise.resolve(jsonResponse(saved))
      }
      if (path.endsWith("/preflight/complete")) {
        completeBody = JSON.parse(String(init?.body)) as { expectedRevision?: number }
        return Promise.resolve(jsonResponse(completed))
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const wrapper = mountWorkspace()
    await flushPromises()
    await wrapper.findAll("button").find((button) => button.text().includes("完成飞前准备"))!.trigger("click")
    await flushPromises()

    expect(putBody?.expectedRevision).toBe(7)
    expect(completeBody?.expectedRevision).toBe(8)
    wrapper.unmount()
  })

  it("ignores a second complete click while saving or completing", async () => {
    let putCalls = 0
    let postCalls = 0
    let resolvePut!: (response: Response) => void
    const putRequest = new Promise<Response>((resolve) => { resolvePut = resolve })
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.endsWith("/preflight") && (init?.method ?? "GET") === "GET") return Promise.resolve(jsonResponse(workspace))
      if (path.endsWith("/preflight") && init?.method === "PUT") {
        putCalls += 1
        return putRequest
      }
      if (path.endsWith("/preflight/complete")) {
        postCalls += 1
        return Promise.resolve(jsonResponse({ ...workspace, revision: 9, status: "COMPLETED" }))
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const wrapper = mountWorkspace()
    await flushPromises()
    const completeButton = wrapper.findAll("button").find((button) => button.text().includes("完成飞前准备"))!
    await completeButton.trigger("click")
    await completeButton.trigger("click")
    expect(putCalls).toBe(1)
    expect(postCalls).toBe(0)

    resolvePut(jsonResponse({ ...workspace, revision: 8 }))
    await flushPromises()
    expect(postCalls).toBe(1)
    wrapper.unmount()
  })
})
