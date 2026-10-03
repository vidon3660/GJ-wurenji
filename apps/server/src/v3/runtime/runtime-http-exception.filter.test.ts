import { HttpException } from "@nestjs/common"
import type { ArgumentsHost } from "@nestjs/common"
import { describe, expect, it, vi } from "vitest"
import { RuntimeHttpExceptionFilter } from "./runtime-http-exception.filter.js"

describe("runtime HTTP exception filter", () => {
  it("keeps the HTTP message while returning a structured runtime error", () => {
    const json = vi.fn()
    const response = { status: vi.fn(() => ({ json })) }
    const request = {
      body: { requestId: "request-1", expectedRevision: 7 },
      params: { sessionId: "session-1" },
      method: "POST",
      path: "/api/v3/show-projects/project-1/runtime/actions"
    }
    const host = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response })
    } as unknown as ArgumentsHost

    new RuntimeHttpExceptionFilter().catch(new HttpException("运行版本冲突，当前版本为 8", 409), host)

    expect(response.status).toHaveBeenCalledWith(409)
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 409,
      message: "运行版本冲突，当前版本为 8",
      error: expect.objectContaining({
        code: "STALE_SESSION_REVISION",
        requestId: "request-1",
        sessionId: "session-1",
        revision: 7
      })
    }))
  })

  it("normalizes unexpected runtime failures into a structured 500 error", () => {
    const json = vi.fn()
    const response = { status: vi.fn(() => ({ json })) }
    const request = {
      body: { requestId: "request-2", expectedRevision: 9 },
      params: { sessionId: "session-2" },
      method: "POST",
      path: "/api/v3/vtl-projects/project-2/runtime/actions"
    }
    const host = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response })
    } as unknown as ArgumentsHost

    new RuntimeHttpExceptionFilter().catch(new Error("database unavailable"), host)

    expect(response.status).toHaveBeenCalledWith(500)
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 500,
      message: "运行请求失败",
      error: expect.objectContaining({
        code: "INVALID_PAYLOAD",
        requestId: "request-2",
        sessionId: "session-2",
        revision: 9
      })
    }))
  })
})
