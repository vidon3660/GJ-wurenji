import { afterEach, describe, expect, it, vi } from "vitest"
import { openRuntimeStream } from "./runtime-stream"
import { apiBaseUrl } from "./api"

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  readonly options: EventSourceInit
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  private readonly listeners = new Map<string, Array<(event: Event) => void>>()
  removedListeners: Array<{ type: string; listener: (event: Event) => void }> = []

  constructor(url: string, options: EventSourceInit) {
    this.url = url
    this.options = options
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: Event) => void) {
    this.removedListeners.push({ type, listener })
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener))
  }

  close() {}

  open() { this.onopen?.() }

  emitSnapshot(value: unknown) {
    for (const listener of this.listeners.get("snapshot") ?? []) listener(new MessageEvent("snapshot", { data: JSON.stringify(value) }))
  }

  emitStreamError(value: unknown) {
    for (const listener of this.listeners.get("stream-error") ?? []) listener(new MessageEvent("stream-error", { data: JSON.stringify(value) }))
  }

  emit(type: string, value: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data: JSON.stringify(value) }))
  }

  fail() { this.onerror?.() }
}

afterEach(() => {
  FakeEventSource.instances = []
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("runtime stream client", () => {
  it("opens credentialed SSE and applies versioned snapshots", () => {
    vi.stubGlobal("EventSource", FakeEventSource)
    const states: string[] = []
    const snapshots: unknown[] = []
    const controller = openRuntimeStream<{ status: string }>(
      "/v3/show-projects/project-1/runtime/stream",
      (snapshot) => snapshots.push(snapshot),
      (state) => states.push(state),
      vi.fn()
    )
    const source = FakeEventSource.instances[0]!
    expect(source.url).toBe(apiBaseUrl("/v3/show-projects/project-1/runtime/stream"))
    expect(source.options).toEqual({ withCredentials: true })
    source.open()
    source.emitSnapshot({ protocol: "wurenji-runtime-stream-v1", revision: 4, resumedFromRevision: 2, workspace: { status: "RUNNING" } })

    expect(states).toEqual(["CONNECTING", "LIVE"])
    expect(snapshots).toEqual([{ protocol: "wurenji-runtime-stream-v1", revision: 4, resumedFromRevision: 2, workspace: { status: "RUNNING" } }])
    controller.close()
    expect(states.at(-1)).toBe("CLOSED")
    expect(source.removedListeners).toHaveLength(6)
    expect(source.onopen).toBeNull()
    expect(source.onerror).toBeNull()
    source.emitSnapshot({ protocol: "wurenji-runtime-stream-v1", revision: 5, resumedFromRevision: 4, workspace: { status: "RUNNING" } })
    expect(snapshots).toHaveLength(1)
  })

  it("surfaces structured server stream errors without dropping the current workspace", () => {
    vi.stubGlobal("EventSource", FakeEventSource)
    const errors: unknown[] = []
    const states: string[] = []
    const fallback = vi.fn()
    const controller = openRuntimeStream("/stream", vi.fn(), (state) => states.push(state), fallback, (error) => errors.push(error))
    const source = FakeEventSource.instances[0]!
    source.emitStreamError({
      contractProtocol: "wurenji-runtime-contract-v1",
      messageType: "ERROR",
      error: { code: "INVALID_PAYLOAD", message: "stream failed", requestId: null, sessionId: null, revision: null, details: { streamCode: "RUNTIME_STREAM_READ_FAILED" } }
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ error: { code: "INVALID_PAYLOAD", message: "stream failed" } })
    expect(states).toEqual(["CONNECTING", "RECONNECTING", "FALLBACK"])
    controller.close()
  })

  it("surfaces incremental runtime messages with revision ordering", () => {
    vi.stubGlobal("EventSource", FakeEventSource)
    const messages: unknown[] = []
    const controller = openRuntimeStream("/stream", vi.fn(), vi.fn(), vi.fn(), undefined, (message) => messages.push(message))
    const source = FakeEventSource.instances[0]!
    source.emit("state-delta", { messageType: "STATE_DELTA", revision: 3, simulationTimeMs: 1_000, changes: { status: "RUNNING" } })
    source.emit("completed", { messageType: "COMPLETED", revision: 2, session: { status: "COMPLETED" } })
    source.emit("action-result", { messageType: "ACTION_RESULT", revision: 4, action: { id: "action-1" } })

    expect(messages).toEqual([
      { messageType: "STATE_DELTA", revision: 3, simulationTimeMs: 1_000, changes: { status: "RUNNING" } },
      { messageType: "ACTION_RESULT", revision: 4, action: { id: "action-1" } }
    ])
    controller.close()
  })

  it("uses a low-frequency HTTP fallback while the stream reconnects", () => {
    vi.useFakeTimers()
    vi.stubGlobal("EventSource", FakeEventSource)
    const fallback = vi.fn()
    const states: string[] = []
    const controller = openRuntimeStream("/stream", vi.fn(), (state) => states.push(state), fallback)
    FakeEventSource.instances[0]!.fail()
    vi.advanceTimersByTime(5_000)

    expect(states).toEqual(["CONNECTING", "RECONNECTING", "FALLBACK"])
    expect(fallback).toHaveBeenCalledTimes(1)
    controller.close()
  })

  it("ignores stale snapshots after a newer revision has been applied", () => {
    vi.stubGlobal("EventSource", FakeEventSource)
    const snapshots: number[] = []
    openRuntimeStream(
      "/stream",
      (snapshot) => snapshots.push(snapshot.revision),
      vi.fn(),
      vi.fn()
    )
    const source = FakeEventSource.instances[0]!
    source.emitSnapshot({ protocol: "wurenji-runtime-stream-v1", revision: 8, resumedFromRevision: 7, workspace: {} })
    source.emitSnapshot({ protocol: "wurenji-runtime-stream-v1", revision: 7, resumedFromRevision: null, workspace: {} })

    expect(snapshots).toEqual([8])
  })

  it("starts HTTP fallback when a snapshot envelope is invalid", () => {
    vi.useFakeTimers()
    vi.stubGlobal("EventSource", FakeEventSource)
    const fallback = vi.fn()
    const states: string[] = []
    openRuntimeStream("/stream", vi.fn(), (state) => states.push(state), fallback)
    FakeEventSource.instances[0]!.emitSnapshot({ protocol: "unknown", revision: 1, workspace: {} })
    vi.advanceTimersByTime(5_000)

    expect(states).toEqual(["CONNECTING", "RECONNECTING", "FALLBACK"])
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it("starts HTTP fallback when an incremental message type is unknown", () => {
    vi.useFakeTimers()
    vi.stubGlobal("EventSource", FakeEventSource)
    const fallback = vi.fn()
    const states: string[] = []
    openRuntimeStream("/stream", vi.fn(), (state) => states.push(state), fallback)
    FakeEventSource.instances[0]!.emit("event", { messageType: "UNKNOWN", revision: 1, event: {} })
    vi.advanceTimersByTime(5_000)

    expect(states).toEqual(["CONNECTING", "RECONNECTING", "FALLBACK"])
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it("rejects a valid message type delivered on the wrong SSE event", () => {
    vi.useFakeTimers()
    vi.stubGlobal("EventSource", FakeEventSource)
    const fallback = vi.fn()
    const states: string[] = []
    const messages: unknown[] = []
    openRuntimeStream("/stream", vi.fn(), (state) => states.push(state), fallback, undefined, (message) => messages.push(message))
    FakeEventSource.instances[0]!.emit("event", { messageType: "COMPLETED", revision: 1, session: { status: "COMPLETED" } })
    vi.advanceTimersByTime(5_000)

    expect(messages).toHaveLength(0)
    expect(states).toEqual(["CONNECTING", "RECONNECTING", "FALLBACK"])
    expect(fallback).toHaveBeenCalledTimes(1)
  })
})
