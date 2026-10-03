import { Injectable, NotFoundException, OnModuleInit } from "@nestjs/common"
import { createHash, randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, resolve, sep, win32 } from "node:path"
import { Client as MinioClient } from "minio"
import { workspaceRoot } from "../../config/runtime-paths.js"
import type { FileStorageProvider } from "./file-asset.entity.js"

export interface StoredFile {
  storageProvider: FileStorageProvider
  objectKey: string
  sizeBytes: number
  sha256: string
}

@Injectable()
export class V3FileStorageService implements OnModuleInit {
  readonly provider = normalizeProvider(process.env.V3_FILE_STORAGE_PROVIDER)
  private readonly local = new LocalStorageAdapter()
  private readonly minio = new MinioStorageAdapter()

  async onModuleInit(): Promise<void> {
    if (this.provider === "MINIO") await this.requireMinio().initialize()
  }

  async write(objectKey: string, content: Buffer, mimeType = "application/octet-stream"): Promise<StoredFile> {
    validateObjectKey(objectKey)
    await this.adapter(this.provider).write(objectKey, content, mimeType)
    return {
      storageProvider: this.provider,
      objectKey,
      sizeBytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex")
    }
  }

  async read(objectKey: string, provider: FileStorageProvider = this.provider): Promise<Buffer> {
    validateObjectKey(objectKey)
    return this.adapter(provider).read(objectKey)
  }

  async delete(objectKey: string, provider: FileStorageProvider = this.provider): Promise<void> {
    validateObjectKey(objectKey)
    await this.adapter(provider).delete(objectKey)
  }

  private adapter(provider: FileStorageProvider): StorageAdapter {
    if (provider === "LOCAL") return this.local
    if (provider === "MINIO" || provider === "S3") return this.requireMinio()
    throw new Error(`不支持的文件存储提供方：${provider}`)
  }

  private requireMinio(): MinioStorageAdapter {
    return this.minio
  }
}

interface StorageAdapter {
  write(objectKey: string, content: Buffer, mimeType: string): Promise<void>
  read(objectKey: string): Promise<Buffer>
  delete(objectKey: string): Promise<void>
}

class LocalStorageAdapter implements StorageAdapter {
  private readonly root = resolveLocalStorageRoot()

  async write(objectKey: string, content: Buffer): Promise<void> {
    const path = this.resolveObjectKey(objectKey)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, { flag: "wx" })
  }

  async read(objectKey: string): Promise<Buffer> {
    try {
      return await readFile(this.resolveObjectKey(objectKey))
    } catch (error) {
      if (isMissingFile(error)) throw new NotFoundException("文件资产内容不存在")
      throw error
    }
  }

  async delete(objectKey: string): Promise<void> {
    await rm(this.resolveObjectKey(objectKey), { force: true })
  }

  private resolveObjectKey(objectKey: string): string {
    const path = resolve(this.root, objectKey.replaceAll("/", sep))
    if (path !== this.root && !path.startsWith(`${this.root}${sep}`)) throw new Error("文件对象键越界")
    return path
  }
}

export function resolveLocalStorageRoot(
  configuredDirectory = process.env.V3_FILE_STORAGE_DIR,
  workingDirectory = process.cwd(),
  directoryExists: (path: string) => boolean = existsSync
): string {
  if (configuredDirectory?.trim()) {
    const configured = configuredDirectory.trim()
    if (isAbsolute(configured) || win32.isAbsolute(configured)) return resolvePath(configured)
    // V3_FILE_STORAGE_DIR is documented as repository-relative. When the
    // process is started from apps/server, resolving `./apps/server/...`
    // against cwd would duplicate that segment. Resolve it from the detected
    // repository root instead while preserving ordinary cwd-relative paths.
    const baseDirectory = isServerDirectory(workingDirectory) && isServerRelativeDirectory(configured)
      ? repositoryRoot(workingDirectory)
      : workingDirectory
    const workingDirectoryPath = resolvePath(baseDirectory, configured)
    if (directoryExists(workingDirectoryPath)) return workingDirectoryPath
    const workspaceDirectoryPath = resolvePath(workspaceRoot, configured)
    if (directoryExists(workspaceDirectoryPath)) return workspaceDirectoryPath
    return workingDirectoryPath
  }

  const root = repositoryRoot(workingDirectory)
  const candidates = [
    resolvePath(root, "apps/server/data/v3-files"),
    resolvePath(root, "data/v3-files")
  ]
  return candidates.find((candidate) => directoryExists(candidate)) ?? candidates[1]!
}

/**
 * Resolve a path on the host platform while recognizing Windows drive paths
 * when tests or configuration are evaluated on Linux/macOS. Node's native
 * `resolve` intentionally treats `E:/...` as relative on POSIX, so using this
 * helper keeps the drive prefix intact without duplicating repository pieces.
 */
function resolvePath(...parts: string[]): string {
  const first = parts[0] ?? ""
  return resolve(first, ...parts.slice(1))
}

function isServerDirectory(directory: string): boolean {
  const normalized = directory.replaceAll("\\", "/").replace(/\/+$/, "")
  return /\/apps\/server$/i.test(normalized)
}

function isServerRelativeDirectory(directory: string): boolean {
  const normalized = directory.replaceAll("\\", "/").replace(/^\.\//, "")
  return normalized === "apps/server" || normalized.startsWith("apps/server/")
}

function repositoryRoot(directory: string): string {
  if (!isServerDirectory(directory)) return directory
  const normalized = directory.replaceAll("\\", "/").replace(/\/+$/, "")
  return normalized.slice(0, normalized.length - "/apps/server".length)
}

class MinioStorageAdapter implements StorageAdapter {
  private readonly bucket = process.env.MINIO_BUCKET?.trim() || "wurenji"
  private readonly client = new MinioClient({
    endPoint: process.env.MINIO_ENDPOINT?.trim() || "localhost",
    port: normalizePort(process.env.MINIO_PORT ?? "59000"),
    useSSL: process.env.MINIO_USE_SSL === "true",
    accessKey: process.env.MINIO_ACCESS_KEY?.trim() || randomBytes(16).toString("hex"),
    secretKey: process.env.MINIO_SECRET_KEY?.trim() || randomBytes(24).toString("hex")
  })
  private initialized = false

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (!await this.client.bucketExists(this.bucket)) await this.client.makeBucket(this.bucket)
    this.initialized = true
  }

  async write(objectKey: string, content: Buffer, mimeType: string): Promise<void> {
    await this.initialize()
    await this.client.putObject(this.bucket, objectKey, content, content.byteLength, { "Content-Type": mimeType })
  }

  async read(objectKey: string): Promise<Buffer> {
    await this.initialize()
    try {
      const stream = await this.client.getObject(this.bucket, objectKey)
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      return Buffer.concat(chunks)
    } catch (error) {
      if (isMissingObject(error)) throw new NotFoundException("文件资产内容不存在")
      throw error
    }
  }

  async delete(objectKey: string): Promise<void> {
    await this.initialize()
    await this.client.removeObject(this.bucket, objectKey)
  }
}

function normalizeProvider(value: string | undefined): FileStorageProvider {
  const provider = value?.trim().toUpperCase() || "LOCAL"
  if (provider !== "LOCAL" && provider !== "MINIO" && provider !== "S3") throw new Error("V3_FILE_STORAGE_PROVIDER 必须为 LOCAL、MINIO 或 S3")
  return provider
}

function normalizePort(value: string | undefined): number {
  const port = Number(value ?? 9000)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("MINIO_PORT 无效")
  return port
}

function validateObjectKey(objectKey: string): void {
  if (!objectKey || objectKey.includes("\0") || objectKey.startsWith("/") || objectKey.split("/").includes("..")) throw new Error("文件对象键无效")
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function isMissingObject(error: unknown): boolean {
  return error instanceof Error && "code" in error && ["NoSuchKey", "NoSuchObject", "NotFound"].includes(String(error.code))
}
