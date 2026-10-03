import "reflect-metadata"
import { NestFactory } from "@nestjs/core"
import cookieParser from "cookie-parser"
import type { NextFunction, Request, Response } from "express"
import { AppModule } from "./app.module.js"
import { isDevelopmentAppOrigin, parseAllowedOrigins, validateProductionEnvironment } from "./config/runtime-config.js"

async function bootstrap() {
  validateProductionEnvironment()
  const app = await NestFactory.create(AppModule)
  app.setGlobalPrefix("api")
  if (process.env.TRUST_PROXY === "true") app.getHttpAdapter().getInstance().set("trust proxy", true)
  app.use(cookieParser())
  const allowedOrigins = parseAllowedOrigins()
  app.enableCors({
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      if (!origin || allowedOrigins.includes(origin) || isDevelopmentAppOrigin(origin)) callback(null, true)
      else callback(new Error("请求来源不在 WEB_ORIGIN 白名单中"), false)
    },
    credentials: true
  })
  if (process.env.NODE_ENV !== "test") app.use((request: Request, response: Response, next: NextFunction) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method) || request.path.startsWith("/api/v3/office/callbacks/")) return next()
    const origin = request.headers.origin
    const refererOrigin = request.headers.referer ? safeOrigin(request.headers.referer) : null
    if ((origin && allowedOrigins.includes(origin)) || (!origin && refererOrigin && allowedOrigins.includes(refererOrigin))) return next()
    response.status(403).json({ statusCode: 403, message: "缺少可信请求来源" })
  })
  app.enableShutdownHooks()
  await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0")
}

function safeOrigin(value: string): string | null {
  try { return new URL(value).origin } catch { return null }
}

void bootstrap()
