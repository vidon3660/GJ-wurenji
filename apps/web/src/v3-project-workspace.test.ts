// @vitest-environment jsdom

import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { QuestionnaireView } from "@wurenji/shared"

// The workspace delegates map rendering to Cesium. Keep this interaction test
// focused on the request guard and avoid creating a WebGL context in jsdom.
vi.mock("./components/V3UnifiedMap.vue", () => ({ default: { template: "<div class=\"map-stub\" />" } }))

import V3ProjectWorkspaceView from "./components/V3ProjectWorkspaceView.vue"

const project = {
  id: "project-1",
  assignmentSnapshotId: "snapshot-1",
  title: "垂起巡检实训",
  sceneType: "VTOL_INSPECTION",
  mode: "PRACTICE",
  assignmentStatus: "PUBLISHED",
  isDemo: false,
  isAcceptanceData: false,
  status: "IN_PROGRESS",
  currentStageCode: "VTL_REVIEW",
  stages: [{ stageCode: "VTL_REVIEW", sequence: 1, title: "运行结果", description: "查看运行结果", openCondition: "完成运行", status: "LOCKED", revision: 1, allowedActions: [] }],
  assessmentAttempt: { attemptNumber: 1, isRetake: false, retakeOfProjectId: null, retakeReason: null, retakeCreatedAt: null },
  assessmentTiming: {
    state: "NOT_APPLICABLE",
    durationMinutes: null,
    availableAt: "2026-01-01T00:00:00.000Z",
    assignmentDueAt: "2026-12-31T00:00:00.000Z",
    startedAt: null,
    deadlineAt: null,
    submittedAt: null,
    endedAt: null,
    serverNow: "2026-01-01T00:00:00.000Z",
    remainingMs: null,
    canStart: false,
    canWrite: true,
    blockedReason: null
  },
  lastActivityAt: "2026-01-01T00:00:00.000Z"
} as const

const snapshot = {
  id: "snapshot-1",
  draftId: "draft-1",
  schemaVersion: 3,
  title: "垂起巡检实训",
  sceneType: "VTOL_INSPECTION",
  mode: "PRACTICE",
  isDemo: false,
  isAcceptanceData: false,
  config: { questionBankVersionId: "bank-version-1", regionPackageId: "region-1", taskBrief: "完成巡检航线设计" },
  resourceRefs: [],
  resourceRevision: 1,
  mapResourceVersion: "map-v1",
  sceneResourceVersion: "scene-v1",
  planVersion: "plan-v1",
  checksum: "checksum",
  publishedAt: "2026-01-01T00:00:00.000Z"
} as const

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
