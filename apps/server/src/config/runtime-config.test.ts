import { describe, expect, it } from "vitest"
import { isDevelopmentAppOrigin, parseAllowedOrigins, validateProductionEnvironment, validateProductionWorkerEnvironment } from "./runtime-config.js"

describe("runtime configuration", () => {
  it("normalizes and de-duplicates allowed origins", () => {
    expect(parseAllowedOrigins("https://training.example, https://training.example/")).toEqual(["https://training.example"])
  })

  it("rejects a path in WEB_ORIGIN", () => {
    expect(() => parseAllowedOrigins("https://training.example/workspace")).toThrow("必须是 origin")
  })

  it("allows the local monolith origin only during development", () => {
    expect(isDevelopmentAppOrigin("http://localhost:3000", { NODE_ENV: "development", PORT: "3000" })).toBe(true)
    expect(isDevelopmentAppOrigin("http://127.0.0.1:3000", { NODE_ENV: "development", PORT: "3000" })).toBe(true)
    expect(isDevelopmentAppOrigin("http://localhost:3000", { NODE_ENV: "production", PORT: "3000" })).toBe(false)
    expect(isDevelopmentAppOrigin("http://training.example:3000", { NODE_ENV: "development", PORT: "3000" })).toBe(false)
  })

  it("requires production secrets and HTTPS origins", () => {
    expect(() => validateProductionEnvironment({ NODE_ENV: "production", JWT_SECRET: "production-jwt-secret-012345678901234567890", COOKIE_SECURE: "true", TYPEORM_SYNCHRONIZE: "false", SEED_DEMO_DATA: "false", V3_ALLOW_UNSIGNED_RESOURCE_REGISTRATION: "false", WEB_ORIGIN: "https://training.example", RESOURCE_PACKAGE_TRUSTED_KEYS_JSON: "{}", ONLYOFFICE_JWT_SECRET: "production-onlyoffice-secret-012345", DATABASE_URL: "postgresql://user:password@db:5432/wurenji", V3_FILE_STORAGE_PROVIDER: "MINIO", MINIO_ACCESS_KEY: "production-access", MINIO_SECRET_KEY: "production-object-secret" })).not.toThrow()
    expect(() => validateProductionEnvironment({ NODE_ENV: "production", JWT_SECRET: "short", COOKIE_SECURE: "false", WEB_ORIGIN: "http://localhost:3000" })).toThrow("JWT_SECRET")
  })

  it("rejects default production storage credentials", () => {
    const environment = { NODE_ENV: "production", JWT_SECRET: "production-jwt-secret-012345678901234567890", COOKIE_SECURE: "true", TYPEORM_SYNCHRONIZE: "false", SEED_DEMO_DATA: "false", V3_ALLOW_UNSIGNED_RESOURCE_REGISTRATION: "false", WEB_ORIGIN: "https://training.example", RESOURCE_PACKAGE_TRUSTED_KEYS_JSON: "{}", ONLYOFFICE_JWT_SECRET: "production-onlyoffice-secret-012345", DATABASE_URL: "postgresql://db.example/training", V3_FILE_STORAGE_PROVIDER: "MINIO", MINIO_ACCESS_KEY: "example-access", MINIO_SECRET_KEY: "test-object-secret" }
    expect(() => validateProductionEnvironment({ ...environment, MINIO_SECRET_KEY: "" })).toThrow("对象存储")
  })

  it("validates the production worker without web-only settings", () => {
    expect(() => validateProductionWorkerEnvironment({ NODE_ENV: "production", TYPEORM_SYNCHRONIZE: "false", DATABASE_URL: "postgresql://db.example/training", V3_FILE_STORAGE_PROVIDER: "MINIO", MINIO_ACCESS_KEY: "production-access", MINIO_SECRET_KEY: "production-object-secret" })).not.toThrow()
    expect(() => validateProductionWorkerEnvironment({ NODE_ENV: "production" })).toThrow("DATABASE_URL")
  })
})
