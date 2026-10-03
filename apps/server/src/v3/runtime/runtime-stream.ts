import type { Request, Response } from "express"
import { runtimeContract, type RuntimeError } from "@wurenji/shared"

export interface RuntimeWorkspaceSession {
  session: { revision: number; simulationTimeMs?: number; status?: string }
}

export interface RuntimeStreamWorkspace extends RuntimeWorkspaceSession {
  projectId: string
}

export interface RuntimeStreamSnapshot<TWorkspace extends RuntimeWorkspaceSession> {
  protocol: "wurenji-runtime-stream-v1"
  contractProtocol: typeof runtimeContract.protocol
  messageType: "SNAPSHOT"
  revision: number
  resumedFromRevision: number | null
  workspace: TWorkspace
}

interface RuntimeStreamSubscriber<TWorkspace extends RuntimeStreamWorkspace> {
  request: Request
  response: Response
  resumedFromRevision: number | null
  lastFingerprint: string | null
  lastWorkspace: TWorkspace | null
}

interface SharedRuntimeStream<TWorkspace extends RuntimeStreamWorkspace> {
  key: string
  loadWorkspace: () => Promise<TWorkspace>
  workspace: TWorkspace
  subscribers: Set<RuntimeStreamSubscriber<TWorkspace>>
  timer: NodeJS.Timeout | null
  polling: boolean
}

const sharedStreams = new Map<string, SharedRuntimeStream<RuntimeStreamWorkspace>>()
const initializingStreams = new Map<string, Promise<SharedRuntimeStream<RuntimeStreamWorkspace>>>()

export async function streamRuntimeWorkspace<TWorkspace extends RuntimeStreamWorkspace>(
  request: Request,
  response: Response,
  streamKey: string,
  loadWorkspace: () => Promise<TWorkspace>
): Promise<void> {
  const requestedRevision = parseLastEventId(request.headers["last-event-id"])
  const stream = await sharedRuntimeStream(streamKey, loadWorkspace)
  if (requestedRevision !== null && stream.subscribers.size > 0) {
    stream.workspace = await stream.loadWorkspace()
  }
  if (request.destroyed || response.writableEnded) {
    if (stream.subscribers.size === 0) disposeStream(stream)
    return
  }
  response.statusCode = 200
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8")
  response.setHeader("Cache-Control", "no-cache, no-transform")
  response.setHeader("Connection", "keep-alive")
  response.setHeader("X-Accel-Buffering", "no")
  response.flushHeaders()

  const subscriber: RuntimeStreamSubscriber<TWorkspace> = {
    request,
    response,
    resumedFromRevision: requestedRevision,
    lastFingerprint: null,
    lastWorkspace: null
  }
  const close = () => {
    request.removeListener("close", close)
    removeSubscriber(stream, subscriber)
  }
  request.once("close", close)
  stream.subscribers.add(subscriber)
  publish(subscriber, stream.workspace)
  schedulePoll(stream)
}

async function sharedRuntimeStream<TWorkspace extends RuntimeStreamWorkspace>(
  key: string,
  loadWorkspace: () => Promise<TWorkspace>
): Promise<SharedRuntimeStream<TWorkspace>> {
  const existing = sharedStreams.get(key) as SharedRuntimeStream<TWorkspace> | undefined
  if (existing) return existing
  const initializing = initializingStreams.get(key)
  if (initializing) return initializing as Promise<SharedRuntimeStream<TWorkspace>>
  const creation = (async () => {
    const stream: SharedRuntimeStream<TWorkspace> = {
      key,
      loadWorkspace,
      workspace: await loadWorkspace(),
      subscribers: new Set(),
      timer: null,
      polling: false
    }
    sharedStreams.set(key, stream as SharedRuntimeStream<RuntimeStreamWorkspace>)
    return stream as SharedRuntimeStream<RuntimeStreamWorkspace>
  })()
  initializingStreams.set(key, creation)
  try {
    return await creation as SharedRuntimeStream<TWorkspace>
  } finally {
    if (initializingStreams.get(key) === creation) initializingStreams.delete(key)
  }
}

function schedulePoll<TWorkspace extends RuntimeStreamWorkspace>(stream: SharedRuntimeStream<TWorkspace>): void {
  if (stream.timer || stream.polling || stream.subscribers.size === 0) return
  stream.timer = setTimeout(() => {
    stream.timer = null
    void poll(stream)
  }, streamIntervalMs())
}

async function poll<TWorkspace extends RuntimeStreamWorkspace>(stream: SharedRuntimeStream<TWorkspace>): Promise<void> {
  if (stream.subscribers.size === 0) return disposeStream(stream)
  stream.polling = true
  try {
    stream.workspace = await stream.loadWorkspace()
    for (const subscriber of [...stream.subscribers]) {
      try {
        publish(subscriber, stream.workspace)
        subscriber.response.write(`: heartbeat ${Date.now()}\n\n`)
      } catch {
        removeSubscriber(stream, subscriber)
      }
    }
  } catch {
    for (const subscriber of [...stream.subscribers]) {
      const error: RuntimeError = {
        code: "INVALID_PAYLOAD",
        message: "runtime stream workspace could not be loaded",
        requestId: null,
        sessionId: null,
        revision: null,
        details: { streamCode: "RUNTIME_STREAM_READ_FAILED" }
      }
      subscriber.response.write(`event: stream-error\ndata: ${JSON.stringify({ contractProtocol: runtimeContract.protocol, messageType: "ERROR", error })}\n\n`)
      subscriber.response.end()
      removeSubscriber(stream, subscriber)
    }
  } finally {
    stream.polling = false
    schedulePoll(stream)
  }
}

function publish<TWorkspace extends RuntimeStreamWorkspace>(subscriber: RuntimeStreamSubscriber<TWorkspace>, workspace: TWorkspace): void {
  const revision = normalizeRevision(workspace.session.revision)
  const fingerprint = runtimeWorkspaceFingerprint(workspace)
  if (subscriber.lastFingerprint === fingerprint) return
  const previousWorkspace = subscriber.lastWorkspace
  if (previousWorkspace) publishIncrementalMessages(subscriber, previousWorkspace, workspace, revision)
  const payload: RuntimeStreamSnapshot<TWorkspace> = {
    protocol: "wurenji-runtime-stream-v1",
    contractProtocol: runtimeContract.protocol,
    messageType: "SNAPSHOT",
    revision,
    resumedFromRevision: subscriber.resumedFromRevision,
    workspace
  }
  subscriber.response.write(`id: ${revision}\nevent: snapshot\ndata: ${JSON.stringify(payload)}\n\n`)
  subscriber.lastFingerprint = fingerprint
  subscriber.lastWorkspace = workspace
  subscriber.resumedFromRevision = null
}

function publishIncrementalMessages<TWorkspace extends RuntimeStreamWorkspace>(
  subscriber: RuntimeStreamSubscriber<TWorkspace>,
  previous: TWorkspace,
  current: TWorkspace,
  revision: number
): void {
  const simulationTimeMs = normalizeSimulationTime(current.session.simulationTimeMs)
  const previousSession = previous.session
  const currentSession = current.session
  const changes: Record<string, unknown> = {}
  if (previousSession.simulationTimeMs !== currentSession.simulationTimeMs) changes.simulationTimeMs = simulationTimeMs
  if (previousSession.status !== currentSession.status) changes.status = currentSession.status ?? null
  if (Object.keys(changes).length > 0) {
    writeMessage(subscriber.response, "state-delta", {
      contractProtocol: runtimeContract.protocol,
      messageType: "STATE_DELTA",
      revision,
      simulationTimeMs,
      changes
    })
  }
  publishCollectionChanges(subscriber, previous, current, revision, "events", "event")
  publishCollectionChanges(subscriber, previous, current, revision, "actions", "action-result")
  if (isTerminalStatus(currentSession.status) && !isTerminalStatus(previousSession.status)) {
    writeMessage(subscriber.response, "completed", {
      contractProtocol: runtimeContract.protocol,
      messageType: "COMPLETED",
      revision,
      session: currentSession
    })
  }
}

function publishCollectionChanges<TWorkspace extends RuntimeStreamWorkspace>(
  subscriber: RuntimeStreamSubscriber<TWorkspace>,
  previous: TWorkspace,
  current: TWorkspace,
  revision: number,
  collectionKey: "events" | "actions",
  eventName: "event" | "action-result"
): void {
  const previousItems = collectionItems(previous, collectionKey)
  const currentItems = collectionItems(current, collectionKey)
  const previousById = new Map(previousItems.map((item) => [String(item.id ?? ""), JSON.stringify(item)]))
  for (const item of currentItems) {
    const id = String(item.id ?? "")
    if (!id || previousById.get(id) === JSON.stringify(item)) continue
    writeMessage(subscriber.response, eventName, {
      contractProtocol: runtimeContract.protocol,
      messageType: collectionKey === "events" ? "EVENT" : "ACTION_RESULT",
      revision,
      [collectionKey === "events" ? "event" : "action"]: item
    })
  }
}

function collectionItems<TWorkspace extends RuntimeStreamWorkspace>(workspace: TWorkspace, key: "events" | "actions"): readonly Record<string, unknown>[] {
  const value = (workspace as unknown as Record<string, unknown>)[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
}

function writeMessage(response: Response, eventName: string, payload: Record<string, unknown>): void {
  response.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`)
}

function isTerminalStatus(status: string | undefined): boolean {
  return status === "COMPLETED" || status === "ABORTED" || status === "FAILED"
}

function removeSubscriber<TWorkspace extends RuntimeStreamWorkspace>(stream: SharedRuntimeStream<TWorkspace>, subscriber: RuntimeStreamSubscriber<TWorkspace>): void {
  stream.subscribers.delete(subscriber)
  if (stream.subscribers.size === 0) disposeStream(stream)
}

function disposeStream<TWorkspace extends RuntimeStreamWorkspace>(stream: SharedRuntimeStream<TWorkspace>): void {
  if (sharedStreams.get(stream.key) !== stream) return
  if (stream.timer) clearTimeout(stream.timer)
  stream.timer = null
  sharedStreams.delete(stream.key)
}

export function runtimeWorkspaceFingerprint(workspace: RuntimeWorkspaceSession): string {
  normalizeRevision(workspace.session.revision)
  return JSON.stringify(workspace)
}

export function parseLastEventId(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw || !/^\d+$/.test(raw)) return null
  const revision = Number(raw)
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null
}

function normalizeRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("runtime revision is invalid")
  return value
}

function normalizeSimulationTime(value: number | undefined): number {
  if (value === undefined) return 0
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function streamIntervalMs(): number {
  const configured = Number(process.env.RUNTIME_STREAM_INTERVAL_MS ?? 1_000)
  return Number.isFinite(configured) ? Math.max(250, Math.min(10_000, Math.floor(configured))) : 1_000
}
