// @vitest-environment jsdom

import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ElMessageBox } from "element-plus"
import type { ShowFlightEndReportView, StudentProjectView } from "@wurenji/shared"
import V3ShowFlightEndWorkspace from "./components/V3ShowFlightEndWorkspace.vue"

const project = {
  id: "project-1",
  assessmentTiming: { canWrite: true }
} as unknown as StudentProjectView

const report = {
  status: "DRAFT",
  canSubmit: true,
  revision: 1,
  completionStatus: "NORMAL",
  normalLandedCount: 1,
  abnormalCount: 0,
  abnormalDescription: "",
  plannedCount: 1,
  actualTakeoffCount: 1,
  suggestedNormalLandedCount: 1,
  suggestedAbnormalCount: 0,
  actualTakeoffAt: null,
  landingCompletedAt: null,
  answerCorrect: null,
  authoritativeNormalLandedCount: null,
  authoritativeAbnormalCount: null,
  submittedAt: null,
  submittedBy: null
} as unknown as ShowFlightEndReportView

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } })
}

describe("V3ShowFlightEndWorkspace submission controls", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("prevents duplicate draft saves while the request is pending", async () => {
    let saveCalls = 0
    let resolveSave!: (response: Response) => void
    const saveRequest = new Promise<Response>((resolve) => { resolveSave = resolve })
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.endsWith("/flight-end-report") && (init?.method ?? "GET") === "GET") return Promise.resolve(jsonResponse(report))
      if (path.endsWith("/flight-end-report/submit")) throw new Error(`Unexpected submit request: ${path}`)
      if (path.includes("/flight-end-report")) {
        saveCalls += 1
        return saveRequest
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const wrapper = mount(V3ShowFlightEndWorkspace, {
      props: {
        user: { id: "student-1", email: "student@example.com", displayName: "学生", role: "student" },
        project,
        stage: { stageCode: "SHOW_FLIGHT_END_REPORT", revision: 1 } as never
      },
      global: {
        directives: { loading: {} },
        stubs: {
          "el-button": true,
          "el-icon": true,
          "el-input": true,
          "el-input-number": true,
          "el-tag": true
        }
      }
    })
    await flushPromises()

    const footerButtons = wrapper.findAll("el-button-stub")
    const saveButton = footerButtons.at(1)
    const submitButton = footerButtons.at(2)
    expect(saveButton).toBeDefined()
    expect(submitButton).toBeDefined()
    await saveButton!.trigger("click")
    await flushPromises()
    expect(saveCalls).toBe(1)
    expect(saveButton!.attributes("disabled")).toBeDefined()
    expect(submitButton!.attributes("disabled")).toBeDefined()

    await saveButton!.trigger("click")
    expect(saveCalls).toBe(1)

    resolveSave(jsonResponse(report))
    await flushPromises()
    expect(saveButton!.attributes("disabled")).toBe("false")
    expect(submitButton!.attributes("disabled")).toBe("false")
    wrapper.unmount()
  })

  it("prevents duplicate submissions after confirmation", async () => {
    // The production code only needs the resolved/cancelled distinction; the
    // Element Plus declaration models the resolved payload as an overloaded
    // intersection, so keep the test result intentionally payload-free.
    vi.spyOn(ElMessageBox, "confirm").mockResolvedValue(undefined as never)
    let submitCalls = 0
    let resolveSubmit!: (response: Response) => void
    const submitRequest = new Promise<Response>((resolve) => { resolveSubmit = resolve })
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.endsWith("/flight-end-report") && (init?.method ?? "GET") === "GET") return Promise.resolve(jsonResponse(report))
      if (path.endsWith("/flight-end-report/submit")) {
        submitCalls += 1
        return submitRequest
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const wrapper = mount(V3ShowFlightEndWorkspace, {
      props: {
        user: { id: "student-1", email: "student@example.com", displayName: "学生", role: "student" },
        project,
        stage: { stageCode: "SHOW_FLIGHT_END_REPORT", revision: 1 } as never
      },
      global: {
        directives: { loading: {} },
        stubs: { "el-button": true, "el-icon": true, "el-input": true, "el-input-number": true, "el-tag": true }
      }
    })
    await flushPromises()

    const submitButton = wrapper.findAll("el-button-stub").at(2)!
    await submitButton.trigger("click")
    await flushPromises()
    expect(submitCalls).toBe(1)
    expect(submitButton.attributes("disabled")).toBe("true")

    await submitButton.trigger("click")
    expect(submitCalls).toBe(1)

    resolveSubmit(jsonResponse({ ...report, status: "SUBMITTED", canSubmit: false }))
    await flushPromises()
    wrapper.unmount()
  })
})
