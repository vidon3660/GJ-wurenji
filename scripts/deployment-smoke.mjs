import { execFile as execFileCallback } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)
const baseUrl = (argument("base-url") ?? process.env.DEPLOYMENT_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "")
const expectedVersion = argument("expected-version") ?? process.env.PLATFORM_VERSION ?? "0.1.0"
const configOnly = hasFlag("config-only") || argument("config-only") === "true"
const targetLabel = process.env.ACCEPTANCE_TARGET_LABEL?.trim() || "local-docker"
const outputPath = resolve(argument("output") ?? `artifacts/deployment/deployment-smoke-${timestamp()}.json`)
const checks = []

await check("COMPOSE-DEV", "基础 Compose 配置可解析", async () => {
  const config = await composeConfig(["-f", "docker-compose.yml", "--profile", "backup", "--profile", "worker"], { PLATFORM_VERSION: expectedVersion })
  assert(config.services?.app?.healthcheck?.test?.join(" ").includes("/api/readyz"), "app 未配置数据库就绪探针")
  assert(config.services?.backup?.build?.dockerfile?.replaceAll("\\", "/").endsWith("Dockerfile.backup"), "backup 未使用 PostgreSQL 17 专用镜像")
  assert(config.services?.worker?.command?.join(" ").includes("dist/worker.js"), "worker 未使用独立进程入口")
  assert(config.services?.worker?.healthcheck?.test?.join(" ").includes("worker-healthcheck.js"), "worker 未配置循环健康探针")
  assert(config.services?.worker?.restart === "unless-stopped", "worker 未配置异常退出自动重启")
  assertPlatformImages(config)
})

await check("COMPOSE-PRODUCTION", "生产覆盖仅开放网关端口", async () => {
  const environment = {
    POSTGRES_PASSWORD: "deployment-check-postgres-secret",
    PRODUCTION_DATABASE_URL: "postgresql://wurenji:deployment-check-postgres-secret@db:5432/wurenji",
    MINIO_ACCESS_KEY: "deployment-check",
    MINIO_SECRET_KEY: "deployment-check-minio-secret",
    JWT_SECRET: "deployment-check-jwt-secret-01234567890123456789",
    WEB_ORIGIN: "https://training.example.edu",
    ONLYOFFICE_PUBLIC_URL: "https://office.example.edu",
    ONLYOFFICE_JWT_SECRET: "deployment-check-onlyoffice-secret",
    PLATFORM_VERSION: expectedVersion
  }
  const config = await composeConfig(["-f", "docker-compose.yml", "-f", "deploy/docker-compose.production.yml", "--profile", "production", "--profile", "worker", "--profile", "backup"], environment)
  for (const service of ["app", "db", "minio", "onlyoffice"]) assert((config.services?.[service]?.ports ?? []).length === 0, `${service} 仍暴露宿主端口`)
  assert((config.services?.gateway?.ports ?? []).length === 2, "gateway 未开放 80/443")
  assert((config.services?.["map-service"]?.ports ?? []).length === 0, "map-service 不应暴露宿主端口")
  assert(config.services?.app?.environment?.NODE_ENV === "production", "app 未启用生产模式")
  assert(config.services?.app?.environment?.COOKIE_SECURE === "true", "app 未强制 Secure Cookie")
  assert(config.services?.worker?.environment?.NODE_ENV === "production", "worker 未启用生产模式")
  assert(config.services?.worker?.environment?.DATABASE_URL === environment.PRODUCTION_DATABASE_URL, "worker 未使用生产数据库连接")
  assertPlatformImages(config)
})

await check("GATEWAY-CONFIG", "Nginx TLS、限流与安全头已配置", async () => {
  const config = await readFile(resolve("deploy/nginx/default.conf"), "utf8")
  for (const required of ["listen 443 ssl", "Strict-Transport-Security", "limit_req", "X-Content-Type-Options", "proxy_pass http://app:3000", "proxy_pass http://map-service", "/gateway-healthz"]) assert(config.includes(required), `Nginx 缺少配置：${required}`)
  const mapConfig = await readFile(resolve("deploy/nginx/map.conf"), "utf8")
  for (const required of ["try_files $uri =404", "Access-Control-Allow-Origin", "immutable", "/map-healthz"]) assert(mapConfig.includes(required), `map-service 缺少配置：${required}`)
})

if (!configOnly) {
  await check("APP-LIVENESS", "应用存活探针", async () => {
    const value = await requestJson(`${baseUrl}/api/healthz`)
    assert(value.status === "ok" && value.version === expectedVersion, `存活探针版本异常：${value.version ?? "缺失"}`)
  })

  await check("APP-READINESS", "应用数据库就绪探针", async () => {
    const value = await requestJson(`${baseUrl}/api/readyz`)
    assert(value.status === "ready" && value.database === "ok" && value.version === expectedVersion, `就绪探针状态或版本异常：${value.version ?? "缺失"}`)
  })

  await check("QUESTION-BANK-ROUTE", "题库管理路由已注册", async () => {
    const response = await fetch(`${baseUrl}/api/v1/education/question-banks`, { headers: { Accept: "application/json" } })
    assert(response.status === 401 || response.status === 403, `题库管理路由返回 HTTP ${response.status}，预期未认证响应`)
  })
}

const summary = { total: checks.length, passed: checks.filter((item) => item.status === "PASS").length, failed: checks.filter((item) => item.status === "FAIL").length }
const report = { format: "wurenji-deployment-smoke", formatVersion: 1, generatedAt: new Date().toISOString(), environment: { targetLabel }, baseUrl, expectedVersion, mode: configOnly ? "CONFIG_ONLY" : "FULL", summary, checks }
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify({ summary, output: outputPath })}\n`)
if (summary.failed > 0) process.exitCode = 1

async function composeConfig(argumentsList, environment = {}) {
  const result = await execFile("docker", ["compose", ...argumentsList, "config", "--format", "json"], { cwd: process.cwd(), env: { ...process.env, ...environment }, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  return JSON.parse(result.stdout)
}

async function requestJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`${url} 返回 HTTP ${response.status}`)
  return response.json()
}

function assertPlatformImages(config) {
  const expectedImage = `wurenji-platform:${expectedVersion}`
  const platformServices = ["app", "migrate", "worker"]
  const images = platformServices.map((service) => config.services?.[service]?.image)
  assert(images.every((image) => image === expectedImage), `平台服务镜像不一致：${images.join(", ")}`)
  for (const service of platformServices) {
    assert(config.services?.[service]?.build?.args?.PLATFORM_VERSION === expectedVersion, `${service} 未传入 PLATFORM_VERSION 构建参数`)
  }
  assert(config.services?.app?.environment?.PLATFORM_VERSION === expectedVersion, "app 运行版本变量与镜像标签不一致")
  assert(config.services?.backup?.image === `wurenji-backup:${expectedVersion}`, "backup 镜像标签与平台版本不一致")
  assert(config.services?.backup?.build?.args?.PLATFORM_VERSION === expectedVersion, "backup 未传入 PLATFORM_VERSION 构建参数")
}

async function check(code, title, operation) {
  try {
    await operation()
    checks.push({ code, title, status: "PASS", message: "通过" })
  } catch (error) {
    checks.push({ code, title, status: "FAIL", message: error instanceof Error ? error.message : String(error) })
  }
}

function assert(condition, message) { if (!condition) throw new Error(message) }

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function hasFlag(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && (process.argv[index + 1] === undefined || process.argv[index + 1]?.startsWith("--"))
}

function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") }
