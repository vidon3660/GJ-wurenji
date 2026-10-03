import { EventEmitter } from "node:events"
import type { Request, Response } from "express"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parseLastEventId, runtimeWorkspaceFingerprint, streamRuntimeWorkspace } from "./runtime-stream.js"

afterEach(() => {
  vi.useRealTimers()
})

describe("runtime stream protocol", () => {
  it("accepts only positive safe revision ids for resume", () => {
    expect(parseLastEventId("12")).toBe(12)
    expect(parseLastEventId(["7"])).toBe(7)
    expect(parseLastEventId(undefined)).toBeNull()
    expect(parseLastEventId("0")).toBeNull()
    expect(parseLastEventId("12.5")).toBeNull()
    expect(parseLastEventId(String(Number.MAX_SAFE_INTEGER + 1))).toBeNull()
  })

  it("carries Last-Event-ID into the resumed snapshot envelope", async () => {
    const connection = fakeConnection({ "last-event-id": "2" })
    await streamRuntimeWorkspace(connection.request, connection.response, "resume:project-1", async () => ({
      projectId: "project-1",
      session: { revision: 4, simulationTimeMs: 4_000, status: "RUNNING" }
    }))

    expect(connection.frames[0]).toContain('"resumedFromRevision":2')
    connection.events.emit("close")
  })

  it("publishes clock progress even when the semantic revision is unchanged", () => {
    expect(runtimeWorkspaceFingerprint({ session: { revision: 4, simulationTimeMs: 1_000, status: "RUNNING" } }))
      .not.toBe(runtimeWorkspaceFingerprint({ session: { revision: 4, simulationTimeMs: 2_000, status: "RUNNING" } }))
    expect(runtimeWorkspaceFingerprint({ session: { revision: 4, simulationTimeMs: 2_000, status: "RUNNING" } }))
      .not.toBe(runtimeWorkspaceFingerprint({ session: { revision: 4, simulationTimeMs: 2_000, status: "PAUSED" } }))
  })

  it("publishes assessment deadline changes without a session revision", async () => {
    vi.useFakeTimers()
    let writable = true
    const connection = fakeConnection()
    const loadWorkspace = async () => ({
      projectId: "assessment-project",
      session: { revision: 4, simulationTimeMs: 2_000, status: "PAUSED" },
      canStart: writable,
      canControl: writable
    })

    await streamRuntimeWorkspace(connection.request, connection.response, "assessment-deadline:project", loadWorkspace)
    writable = false
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)

    const snapshots = connection.frames.filter((frame) => frame.includes("event: snapshot"))
    expect(snapshots).toHaveLength(2)
    expect(snapshots[1]).toContain('"canControl":false')
    expect(snapshots[1]).toContain('"canStart":false')
    connection.events.emit("close")
  })

  it("refreshes the first frame for a reconnect while another subscriber keeps the stream alive", async () => {
    let loadCount = 0
    const loadWorkspace = async () => ({
      projectId: "resume-project",
      session: { revision: ++loadCount, simulationTimeMs: loadCount * 1_000, status: "RUNNING" }
    })
    const active = fakeConnection()
    await streamRuntimeWorkspace(active.request, active.response, "resume-shared:project", loadWorkspace)

    const reconnect = fakeConnection({ "last-event-id": "1" })
    await streamRuntimeWorkspace(reconnect.request, reconnect.response, "resume-shared:project", loadWorkspace)

    expect(loadCount).toBe(2)
    expect(reconnect.frames[0]).toContain('"simulationTimeMs":2000')
    expect(reconnect.frames[0]).toContain('"resumedFromRevision":1')
    active.events.emit("close")
    reconnect.events.emit("close")
  })

  it("shares one workspace refresh across concurrent subscribers", async () => {
    vi.useFakeTimers()
    let loadCount = 0
    const loadWorkspace = async () => ({
      projectId: "project-1",
      session: { revision: 3, simulationTimeMs: ++loadCount * 1_000, status: "RUNNING" }
    })
    const first = fakeConnection()
    const second = fakeConnection()

    await streamRuntimeWorkspace(first.request, first.response, "show:project-1:user-1", loadWorkspace)
    await streamRuntimeWorkspace(second.request, second.response, "show:project-1:user-1", loadWorkspace)
    expect(loadCount).toBe(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(loadCount).toBe(2)
    expect(first.frames.filter((frame) => frame.includes("event: snapshot"))).toHaveLength(2)
    expect(second.frames.filter((frame) => frame.includes("event: snapshot"))).toHaveLength(2)
    expect(first.frames[0]).toContain('"contractProtocol":"wurenji-runtime-contract-v1"')
    expect(first.frames[0]).toContain('"messageType":"SNAPSHOT"')

    first.events.emit("close")
    second.events.emit("close")
  })

  it("does not let an old poll dispose a stream created after reconnect", async () => {
    vi.useFakeTimers()
    let loadCount = 0
    let resolveOldPoll: ((workspace: { projectId: string; session: { revision: number; simulationTimeMs: number; status: string } }) => void) | null = null
    const loadWorkspace = async () => {
      loadCount += 1
      if (loadCount === 2) {
        return await new Promise<{ projectId: string; session: { revision: number; simulationTimeMs: number; status: string } }>((resolve) => {
          resolveOldPoll = resolve
        })
      }
      return { projectId: "project-1", session: { revision: loadCount, simulationTimeMs: loadCount * 1_000, status: "RUNNING" } }
    }
    const first = fakeConnection()
    await streamRuntimeWorkspace(first.request, first.response, "show:project-1:user-1", loadWorkspace)
    await vi.advanceTimersByTimeAsync(1_000)
    first.events.emit("close")

    const second = fakeConnection()
    await streamRuntimeWorkspace(second.request, second.response, "show:project-1:user-1", loadWorkspace)
    expect(loadCount).toBe(3)
    resolveOldPoll?.({ projectId: "project-1", session: { revision: 4, simulationTimeMs: 4_000, status: "RUNNING" } })
    await vi.advanceTimersByTimeAsync(1_000)

    expect(loadCount).toBe(4)
    expect(second.frames.filter((frame) => frame.includes("event: snapshot"))).toHaveLength(2)
    second.events.emit("close")
  })

  it("deduplicates concurrent initial workspace loads for one stream key", async () => {
    vi.useFakeTimers()
    let loadCount = 0
    let releaseInitial: (() => void) | null = null
    const loadWorkspace = async () => {
      loadCount += 1
      if (loadCount === 1) await new Promise<void>((resolve) => { releaseInitial = resolve })
      return { projectId: "project-1", session: { revision: loadCount, simulationTimeMs: loadCount * 1_000, status: "RUNNING" } }
    }
    const first = fakeConnection()
    const second = fakeConnection()
    const firstPromise = streamRuntimeWorkspace(first.request, first.response, "initial-race:project-1", loadWorkspace)
    const secondPromise = streamRuntimeWorkspace(second.request, second.response, "initial-race:project-1", loadWorkspace)
    await Promise.resolve()
    expect(loadCount).toBe(1)
    releaseInitial?.()
    await Promise.all([firstPromise, secondPromise])
    expect(loadCount).toBe(1)
    expect(first.frames.filter((frame) => frame.includes("event: snapshot"))).toHaveLength(1)
    expect(second.frames.filter((frame) => frame.includes("event: snapshot"))).toHaveLength(1)
    first.events.emit("close")
    second.events.emit("close")
  })

  it("does not register a request that closes while the initial workspace loads", async () => {
    let releaseInitial: (() => void) | null = null
    const loadWorkspace = async () => {
      await new Promise<void>((resolve) => { releaseInitial = resolve })
      return { projectId: "project-1", session: { revision: 1, simulationTimeMs: 0, status: "RUNNING" } }
    }
    const connection = fakeConnection()
    const pending = streamRuntimeWorkspace(connection.request, connection.response, "closed-initial:project-1", loadWorkspace)
    connection.request.destroyed = true
    releaseInitial?.()
    await pending
    expect(connection.frames).toHaveLength(0)
    expect(connection.response.write).not.toHaveBeenCalled()
  })

  it("publishes incremental state, event, action and completion messages alongside snapshots", async () => {
    vi.useFakeTimers()
    let loadCount = 0
    const loadWorkspace = async () => {
      loadCount += 1
      return {
        projectId: "project-1",
        session: { revision: loadCount, simulationTimeMs: loadCount * 1_000, status: loadCount === 1 ? "RUNNING" : "COMPLETED" },
        events: loadCount === 1 ? [] : [{ id: "event-1", status: "ACTIVE" }],
        actions: loadCount === 1 ? [] : [{ id: "action-1", status: "APPLIED" }]
      }
    }
    const connection = fakeConnection()
    await streamRuntimeWorkspace(connection.request, connection.response, "show:project-1:user-2", loadWorkspace)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(connection.frames.some((frame) => frame.includes("event: state-delta") && frame.includes('"messageType":"STATE_DELTA"'))).toBe(true)
    expect(connection.frames.some((frame) => frame.includes("event: event") && frame.includes('"messageType":"EVENT"'))).toBe(true)
    expect(connection.frames.some((frame) => frame.includes("event: action-result") && frame.includes('"messageType":"ACTION_RESULT"'))).toBe(true)
    expect(connection.frames.some((frame) => frame.includes("event: completed") && frame.includes('"messageType":"COMPLETED"'))).toBe(true)
    connection.events.emit("close")
  })

  it("emits a structured error and closes subscribers when workspace polling fails", async () => {
    vi.useFakeTimers()
    let loadCount = 0
    const connection = fakeConnection()
    await streamRuntimeWorkspace(connection.request, connection.response, "failure:project-1", async () => {
      loadCount += 1
      if (loadCount > 1) throw new Error("database unavailable")
      return { projectId: "project-1", session: { revision: 1, simulationTimeMs: 0, status: "RUNNING" } }
    })

    await vi.advanceTimersByTimeAsync(1_000)

    const errorFrame = connection.frames.find((frame) => frame.includes("event: stream-error"))
    expect(errorFrame).toContain('"messageType":"ERROR"')
    expect(errorFrame).toContain('"code":"INVALID_PAYLOAD"')
    expect(connection.response.end).toHaveBeenCalledOnce()
    connection.events.emit("close")
  })

  it("isolates ten concurrent stream keys while polling in one scheduler turn", async () => {
    vi.useFakeTimers()
    const connections = await Promise.all(Array.from({ length: 10 }, async (_, index) => {
      let revision = 1
      const connection = fakeConnection()
      const loadWorkspace = async () => ({
        projectId: `i2-stream-project-${index + 1}`,
        session: { revision, simulationTimeMs: revision * 1_000, status: "RUNNING" }
      })
      await streamRuntimeWorkspace(connection.request, connection.response, `i2-stream:${index + 1}`, loadWorkspace)
      revision = 2
      return connection
    }))

    await vi.advanceTimersByTimeAsync(1_000)

    expect(connections.every((connection) => connection.frames.filter((frame) => frame.includes("event: snapshot")).length === 2)).toBe(true)
    expect(connections.every((connection, index) => connection.frames
      .filter((frame) => frame.includes("i2-stream-project-"))
      .every((frame) => frame.includes(`i2-stream-project-${index + 1}`)))).toBe(true)
    for (const connection of connections) connection.events.emit("close")
  })
})

function fakeConnection(headers: Record<string, string> = {}) {
  const events = new EventEmitter()
  const frames: string[] = []
  const request = Object.assign(events, { headers, destroyed: false }) as unknown as Request
  const response = {
    statusCode: 0,
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((frame: string) => { frames.push(frame); return true }),
    end: vi.fn()
  } as unknown as Response
  return { events, request, response, frames }
}
