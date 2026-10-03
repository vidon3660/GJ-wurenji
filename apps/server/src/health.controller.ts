import { Controller, Get, ServiceUnavailableException } from "@nestjs/common"
import { DataSource } from "typeorm"

@Controller()
export class HealthController {
  constructor(private readonly dataSource: DataSource) {}

  @Get("healthz")
  health() { return { status: "ok", service: "wurenji-app", version: platformVersion() } }

  @Get("readyz")
  async readiness() {
    if (!this.dataSource.isInitialized) throw new ServiceUnavailableException("数据库尚未初始化")
    try {
      await this.dataSource.query("SELECT 1")
      return { status: "ready", database: "ok", version: platformVersion() }
    } catch { throw new ServiceUnavailableException("数据库不可用") }
  }
}

function platformVersion(): string {
  return process.env.PLATFORM_VERSION?.trim() || "0.1.0"
}
