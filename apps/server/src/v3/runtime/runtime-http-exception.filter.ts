import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common"
import type { Request, Response } from "express"
import { runtimeErrorFromMessage } from "./runtime-adapters.js"

@Catch()
export class RuntimeHttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp()
    const request = context.getRequest<Request>()
    const response = context.getResponse<Response>()
    const statusCode = exception instanceof HttpException ? exception.getStatus() : 500
    const message = exception instanceof HttpException ? exceptionMessage(exception.getResponse()) : "运行请求失败"
    const runtimeError = runtimeErrorFromMessage(message, {
      requestId: stringValue(request.body?.requestId),
      sessionId: stringValue(request.params?.sessionId),
      revision: integerValue(request.body?.expectedRevision),
      details: {
        statusCode,
        method: request.method,
        path: request.path
      }
    })
    response.status(statusCode).json({ statusCode, message, error: runtimeError })
  }
}

function exceptionMessage(payload: string | object): string {
  if (typeof payload === "string") return payload
  if (payload && "message" in payload) {
    const message = payload.message
    if (Array.isArray(message)) return message.map(String).join("；")
    if (typeof message === "string") return message
  }
  return "运行请求失败"
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function integerValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null
}
