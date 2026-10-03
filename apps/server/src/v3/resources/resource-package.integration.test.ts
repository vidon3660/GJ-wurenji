import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { generateKeyPairSync, randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DataSource } from "typeorm"
import { createSignedResourceArchive } from "./resource-archive.fixtures.js"
import { integrationServerEntry } from "../../integration-server-entry.js"

const integrationEnabled = Boolean(process.env.V3_INTEGRATION_DATABASE_URL)

describe.runIf(integrationEnabled)("signed resource package API integration", () => {
  let serverProcess: ChildProcess
  let baseUrl: string
  let serverOutput = ""
  let storageDirectory: string
  let trustedKeysPath: string
  let database: DataSource
  let adminCookie: string
  let teacherCookie: string
  const keyId = `integration-${randomUUID()}`
  const keyPair = generateKeyPairSync("ed25519")
  const rotatedKeyId = `integration-rotated-${randomUUID()}`
  const rotatedKeyPair = generateKeyPairSync("ed25519")
  const packageName = `签名资源集成-${randomUUID()}`
  const packageIds: string[] = []

  beforeAll(async () => {
    storageDirectory = await mkdtemp(join(tmpdir(), "wurenji-resource-integration-"))
    trustedKeysPath = join(storageDirectory, "trusted-resource-keys.json")
    const port = await availablePort()
    baseUrl = `http://127.0.0.1:${port}/api`
    const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString()
    await writeTrustedKeys({ [keyId]: publicKey })
    const server = integrationServerEntry()
    serverProcess = spawn(process.execPath, [server.entry], {
      cwd: server.cwd,
      env: {
        ...process.env,
        DATABASE_URL: process.env.V3_INTEGRATION_DATABASE_URL,
        PORT: String(port),
        WEB_ORIGIN: "http://localhost:5173",
        TYPEORM_SYNCHRONIZE: "false",
        TYPEORM_LOGGING: "true",
        SEED_DEMO_DATA: "true",
        V3_FILE_STORAGE_PROVIDER: "LOCAL",
        V3_FILE_STORAGE_DIR: storageDirectory,
        RESOURCE_PACKAGE_TRUSTED_KEYS_JSON: "",
        RESOURCE_PACKAGE_TRUSTED_KEYS_FILE: trustedKeysPath
      },
      stdio: ["ignore", "pipe", "pipe"]
    })
    serverProcess.stdout?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString("utf8") })
    serverProcess.stderr?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString("utf8") })
    await waitForServer()
    serverOutput = ""
    database = new DataSource({ type: "postgres", url: process.env.V3_INTEGRATION_DATABASE_URL! })
    await database.initialize()
    adminCookie = await login("admin@demo.local", process.env.DEMO_ADMIN_PASSWORD ?? "")
    teacherCookie = await login("teacher@demo.local", process.env.DEMO_TEACHER_PASSWORD ?? "")
  }, 30_000)

  afterAll(async () => {
    if (serverProcess && !serverProcess.killed) serverProcess.kill()
    if (database?.isInitialized) {
      if (packageIds.length > 0) {
        await database.query(`DELETE FROM "resource_packages" WHERE "id" = ANY($1::uuid[])`, [packageIds])
        await database.query(`DELETE FROM "file_assets" WHERE "ownerType" = 'RESOURCE_PACKAGE' AND "ownerId" = ANY($1::uuid[])`, [packageIds])
      }
      await database.destroy()
    }
    if (storageDirectory) await rm(storageDirectory, { recursive: true, force: true })
  })

  it("rejects a non-admin resource upload", async () => {
    const archive = await archiveFor("0.9.0")
    const response = await uploadArchive(archive, teacherCookie, "teacher-upload.zip")
    expect(response.status, await response.text()).toBe(403)
  })

  it("uploads, preflights and downloads an immutable signed archive", async () => {
    const archive = await archiveFor("1.0.0")
    const response = await uploadArchive(archive, adminCookie, "rules-1.0.0.zip")
    const body = await response.json() as ResourceView
    expect(response.status, JSON.stringify(body)).toBe(201)
    packageIds.push(body.id)
    expect(body).toMatchObject({
      name: packageName,
      version: "1.0.0",
      source: "SIGNED_ARCHIVE",
      status: "STAGED",
      validation: { passed: true, signatureKeyId: keyId, rejectionReason: null }
    })
    expect(body.archiveAsset).toMatchObject({ originalName: "rules-1.0.0.zip", sizeBytes: archive.byteLength })
    expect(body.validation.checks.map((check) => check.code)).toEqual([
      "FILE_CHECKSUMS", "MANIFEST_SCHEMA", "FILE_MANIFEST", "SIGNATURE", "PLATFORM_COMPATIBILITY", "DEPENDENCIES"
    ])

    const downloaded = await fetch(`${baseUrl}/v3/resource-packages/${body.id}/archive`, { headers: { Cookie: adminCookie } })
    expect(downloaded.status, await downloaded.clone().text()).toBe(200)
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(archive)
  })

  it("records a rejected package when signature verification fails", async () => {
    const untrustedKeys = generateKeyPairSync("ed25519")
    const archive = await createSignedResourceArchive({
      privateKey: untrustedKeys.privateKey,
      keyId: "untrusted-key",
      name: `${packageName}-拒绝`,
      version: "1.0.0"
    })
    const response = await uploadArchive(archive, adminCookie, "untrusted.zip")
    const body = await response.json() as ResourceView
    expect(response.status, JSON.stringify(body)).toBe(201)
    packageIds.push(body.id)
    expect(body).toMatchObject({ status: "REJECTED", validation: { passed: false, signatureKeyId: null } })
    expect(body.validation.rejectionReason).toContain("签名密钥未受信任")

    const detail = await jsonRequest<ResourceDetail>(`/v3/resource-packages/${body.id}`, { cookie: adminCookie })
    expect(detail.validations[0]).toMatchObject({ status: "FAILED" })
    expect(detail.lifecycle.map((event) => event.action)).toEqual(["PREFLIGHT_FAILED", "UPLOADED"])
  })

  it("activates a new version and atomically rolls back to the retired version", async () => {
    const resources = await jsonRequest<ResourceView[]>("/v3/resource-packages", { cookie: adminCookie })
    const first = resources.find((item) => item.name === packageName && item.version === "1.0.0")!
    const activatedFirst = await jsonRequest<ResourceView>(`/v3/resource-packages/${first.id}/activate`, {
      method: "POST",
      cookie: adminCookie,
      body: { reason: "集成测试首次激活" }
    })
    expect(activatedFirst.status).toBe("ACTIVE")

    const secondArchive = await archiveFor("1.1.0")
    const secondResponse = await uploadArchive(secondArchive, adminCookie, "rules-1.1.0.zip")
    const second = await secondResponse.json() as ResourceView
    expect(secondResponse.status, JSON.stringify(second)).toBe(201)
    packageIds.push(second.id)
    const activatedSecond = await jsonRequest<ResourceView>(`/v3/resource-packages/${second.id}/activate`, {
      method: "POST",
      cookie: adminCookie,
      body: { reason: "升级到 1.1.0" }
    })
    expect(activatedSecond.status).toBe("ACTIVE")
    const firstAfterUpgrade = await jsonRequest<ResourceDetail>(`/v3/resource-packages/${first.id}`, { cookie: adminCookie })
    expect(firstAfterUpgrade.package.status).toBe("RETIRED")

    const rolledBack = await jsonRequest<ResourceView>(`/v3/resource-packages/${first.id}/rollback`, {
      method: "POST",
      cookie: adminCookie,
      body: { reason: "验证原子回滚" }
    })
    expect(rolledBack.status).toBe("ACTIVE")
    const secondAfterRollback = await jsonRequest<ResourceDetail>(`/v3/resource-packages/${second.id}`, { cookie: adminCookie })
    expect(secondAfterRollback.package.status).toBe("RETIRED")
    const rollbackDetail = await jsonRequest<ResourceDetail>(`/v3/resource-packages/${first.id}`, { cookie: adminCookie })
    expect(rollbackDetail.lifecycle.some((event) => event.action === "ROLLED_BACK" && event.previousPackageId === second.id)).toBe(true)
  })

  it("rotates trusted keys while historical assignment snapshots retain the retired resource", async () => {
    const rotatedName = `${packageName}-轮换`
    const originalArchive = await archiveFor("1.0.0", { name: rotatedName })
    const originalResponse = await uploadArchive(originalArchive, adminCookie, "rotation-rules-1.0.0.zip")
    const original = await originalResponse.json() as ResourceView
    expect(originalResponse.status, JSON.stringify(original)).toBe(201)
    packageIds.push(original.id)
    expect(original).toMatchObject({ status: "STAGED", validation: { signatureKeyId: keyId } })
    await jsonRequest<ResourceView>(`/v3/resource-packages/${original.id}/activate`, {
      method: "POST",
      cookie: adminCookie,
      body: { reason: "建立密钥轮换前的冻结版本" }
    })

    let assignmentId: string | null = null
    try {
      const resources = await jsonRequest<ResourceView[]>("/v3/resource-packages", { cookie: adminCookie })
      const regions = await jsonRequest<Array<{ packageId: string; sceneType: string }>>("/v3/resource-packages/regions/catalog?sceneType=CITY_LOGISTICS", { cookie: adminCookie })
      const region = regions[0]!
      const selectedResources = [
        original,
        resources.find((item) => item.status === "ACTIVE" && item.source === "BUILT_IN" && item.packageType === "REGION" && item.id === region.packageId),
        resources.find((item) => item.status === "ACTIVE" && item.source === "BUILT_IN" && item.packageType === "SCALE_TEMPLATE" && item.manifest.sceneType === "CITY_LOGISTICS"),
        resources.find((item) => item.status === "ACTIVE" && item.source === "BUILT_IN" && item.packageType === "EVENT" && item.manifest.sceneType === "CITY_LOGISTICS"),
        resources.find((item) => item.status === "ACTIVE" && item.source === "BUILT_IN" && item.packageType === "AIRCRAFT"),
        resources.find((item) => item.status === "ACTIVE" && item.source === "BUILT_IN" && item.packageType === "REPORT")
      ]
      expect(selectedResources.every(Boolean)).toBe(true)
      const classes = await jsonRequest<Array<{ id: string }>>("/v1/education/classes", { cookie: teacherCookie })
      const draft = await jsonRequest<{ id: string; revision: number }>("/v3/assignments/drafts", {
        method: "POST",
        cookie: teacherCookie,
        body: {
          title: `资源冻结与密钥轮换 ${randomUUID()}`,
          sceneType: "CITY_LOGISTICS",
          mode: "TRAINING",
          config: {
            taskBrief: "验证资源升级后历史任务仍使用发布时冻结版本",
            scaleTemplateCode: "LOGISTICS_3",
            regionPackageId: region.packageId,
            availableAt: new Date(Date.now() - 60_000).toISOString(),
            dueAt: new Date(Date.now() + 86_400_000).toISOString(),
            allowResubmission: true,
            allowedValidationAttempts: 3,
            allowedRuntimeAttempts: 2,
            resultVisibility: "FULL_REVIEW",
            scenario: { orderCount: 3, orderReleaseMode: "BATCH", timeWindowMinutes: 30 }
          }
        }
      })
      assignmentId = draft.id
      const targets = [{ type: "CLASS", targetId: classes[0]!.id }]
      const resourcePackageIds = selectedResources.map((item) => item!.id)
      const preview = await jsonRequest<{ configHash: string }>(`/v3/assignments/drafts/${draft.id}/preview`, {
        method: "POST",
        cookie: teacherCookie,
        body: { expectedRevision: draft.revision, targets, resourcePackageIds }
      })
      const published = await jsonRequest<{ snapshot: AssignmentSnapshot }>(`/v3/assignments/drafts/${draft.id}/publish`, {
        method: "POST",
        cookie: teacherCookie,
        body: { expectedRevision: draft.revision, configHash: preview.configHash, targets, resourcePackageIds }
      })
      const frozenReference = published.snapshot.resourceRefs.find((item) => item.packageId === original.id)
      expect(frozenReference).toMatchObject({ version: "1.0.0", sha256: original.sha256 })

      const rotatedPublicKey = rotatedKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString()
      await writeTrustedKeys({ [rotatedKeyId]: rotatedPublicKey })
      const replacementArchive = await archiveFor("1.1.0", { name: rotatedName, keyId: rotatedKeyId, keyPair: rotatedKeyPair })
      const replacementResponse = await uploadArchive(replacementArchive, adminCookie, "rotation-rules-1.1.0.zip")
      const replacement = await replacementResponse.json() as ResourceView
      expect(replacementResponse.status, JSON.stringify(replacement)).toBe(201)
      packageIds.push(replacement.id)
      expect(replacement).toMatchObject({ status: "STAGED", validation: { signatureKeyId: rotatedKeyId } })
      await jsonRequest<ResourceView>(`/v3/resource-packages/${replacement.id}/activate`, {
        method: "POST",
        cookie: adminCookie,
        body: { reason: "切换到轮换后的签名密钥" }
      })

      const afterUpgrade = await jsonRequest<AssignmentSnapshot>(`/v3/assignments/${published.snapshot.id}/snapshot`, { cookie: teacherCookie })
      expect(afterUpgrade.checksum).toBe(published.snapshot.checksum)
      expect(afterUpgrade.resourceRefs).toEqual(published.snapshot.resourceRefs)
      expect((await jsonRequest<ResourceDetail>(`/v3/resource-packages/${original.id}`, { cookie: adminCookie })).package.status).toBe("RETIRED")

      const staleArchive = await archiveFor("1.2.0", { name: rotatedName })
      const staleResponse = await uploadArchive(staleArchive, adminCookie, "rotation-rules-stale-key.zip")
      const stale = await staleResponse.json() as ResourceView
      expect(staleResponse.status, JSON.stringify(stale)).toBe(201)
      packageIds.push(stale.id)
      expect(stale).toMatchObject({ status: "REJECTED" })
      expect(stale.validation.rejectionReason).toContain("签名密钥未受信任")

      const downloaded = await fetch(`${baseUrl}/v3/resource-packages/${original.id}/archive`, { headers: { Cookie: adminCookie } })
      expect(downloaded.status, await downloaded.clone().text()).toBe(200)
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(originalArchive)
      const rejectedRollback = await fetch(`${baseUrl}/v3/resource-packages/${original.id}/rollback`, {
        method: "POST",
        headers: { Cookie: adminCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "验证已移除公钥不能回滚旧版本" })
      })
      expect(rejectedRollback.status, await rejectedRollback.clone().text()).toBe(409)
      expect(await rejectedRollback.text()).toContain("签名密钥未受信任")

      await writeTrustedKeys({
        [keyId]: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
        [rotatedKeyId]: rotatedPublicKey
      })
      const rolledBack = await jsonRequest<ResourceView>(`/v3/resource-packages/${original.id}/rollback`, {
        method: "POST",
        cookie: adminCookie,
        body: { reason: "恢复归档验证公钥后回滚历史版本" }
      })
      expect(rolledBack.status).toBe("ACTIVE")
      const afterRollback = await jsonRequest<AssignmentSnapshot>(`/v3/assignments/${published.snapshot.id}/snapshot`, { cookie: teacherCookie })
      expect(afterRollback).toEqual(afterUpgrade)
    } finally {
      if (assignmentId) {
        await jsonRequest(`/v3/assignments/${assignmentId}/withdraw`, { method: "POST", cookie: teacherCookie, body: { reason: "资源生命周期集成验收清理" } }).catch(() => undefined)
        await jsonRequest(`/v3/assignments/drafts/${assignmentId}`, { method: "DELETE", cookie: teacherCookie }).catch(() => undefined)
      }
      await writeTrustedKeys({ [keyId]: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString() })
    }
  })

  async function archiveFor(version: string, options: { name?: string; keyId?: string; keyPair?: typeof keyPair } = {}): Promise<Buffer> {
    return createSignedResourceArchive({
      privateKey: options.keyPair?.privateKey ?? keyPair.privateKey,
      keyId: options.keyId ?? keyId,
      name: options.name ?? packageName,
      version
    })
  }

  async function writeTrustedKeys(keys: Record<string, string>): Promise<void> {
    await writeFile(trustedKeysPath, `${JSON.stringify(keys)}\n`, "utf8")
  }

  async function uploadArchive(archive: Buffer, cookie: string, filename: string): Promise<Response> {
    const form = new FormData()
    form.append("file", new Blob([new Uint8Array(archive)], { type: "application/zip" }), filename)
    return fetch(`${baseUrl}/v3/resource-packages/upload`, { method: "POST", headers: { Cookie: cookie }, body: form })
  }

  async function login(email: string, password: string): Promise<string> {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    })
    expect(response.status, await response.clone().text()).toBe(201)
    return response.headers.get("set-cookie")!.split(";", 1)[0]!
  }

  async function jsonRequest<T>(path: string, options: { method?: string; cookie: string; body?: unknown }): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: { Cookie: options.cookie, ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    })
    const body = await response.json() as unknown
    expect(response.status, `${JSON.stringify(body)}\n${serverOutput}`).toBeLessThan(400)
    return body as T
  }

  async function waitForServer(): Promise<void> {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (serverProcess.exitCode !== null) throw new Error(`资源集成服务提前退出：${serverProcess.exitCode}\n${serverOutput}`)
      try {
        const response = await fetch(`${baseUrl}/auth/me`)
        if (response.status === 401) return
      } catch {
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }
    throw new Error(`等待资源集成服务启动超时\n${serverOutput}`)
  }
})

interface ResourceView {
  id: string
  packageType: string
  name: string
  version: string
  source: string
  status: string
  sha256: string
  manifest: Record<string, unknown>
  archiveAsset: { originalName: string; sizeBytes: number } | null
  validation: {
    passed: boolean
    signatureKeyId: string | null
    rejectionReason: string | null
    checks: Array<{ code: string; passed: boolean; message: string }>
  }
}

interface AssignmentSnapshot {
  id: string
  checksum: string
  resourceRefs: Array<{ packageId: string; packageType: string; name: string; version: string; sha256: string }>
}

interface ResourceDetail {
  package: ResourceView
  validations: Array<{ status: string }>
  lifecycle: Array<{ action: string; previousPackageId: string | null }>
}

function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("无法分配集成测试端口"))
        return
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port))
    })
  })
}
