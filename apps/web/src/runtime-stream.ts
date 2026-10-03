import { apiBaseUrl } from "./api"

export type RuntimeStreamConnectionState = "CONNECTING" | "LIVE" | "RECONNECTING" | "FALLBACK" | "CLOSED"

export interface RuntimeStreamSnapshot<TWorkspace> {
  protocol: "wurenji-runtime-stream-v1"
  contractProtocol?: "wurenji-runtime-contract-v1"
  messageType?: "SNAPSHOT"
  revision: number
  resumedFromRevision: number | null
  workspace: TWorkspace
}

export interface RuntimeStreamController {
  close(): void
}

export interface RuntimeStreamErrorEnvelope {
  contractProtocol?: "wurenji-runtime-contract-v1"
  messageType?: "ERROR"
  error: {
    code: string
    message: string
    requestId: string | null
    sessionId: string | null
    revision: number | null
    details: Record<string, unknown>
  }
}

export type RuntimeStreamIncrementalMessage =
  | { contractProtocol?: "wurenji-runtime-contract-v1"; messageType: "STATE_DELTA"; revision: number; simulationTimeMs: number; changes: Record<string, unknown> }
  | { contractProtocol?: "wurenji-runtime-contract-v1"; messageType: "EVENT"; revision: number; event: Record<string, unknown> }
  | { contractProtocol?: "wurenji-runtime-contract-v1"; messageType: "ACTION_RESULT"; revision: number; action: Record<string, unknown> }
  | { contractProtocol?: "wurenji-runtime-contract-v1"; messageType: "COMPLETED"; revision: number; session: Record<string, unknown> }

export function openRuntimeStream<TWorkspace>(
  path: string,
  onSnapshot: (snapshot: RuntimeStreamSnapshot<TWorkspace>) => void,
  onState: (state: RuntimeStreamConnectionState) => void,
  onFallbackTick: () => void,
  onStreamError?: (error: RuntimeStreamErrorEnvelope) => void,
  onMessage?: (message: RuntimeStreamIncrementalMessage) => void
): RuntimeStreamController {
  const source = new EventSource(apiBaseUrl(path), { withCredentials: true })
  let closed = false
  let latestRevision = 0
  let fallbackTimer: ReturnType<typeof globalThis.setInterval> | null = null
  onState("CONNECTING")

  const stopFallback = () => {
    if (fallbackTimer !== null) {
      globalThis.clearInterval(fallbackTimer)
      fallbackTimer = null
    }
  }
  const startFallback = () => {
    if (fallbackTimer !== null) return
    onState("FALLBACK")
    fallbackTimer = globalThis.setInterval(onFallbackTick, 5_000)
  }

  const handleSnapshot = (event: Event) => {
    try {
      const snapshot = JSON.parse((event as MessageEvent<string>).data) as RuntimeStreamSnapshot<TWorkspace>
      if (snapshot.protocol !== "wurenji-runtime-stream-v1" || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) throw new Error("invalid runtime stream snapshot")
      if (snapshot.revision < latestRevision) return
      latestRevision = snapshot.revision
      onSnapshot(snapshot)
    } catch {
      onState("RECONNECTING")
      startFallback()
    }
  }
  const handleStreamError = (event: Event) => {
    try {
      const envelope = JSON.parse((event as MessageEvent<string>).data) as RuntimeStreamErrorEnvelope
      if (!envelope.error || typeof envelope.error.code !== "string" || typeof envelope.error.message !== "string") throw new Error("invalid runtime stream error")
      onStreamError?.(envelope)
      onState("RECONNECTING")
      startFallback()
    } catch {
      onState("RECONNECTING")
      startFallback()
    }
  }
  const handleIncrementalMessage = (event: Event, expectedType: RuntimeStreamIncrementalMessage["messageType"]) => {
    try {
      const message = JSON.parse((event as MessageEvent<string>).data) as RuntimeStreamIncrementalMessage
      if (!Number.isSafeInteger(message.revision) || message.revision < 1 || !isRuntimeStreamIncrementalMessageType(message.messageType) || message.messageType !== expectedType) throw new Error("invalid runtime stream message")
      if (message.revision < latestRevision) return
      latestRevision = message.revision
      onMessage?.(message)
    } catch {
      onState("RECONNECTING")
      startFallback()
    }
  }
  const handleStateDelta = (event: Event) => handleIncrementalMessage(event, "STATE_DELTA")
  const handleEvent = (event: Event) => handleIncrementalMessage(event, "EVENT")
  const handleActionResult = (event: Event) => handleIncrementalMessage(event, "ACTION_RESULT")
  const handleCompleted = (event: Event) => handleIncrementalMessage(event, "COMPLETED")
  const handleOpen = () => {
    if (closed) return
    stopFallback()
    onState("LIVE")
  }
  const handleError = () => {
    if (closed) return
    onState("RECONNECTING")
    startFallback()
  }
  source.addEventListener("snapshot", handleSnapshot)
  source.addEventListener("stream-error", handleStreamError)
  source.addEventListener("state-delta", handleStateDelta)
  source.addEventListener("event", handleEvent)
  source.addEventListener("action-result", handleActionResult)
  source.addEventListener("completed", handleCompleted)
  source.onopen = handleOpen
  source.onerror = handleError

  return {
    close() {
      if (closed) return
      closed = true
      stopFallback()
      source.removeEventListener("snapshot", handleSnapshot)
      source.removeEventListener("stream-error", handleStreamError)
      source.removeEventListener("state-delta", handleStateDelta)
      source.removeEventListener("event", handleEvent)
      source.removeEventListener("action-result", handleActionResult)
      source.removeEventListener("completed", handleCompleted)
      source.onopen = null
      source.onerror = null
      source.close()
      onState("CLOSED")
    }
  }
}

function isRuntimeStreamIncrementalMessageType(value: unknown): value is RuntimeStreamIncrementalMessage["messageType"] {
  return value === "STATE_DELTA" || value === "EVENT" || value === "ACTION_RESULT" || value === "COMPLETED"
}
