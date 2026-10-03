export function parseAllowedOrigins(value: string | undefined = process.env.WEB_ORIGIN): string[] {
  const values = (value ?? "http://localhost:3000,http://localhost:5173").split(",").map((item) => item.trim()).filter(Boolean)
  if (values.length === 0) throw new Error("WEB_ORIGIN 至少需要配置一个来源")
  const origins = values.map((item) => {
    let parsed: URL
    try { parsed = new URL(item) } catch { throw new Error(`WEB_ORIGIN 包含无效来源：${item}`) }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`WEB_ORIGIN 仅支持 HTTP 或 HTTPS：${item}`)
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error(`WEB_ORIGIN 必须是 origin：${item}`)
    return parsed.origin
  })
  return [...new Set(origins)]
}

export function isDevelopmentAppOrigin(
  value: string | undefined,
  environment: { NODE_ENV?: string | undefined; PORT?: string | undefined } = {
    NODE_ENV: process.env.NODE_ENV,
    PORT: process.env.PORT
  }
): boolean {
  if (!value || environment.NODE_ENV === "production") return false
  let parsed: URL
  try { parsed = new URL(value) } catch { return false }
  if (parsed.protocol !== "http:" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)) return false
  const expectedPort = environment.PORT?.trim() || "3000"
  return (parsed.port || "80") === expectedPort
}

export function validateProductionEnvironment(environment: NodeJS.ProcessEnv = process.env): void {
  if (environment.NODE_ENV !== "production") return
  const jwtSecret = environment.JWT_SECRET?.trim() ?? ""
  if (jwtSecret.length < 32) throw new Error("生产环境 JWT_SECRET 必须配置为至少 32 个字符的密钥")
  if (environment.COOKIE_SECURE !== "true") throw new Error("生产环境 COOKIE_SECURE 必须设置为 true")
  if (environment.TYPEORM_SYNCHRONIZE === "true") throw new Error("生产环境禁止启用 TYPEORM_SYNCHRONIZE")
  if (environment.SEED_DEMO_DATA === "true") throw new Error("生产环境禁止启用 SEED_DEMO_DATA")
  if (environment.V3_ALLOW_UNSIGNED_RESOURCE_REGISTRATION === "true") throw new Error("生产环境禁止注册未签名资源包")
  const origins = parseAllowedOrigins(environment.WEB_ORIGIN)
  if (origins.some((origin) => !origin.startsWith("https://"))) throw new Error("生产环境 WEB_ORIGIN 必须全部使用 HTTPS")
  if (!environment.RESOURCE_PACKAGE_TRUSTED_KEYS_FILE?.trim() && !environment.RESOURCE_PACKAGE_TRUSTED_KEYS_JSON?.trim()) throw new Error("生产环境必须配置资源包受信公钥")
  const onlyOfficeSecret = environment.ONLYOFFICE_JWT_SECRET?.trim() ?? ""
  if (onlyOfficeSecret.length < 16) throw new Error("生产环境 ONLYOFFICE_JWT_SECRET 必须配置且不少于 16 个字符")
  const databaseUrl = environment.DATABASE_URL?.trim() ?? ""
  if (!databaseUrl) throw new Error("生产环境必须配置 DATABASE_URL")
  const storageProvider = environment.V3_FILE_STORAGE_PROVIDER?.trim().toUpperCase() ?? "LOCAL"
  if (storageProvider === "MINIO" || storageProvider === "S3") {
    const accessKey = environment.MINIO_ACCESS_KEY?.trim() ?? ""
    const secretKey = environment.MINIO_SECRET_KEY?.trim() ?? ""
    if (!accessKey || !secretKey) throw new Error("生产环境对象存储必须配置访问密钥")
  }
}

export function validateProductionWorkerEnvironment(environment: NodeJS.ProcessEnv = process.env): void {
  if (environment.NODE_ENV !== "production") return
  if (environment.TYPEORM_SYNCHRONIZE === "true") throw new Error("生产 Worker 禁止启用 TYPEORM_SYNCHRONIZE")
  const databaseUrl = environment.DATABASE_URL?.trim() ?? ""
  if (!databaseUrl) throw new Error("生产 Worker 必须配置 DATABASE_URL")
  const storageProvider = environment.V3_FILE_STORAGE_PROVIDER?.trim().toUpperCase() ?? "LOCAL"
  if (storageProvider === "MINIO" || storageProvider === "S3") {
    const accessKey = environment.MINIO_ACCESS_KEY?.trim() ?? ""
    const secretKey = environment.MINIO_SECRET_KEY?.trim() ?? ""
    if (!accessKey || !secretKey) throw new Error("生产 Worker 的对象存储必须配置访问密钥")
  }
}
