import { ConflictException } from "@nestjs/common"
import { createHmac } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ShowDocumentService } from "./show-document.service.js"

const officeSecret = "test-onlyoffice-secret"

describe("ShowDocumentService OnlyOffice assessment callback", () => {
  beforeEach(() => {
    process.env.ONLYOFFICE_JWT_SECRET = officeSecret
  })

  afterEach(() => {
    delete process.env.ONLYOFFICE_JWT_SECRET
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("expires a late student edit session before downloading or persisting content", async () => {
    const session = {
      id: "session-1",
      document: { id: "document-1", project: { id: "project-1" } },
      sessionKey: "document-key",
      mode: "EDIT",
      status: "OPEN",
      actor: {
        id: "student-1",
        email: "student@example.test",
        displayName: "Student",
        role: "student"
      },
      expiresAt: new Date(Date.now() + 60_000),
      lastCallbackAt: null,
      closedAt: null
    }
    const sessions = {
      findOne: vi.fn().mockResolvedValue(session),
      save: vi.fn().mockImplementation(async (value) => value)
    }
    const storage = { write: vi.fn(), delete: vi.fn() }
    const assessmentWindows = {
      assertWritable: vi.fn().mockRejectedValue(new ConflictException("考核时间已结束"))
    }
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    const service = new ShowDocumentService(
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      sessions as never,
      null as never,
      null as never,
      null as never,
      null as never,
      storage as never,
      null as never,
      assessmentWindows as never,
      null as never
    )

    await expect(service.onlyOfficeCallback("session-1", callbackToken(), {
      status: 2,
      key: "document-key",
      url: "http://office.example.test/edited.docx"
    })).resolves.toEqual({ error: 1 })

    expect(assessmentWindows.assertWritable).toHaveBeenCalledWith("project-1", expect.objectContaining({ id: "student-1", role: "student" }), false)
    expect(fetcher).not.toHaveBeenCalled()
    expect(storage.write).not.toHaveBeenCalled()
    expect(session.status).toBe("EXPIRED")
    expect(session.lastCallbackAt).toBeInstanceOf(Date)
    expect(session.closedAt).toBeInstanceOf(Date)
    expect(sessions.save).toHaveBeenCalledWith(session)
  })
})

function callbackToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8").toString("base64url")
  const payload = Buffer.from(JSON.stringify({
    purpose: "DOCUMENT_CALLBACK",
    documentId: "document-1",
    sessionId: "session-1",
    exp: Math.floor(Date.now() / 1000) + 60
  }), "utf8").toString("base64url")
  const signature = createHmac("sha256", officeSecret).update(`${header}.${payload}`).digest("base64url")
  return `${header}.${payload}.${signature}`
}
