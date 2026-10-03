import { createHash } from "node:crypto"
import { execFile as execFileCallback, spawn } from "node:child_process"
import { createReadStream, createWriteStream } from "node:fs"
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { finished } from "node:stream/promises"
import { dirname, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)
const command = process.argv[2] ?? "help"
const argumentsByName = parseArguments(process.argv.slice(3))
const workingDirectory = resolve(argumentsByName["working-directory"] ?? process.cwd())
const composeFiles = parseComposeFiles(argumentsByName["compose-files"])

try {
  if (command === "help" || argumentsByName.help === true || argumentsByName.help === "true") printUsage()
  else if (command === "build") await buildRelease()
  else if (command === "verify") await verifyRelease(resolveRequired("input"))
  else if (command === "install") await installRelease(resolveRequired("input"))
  else if (command === "rollback") await rollbackRelease(resolveRequired("state"))
  else printUsage()
} catch (error) {
  if ((command === "install" || command === "rollback") && isEnvironmentBlocked(error)) {
    process.stdout.write(`${JSON.stringify({
      format: command === "install" ? "wurenji-software-installation" : "wurenji-software-rollback",
      formatVersion: 1,
      status: "BLOCKED",
      completedAt: new Date().toISOString(),
      reason: error instanceof Error ? error.message : String(error)
    })}\n`)
    process.exitCode = 1
  } else {
    throw error
  }
}

async function buildRelease() {
  const version = requireSemver(argumentsByName.version ?? await packageVersion())
  const minimumCompatibleVersion = requireSemver(argumentsByName["minimum-compatible-version"] ?? version)
  const outputPath = resolve(argumentsByName.output ?? `data/software-releases/wurenji-${version}`)
  if (await exists(outputPath)) throw new Error(`发布目录已存在，拒绝覆盖：${outputPath}`)
  const temporaryPath = `${outputPath}.building-${process.pid}`
  const platformImage = argumentsByName["platform-image"] ?? `wurenji-platform:${version}`
  const backupImage = argumentsByName["backup-image"] ?? `wurenji-backup:${version}`
  const sourceDate = new Date().toISOString()
  try {
    await mkdir(resolve(temporaryPath, "images"), { recursive: true })
    await mkdir(resolve(temporaryPath, "deployment", "deploy", "nginx"), { recursive: true })
    const buildEnvironment = { PLATFORM_VERSION: version, PLATFORM_IMAGE: platformImage, BACKUP_IMAGE: backupImage }
    if (!await imageExists(platformImage)) await compose(["build", "app"], buildEnvironment)
    if (!await imageExists(backupImage)) await compose(["build", "backup"], buildEnvironment)
    assert(await imageExists(platformImage), `构建后未找到镜像：${platformImage}`)
    assert(await imageExists(backupImage), `构建后未找到镜像：${backupImage}`)
    const platformInspection = await inspectImage(platformImage)
    const backupInspection = await inspectImage(backupImage)
    assert(platformInspection.configVersion === version, `${platformImage} 内 PLATFORM_VERSION=${platformInspection.configVersion || "缺失"}`)
    assert(backupInspection.configVersion === version, `${backupImage} 内 PLATFORM_VERSION=${backupInspection.configVersion || "缺失"}`)
    assert(platformInspection.os === "linux" && platformInspection.architecture === "amd64", `${platformImage} 不是 linux/amd64 镜像`)
    assert(backupInspection.os === "linux" && backupInspection.architecture === "amd64", `${backupImage} 不是 linux/amd64 镜像`)

    const platformArchive = resolve(temporaryPath, "images", "platform.tar")
    const backupArchive = resolve(temporaryPath, "images", "backup.tar")
    await saveDockerImage(platformImage, platformArchive)
    await saveDockerImage(backupImage, backupArchive)

    const deploymentFiles = [
      "docker-compose.yml",
      "deploy/docker-compose.production.yml",
      "deploy/nginx/nginx.conf",
      "deploy/nginx/default.conf",
      "deploy/nginx/map.conf"
    ]
    for (const source of deploymentFiles) await copyFileChecked(resolve(workingDirectory, source), safePath(resolve(temporaryPath, "deployment"), source))
    const migrations = await migrationManifest()
    const releaseEnvironment = [
      `PLATFORM_VERSION=${version}`,
      `PLATFORM_IMAGE=${platformImage}`,
      `BACKUP_IMAGE=${backupImage}`,
      ""
    ].join("\n")
    await writeFile(resolve(temporaryPath, "release.env"), releaseEnvironment, "utf8")
    await writeFile(resolve(temporaryPath, "ROLLBACK.md"), [
      `# 低空无人集群教学仿真软件 ${version} 回滚说明`,
      "",
      "安装前会生成恢复点和 installation-state.json。发生故障时，只能使用该状态文件执行 rollback。",
      "回滚将停止应用写入、重建目标数据库、清空目标业务文件和对象桶，并恢复升级前镜像。",
      ""
    ].join("\n"), "utf8")

    const artifacts = await artifactManifest(temporaryPath, new Set(["manifest.json"]))
    const manifest = {
      format: "wurenji-software-release",
      formatVersion: 1,
      createdAt: sourceDate,
      version,
      minimumCompatibleVersion,
      platform: "linux/amd64",
      images: {
        platform: { reference: platformImage, id: platformInspection.id, archive: "images/platform.tar" },
        backup: { reference: backupImage, id: backupInspection.id, archive: "images/backup.tar" }
      },
      migrations,
      artifacts
    }
    await writeJson(resolve(temporaryPath, "manifest.json"), manifest)
    await verifyRelease(temporaryPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await rename(temporaryPath, outputPath)
    process.stdout.write(`Software release built: ${outputPath}\n`)
  } catch (error) {
    await rm(temporaryPath, { recursive: true, force: true })
    throw error
  }
}

async function verifyRelease(inputPath) {
  const manifest = await readManifest(inputPath)
  requireSemver(manifest.version)
  requireSemver(manifest.minimumCompatibleVersion)
  assert(compareSemver(manifest.minimumCompatibleVersion, manifest.version) <= 0, "最低兼容版本不能高于发布版本")
  assert(manifest.platform === "linux/amd64", `不支持的平台：${manifest.platform}`)
  assert(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0, "发布清单缺少 artifacts")
  assert(Array.isArray(manifest.migrations?.files), "发布清单缺少 migrations.files")
  for (const required of ["release.env", "ROLLBACK.md", "deployment/docker-compose.yml", "deployment/deploy/docker-compose.production.yml", "deployment/deploy/nginx/nginx.conf", "deployment/deploy/nginx/default.conf", "deployment/deploy/nginx/map.conf"]) {
    assert(manifest.artifacts.some((artifact) => artifact.path === required), `发布包缺少必需文件：${required}`)
  }
  const declaredPaths = new Set()
  for (const artifact of manifest.artifacts) {
    validateArtifact(artifact)
    assert(!declaredPaths.has(artifact.path), `发布清单包含重复文件：${artifact.path}`)
    declaredPaths.add(artifact.path)
    const artifactPath = safePath(inputPath, artifact.path)
    const details = await stat(artifactPath)
    assert(!(await lstat(artifactPath)).isSymbolicLink(), `发布文件不能是符号链接：${artifact.path}`)
    assert(details.isFile() && details.size === artifact.sizeBytes, `发布文件大小不匹配：${artifact.path}`)
    assert(await hashFile(artifactPath) === artifact.sha256, `发布文件 SHA-256 不匹配：${artifact.path}`)
  }
  const actualPaths = (await walkFiles(inputPath)).map((path) => normalizePath(relative(inputPath, path))).filter((path) => path !== "manifest.json")
  const extra = actualPaths.filter((path) => !declaredPaths.has(path))
  const missing = [...declaredPaths].filter((path) => !actualPaths.includes(path))
  assert(extra.length === 0, `发布目录包含未声明文件：${extra.join(", ")}`)
  assert(missing.length === 0, `发布清单声明了缺失文件：${missing.join(", ")}`)
  for (const image of [manifest.images?.platform, manifest.images?.backup]) {
    assert(image?.reference && /^sha256:[a-f0-9]{64}$/.test(image.id), "发布镜像清单无效")
    assert(declaredPaths.has(image.archive), `镜像归档未纳入 artifacts：${image.archive}`)
  }
  for (const migration of manifest.migrations.files) validateArtifact(migration)
  const migrationFiles = manifest.migrations.files.map((item) => `${item.path}\0${item.sizeBytes}\0${item.sha256}`).join("\n")
  assert(sha256(Buffer.from(migrationFiles)) === manifest.migrations.sha256, "migration 清单摘要不匹配")
  const releaseEnvironment = await readEnvironmentFile(safePath(inputPath, "release.env"))
  assert(releaseEnvironment.PLATFORM_VERSION === manifest.version, "release.env 版本与 manifest 不一致")
  assert(releaseEnvironment.PLATFORM_IMAGE === manifest.images.platform.reference, "release.env 平台镜像与 manifest 不一致")
  assert(releaseEnvironment.BACKUP_IMAGE === manifest.images.backup.reference, "release.env 备份镜像与 manifest 不一致")
  process.stdout.write(`Software release verified: ${inputPath} (${manifest.artifacts.length} files)\n`)
  return manifest
}

async function installRelease(inputPath) {
  if (argumentsByName.confirm !== "INSTALL") throw new Error("安装需要参数 --confirm INSTALL")
  const manifest = await verifyRelease(inputPath)
  const installComposeFiles = argumentsByName["compose-files"] ? composeFiles : releaseComposeFiles(inputPath)
  const currentVersion = requireSemver(argumentsByName["current-version"] ?? await liveVersion(argumentsByName["base-url"] ?? "http://localhost:3000"))
  assert(compareSemver(currentVersion, manifest.minimumCompatibleVersion) >= 0, `当前版本 ${currentVersion} 低于最低兼容版本 ${manifest.minimumCompatibleVersion}`)
  const statePath = resolve(argumentsByName["state-output"] ?? `data/software-releases/installations/${timestamp()}-${manifest.version}`)
  if (await exists(statePath)) throw new Error(`安装状态目录已存在：${statePath}`)
  await mkdir(statePath, { recursive: true })
  const recoveryPointPath = resolve(statePath, "recovery-point")
  const evidencePath = resolve(statePath, "install-evidence.json")
  const previousEnvironment = await resolvePreviousEnvironment(currentVersion, installComposeFiles)
  const previousImages = {
    platform: { reference: previousEnvironment.PLATFORM_IMAGE, archive: "previous-images/platform.tar" },
    backup: { reference: previousEnvironment.BACKUP_IMAGE, archive: "previous-images/backup.tar" }
  }
  const rollbackTool = {
    reference: manifest.images.backup.reference,
    id: manifest.images.backup.id,
    archive: "rollback-tool/backup.tar"
  }
  const targetEnvironment = {
    ...previousEnvironment,
    PLATFORM_VERSION: manifest.version,
    PLATFORM_IMAGE: manifest.images.platform.reference,
    BACKUP_IMAGE: manifest.images.backup.reference
  }
  const startedAt = new Date().toISOString()
  let evidence
  try {
    await mkdir(resolve(statePath, "previous-images"), { recursive: true })
    const previousPlatformInspection = await inspectImage(previousImages.platform.reference)
    const previousBackupInspection = await inspectImage(previousImages.backup.reference)
    previousImages.platform.id = previousPlatformInspection.id
    previousImages.backup.id = previousBackupInspection.id
    assert(previousPlatformInspection.configVersion === currentVersion, "当前平台镜像内版本与健康接口不一致")
    assert(previousBackupInspection.configVersion === currentVersion, "当前备份镜像内版本与健康接口不一致")
    await saveDockerImage(previousImages.platform.reference, resolve(statePath, previousImages.platform.archive))
    await saveDockerImage(previousImages.backup.reference, resolve(statePath, previousImages.backup.archive))
    await mkdir(resolve(statePath, "rollback-tool"), { recursive: true })
    await copyFileChecked(safePath(inputPath, manifest.images.backup.archive), resolve(statePath, rollbackTool.archive))
    await compose(["stop", "app", "worker"], {}, installComposeFiles)
    await runBackupImage(previousEnvironment, ["create", "--output", "/app/backups/recovery-point"], statePath, installComposeFiles)
    await runBackupImage(previousEnvironment, ["verify", "--input", "/app/backups/recovery-point"], statePath, installComposeFiles)
    await loadDockerImage(safePath(inputPath, manifest.images.platform.archive))
    await loadDockerImage(safePath(inputPath, manifest.images.backup.archive))
    await assertImageIdentity(manifest.images.platform.reference, manifest.images.platform.id, manifest.version)
    await assertImageIdentity(manifest.images.backup.reference, manifest.images.backup.id, manifest.version)
    const targetEnvironmentFile = resolve(statePath, "target.env")
    const previousEnvironmentFile = resolve(statePath, "previous.env")
    await writeEnvironmentFile(targetEnvironmentFile, targetEnvironment)
    await writeEnvironmentFile(previousEnvironmentFile, previousEnvironment)
    await compose(["up", "-d", "migrate"], targetEnvironment, installComposeFiles)
    await compose(["up", "-d", "--no-build", "app", "worker"], targetEnvironment, installComposeFiles)
    const readiness = await waitForReady(argumentsByName["base-url"] ?? "http://localhost:3000", manifest.version)
    evidence = {
      format: "wurenji-software-installation",
      formatVersion: 1,
      status: "PASSED",
      startedAt,
      completedAt: new Date().toISOString(),
      release: { path: inputPath, version: manifest.version, manifestSha256: await hashFile(resolve(inputPath, "manifest.json")) },
      previous: previousEnvironment,
      composeFiles: installComposeFiles,
      previousImages,
      rollbackTool,
      target: targetEnvironment,
      recoveryPoint: { path: recoveryPointPath, manifestSha256: await hashFile(resolve(recoveryPointPath, "manifest.json")) },
      readiness
    }
  } catch (error) {
    evidence = { format: "wurenji-software-installation", formatVersion: 1, status: isEnvironmentBlocked(error) ? "BLOCKED" : "FAILED", startedAt, completedAt: new Date().toISOString(), release: { path: inputPath, version: manifest.version }, reason: error instanceof Error ? error.message : String(error) }
  }
  await writeJson(evidencePath, evidence)
  await writeJson(resolve(statePath, "installation-state.json"), {
    format: "wurenji-software-installation-state",
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    status: evidence.status,
    previous: previousEnvironment,
    composeFiles: installComposeFiles,
    previousImages,
    rollbackTool,
    installed: targetEnvironment,
    recoveryPoint: recoveryPointPath,
    installEvidence: evidencePath
  })
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\nInstallation state: ${statePath}\n`)
  if (evidence.status !== "PASSED") process.exitCode = 1
}

async function rollbackRelease(statePath) {
  if (argumentsByName.confirm !== "ROLLBACK" || argumentsByName["confirm-data-restore"] !== "RESTORE_PRE_UPGRADE_DATA") {
    throw new Error("回滚需要 --confirm ROLLBACK --confirm-data-restore RESTORE_PRE_UPGRADE_DATA")
  }
  const stateFile = safePath(statePath, "installation-state.json")
  const state = JSON.parse(await readFile(stateFile, "utf8"))
  validateInstallationState(state)
  const stateComposeFiles = state.composeFiles.map((value) => resolve(value))
  const evidencePath = resolve(statePath, `rollback-evidence-${timestamp()}.json`)
  const startedAt = new Date().toISOString()
  let evidence
  try {
    await compose(["stop", "app", "worker"], state.installed, stateComposeFiles)
    await loadDockerImage(safePath(statePath, state.rollbackTool.archive))
    await assertImageIdentity(state.rollbackTool.reference, state.rollbackTool.id, state.installed.PLATFORM_VERSION)
    await runBackupImage({ ...state.installed, BACKUP_IMAGE: state.rollbackTool.reference }, [
      "restore", "--input", "/app/backups/recovery-point", "--mode", "EXACT", "--confirm", "RESTORE", "--confirm-exact", "REPLACE_DATABASE_AND_FILES"
    ], statePath, stateComposeFiles)
    await loadDockerImage(safePath(statePath, state.previousImages.platform.archive))
    await loadDockerImage(safePath(statePath, state.previousImages.backup.archive))
    await assertImageIdentity(state.previousImages.platform.reference, state.previousImages.platform.id, state.previous.PLATFORM_VERSION)
    await assertImageIdentity(state.previousImages.backup.reference, state.previousImages.backup.id, state.previous.PLATFORM_VERSION)
    await compose(["up", "-d", "--no-build", "app", "worker"], state.previous, stateComposeFiles)
    const readiness = await waitForReady(argumentsByName["base-url"] ?? "http://localhost:3000", state.previous.PLATFORM_VERSION)
    const recoveryManifest = JSON.parse(await readFile(resolve(state.recoveryPoint, "manifest.json"), "utf8"))
    evidence = {
      format: "wurenji-software-rollback",
      formatVersion: 1,
      status: "PASSED",
      startedAt,
      completedAt: new Date().toISOString(),
      fromVersion: state.installed.PLATFORM_VERSION,
      toVersion: state.previous.PLATFORM_VERSION,
      recoveryPoint: { path: state.recoveryPoint, applicationVersion: recoveryManifest.applicationVersion, tableCounts: recoveryManifest.database.tableCounts ?? {} },
      readiness
    }
  } catch (error) {
    evidence = { format: "wurenji-software-rollback", formatVersion: 1, status: isEnvironmentBlocked(error) ? "BLOCKED" : "FAILED", startedAt, completedAt: new Date().toISOString(), reason: error instanceof Error ? error.message : String(error) }
  }
  await writeJson(evidencePath, evidence)
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\nRollback evidence: ${evidencePath}\n`)
  if (evidence.status !== "PASSED") process.exitCode = 1
}

async function resolvePreviousEnvironment(currentVersion, files = composeFiles) {
  const config = await composeConfig({ PLATFORM_VERSION: currentVersion }, files)
  const platformImage = config.services?.app?.image
  const backupImage = config.services?.backup?.image
  assert(platformImage && backupImage, "无法从 Compose 配置解析当前镜像")
  return { PLATFORM_VERSION: currentVersion, PLATFORM_IMAGE: platformImage, BACKUP_IMAGE: backupImage }
}

async function runBackupImage(environment, backupArguments, statePath, files = composeFiles) {
  await compose([
    "run", "--rm", "--no-deps",
    "-v", `${normalizeDockerPath(statePath)}:/app/backups`,
    "backup", ...backupArguments
  ], environment, files)
}

async function inspectImage(reference) {
  const result = await execFile("docker", ["image", "inspect", reference, "--format", "{{json .}}"], executionOptions())
  const value = JSON.parse(result.stdout)
  return {
    id: value.Id,
    os: value.Os,
    architecture: value.Architecture,
    configVersion: value.Config?.Env?.map((item) => item.split("=", 2)).find(([name]) => name === "PLATFORM_VERSION")?.[1] ?? ""
  }
}

async function assertImageIdentity(reference, expectedId, version) {
  const image = await inspectImage(reference)
  assert(image.id === expectedId, `${reference} 镜像 ID 与发布清单不一致`)
  assert(image.configVersion === version, `${reference} 镜像内版本不一致`)
}

async function saveDockerImage(reference, outputPath) {
  await runStreaming("docker", ["image", "save", reference], { outputPath })
}

async function loadDockerImage(inputPath) {
  await runStreaming("docker", ["image", "load"], { inputPath })
}

async function runStreaming(commandName, argumentsList, { inputPath, outputPath }) {
  const child = spawn(commandName, argumentsList, { cwd: workingDirectory, env: process.env, windowsHide: true, stdio: [inputPath ? "pipe" : "ignore", outputPath ? "pipe" : "ignore", "pipe"] })
  const errors = []
  child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)))
  const completion = new Promise((resolveCompletion, rejectCompletion) => {
    child.once("error", rejectCompletion)
    child.once("close", (code) => code === 0 ? resolveCompletion() : rejectCompletion(new Error(`${commandName} ${argumentsList.join(" ")} 退出码 ${code}：${Buffer.concat(errors).toString("utf8").trim()}`)))
  })
  const streams = []
  if (inputPath) {
    const input = createReadStream(inputPath)
    input.pipe(child.stdin)
    streams.push(finished(input))
  }
  if (outputPath) {
    const output = createWriteStream(outputPath)
    child.stdout.pipe(output)
    streams.push(finished(output))
  }
  await Promise.all([completion, ...streams])
}

async function compose(argumentsList, environment = {}, files = composeFiles) {
  const fileArguments = files.flatMap((path) => ["-f", path])
  const profiles = ["--profile", "worker", "--profile", "backup"]
  await execFile("docker", ["compose", "--project-directory", workingDirectory, ...fileArguments, ...profiles, ...argumentsList], executionOptions(environment))
}

async function composeConfig(environment = {}, files = composeFiles) {
  const fileArguments = files.flatMap((path) => ["-f", path])
  const result = await execFile("docker", ["compose", "--project-directory", workingDirectory, ...fileArguments, "--profile", "worker", "--profile", "backup", "config", "--format", "json"], executionOptions(environment))
  return JSON.parse(result.stdout)
}

async function waitForReady(baseUrl, expectedVersion) {
  const url = `${baseUrl.replace(/\/$/, "")}/api/readyz`
  const timeoutAt = Date.now() + Number(argumentsByName["health-timeout-ms"] ?? 180_000)
  let lastReason = "尚未请求"
  while (Date.now() < timeoutAt) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
      const body = await response.json()
      if (response.ok && body.status === "ready" && body.database === "ok" && body.version === expectedVersion) return { url, body }
      lastReason = `HTTP ${response.status} ${JSON.stringify(body)}`
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000))
  }
  throw new Error(`等待就绪超时：${lastReason}`)
}

async function liveVersion(baseUrl) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/healthz`, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`无法读取当前版本：HTTP ${response.status}`)
  const body = await response.json()
  return body.version
}

async function migrationManifest() {
  const root = resolve(workingDirectory, "apps/server/src/database/migrations")
  const files = []
  for (const path of await walkFiles(root)) {
    const details = await stat(path)
    files.push({ path: normalizePath(relative(workingDirectory, path)), sizeBytes: details.size, sha256: await hashFile(path) })
  }
  files.sort((left, right) => left.path.localeCompare(right.path))
  const digestInput = files.map((item) => `${item.path}\0${item.sizeBytes}\0${item.sha256}`).join("\n")
  return { sha256: sha256(Buffer.from(digestInput)), files }
}

async function artifactManifest(rootPath, excluded) {
  const artifacts = []
  for (const path of await walkFiles(rootPath)) {
    const relativePath = normalizePath(relative(rootPath, path))
    if (excluded.has(relativePath)) continue
    const details = await stat(path)
    artifacts.push({ path: relativePath, sizeBytes: details.size, sha256: await hashFile(path) })
  }
  return artifacts.sort((left, right) => left.path.localeCompare(right.path))
}

async function readManifest(rootPath) {
  const manifest = JSON.parse(await readFile(safePath(rootPath, "manifest.json"), "utf8"))
  assert(manifest?.format === "wurenji-software-release" && manifest.formatVersion === 1, "不支持的软件发布包格式")
  return manifest
}

function validateInstallationState(value) {
  assert(value?.format === "wurenji-software-installation-state" && value.formatVersion === 1, "不支持的安装状态格式")
  assert(Array.isArray(value.composeFiles) && value.composeFiles.length > 0, "安装状态缺少 Compose 配置路径")
  for (const path of value.composeFiles) assert(path === resolve(path), `安装状态 Compose 路径必须为绝对路径：${path}`)
  for (const environment of [value.previous, value.installed]) {
    requireSemver(environment?.PLATFORM_VERSION)
    assert(environment.PLATFORM_IMAGE && environment.BACKUP_IMAGE, "安装状态缺少镜像引用")
  }
  for (const image of [value.previousImages?.platform, value.previousImages?.backup]) {
    assert(image?.reference && /^sha256:[a-f0-9]{64}$/.test(image.id), "安装状态缺少旧镜像身份")
    safePath(".", image.archive)
  }
  assert(value.rollbackTool?.reference && /^sha256:[a-f0-9]{64}$/.test(value.rollbackTool.id), "安装状态缺少回滚工具镜像")
  safePath(".", value.rollbackTool.archive)
  const root = resolve(value.recoveryPoint)
  assert(root.includes(`${sep}data${sep}software-releases${sep}installations${sep}`) || argumentsByName["allow-external-state"] === "true", `恢复点不在安装状态目录：${root}`)
}

function validateArtifact(artifact) {
  assert(typeof artifact?.path === "string" && normalizePath(artifact.path) === artifact.path, `发布文件路径无效：${artifact?.path}`)
  assert(!artifact.path.split("/").some((segment) => segment === "." || segment === ".." || segment === ""), `发布文件路径包含非法片段：${artifact.path}`)
  safePath(".", artifact.path)
  assert(Number.isInteger(artifact.sizeBytes) && artifact.sizeBytes >= 0, `发布文件大小无效：${artifact.path}`)
  assert(/^[a-f0-9]{64}$/.test(artifact.sha256), `发布文件摘要无效：${artifact.path}`)
}

function requireSemver(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.test(value)) throw new Error(`无效语义版本：${value ?? "缺失"}`)
  return value
}

function compareSemver(left, right) {
  const leftParts = left.split("-", 1)[0].split(".").map(Number)
  const rightParts = right.split("-", 1)[0].split(".").map(Number)
  for (let index = 0; index < 3; index += 1) if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index]
  return 0
}

async function readEnvironmentFile(path) {
  const result = {}
  for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const delimiter = trimmed.indexOf("=")
    if (delimiter < 1) throw new Error(`环境文件行无效：${line}`)
    result[trimmed.slice(0, delimiter)] = trimmed.slice(delimiter + 1)
  }
  return result
}

async function writeEnvironmentFile(path, values) {
  const content = Object.entries(values).map(([name, value]) => `${name}=${value}`).join("\n") + "\n"
  await writeFile(path, content, "utf8")
}

async function copyFileChecked(source, destination) {
  const content = await readFile(source)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, content)
}

async function walkFiles(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) result.push(...await walkFiles(path))
    else if (entry.isFile()) result.push(path)
  }
  return result
}

function safePath(rootPath, childPath) {
  if (typeof childPath !== "string" || !childPath || childPath.includes("\\") || childPath.startsWith("/") || /^[A-Za-z]:/.test(childPath)) throw new Error(`不安全的相对路径：${childPath}`)
  const root = resolve(rootPath)
  const target = resolve(root, childPath)
  if (target === root || !target.startsWith(`${root}${sep}`)) throw new Error(`路径越界：${childPath}`)
  return target
}

async function imageExists(reference) {
  try { await execFile("docker", ["image", "inspect", reference], executionOptions()); return true } catch { return false }
}

function executionOptions(environment = {}) {
  const filtered = Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined))
  return { cwd: workingDirectory, env: { ...process.env, ...filtered }, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
}

function isEnvironmentBlocked(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|failed to connect|connection refused|docker daemon|docker desktop|cannot connect to the docker|spawn docker ENOENT|超时|timeout/i.test(message)
}

async function packageVersion() {
  return JSON.parse(await readFile(resolve(workingDirectory, "package.json"), "utf8")).version
}

function parseComposeFiles(value) {
  const paths = (value ?? "docker-compose.yml").split(",").map((item) => item.trim()).filter(Boolean)
  return paths.map((path) => resolve(workingDirectory, path))
}

function releaseComposeFiles(inputPath) {
  const files = [safePath(inputPath, "deployment/docker-compose.yml")]
  if (argumentsByName.production === true || argumentsByName.production === "true") files.push(safePath(inputPath, "deployment/deploy/docker-compose.production.yml"))
  return files
}

function normalizeDockerPath(path) { return resolve(path).replaceAll("\\", "/") }
function normalizePath(path) { return path.split(sep).join("/") }
function sha256(content) { return createHash("sha256").update(content).digest("hex") }
async function hashFile(path) {
  const hash = createHash("sha256")
  const input = createReadStream(path)
  for await (const chunk of input) hash.update(chunk)
  return hash.digest("hex")
}
async function writeJson(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8") }
async function exists(path) { try { await stat(path); return true } catch { return false } }
function assert(condition, message) { if (!condition) throw new Error(message) }
function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").toLowerCase() }
function resolveRequired(name) { const value = argumentsByName[name]; if (!value) throw new Error(`缺少参数 --${name}`); return resolve(value) }

function parseArguments(values) {
  const result = {}
  for (let index = 0; index < values.length;) {
    const name = values[index]
    if (!name?.startsWith("--")) throw new Error(`参数无效：${name ?? ""}`)
    const value = values[index + 1]
    if (value === undefined || value.startsWith("--")) {
      result[name.slice(2)] = true
      index += 1
    } else {
      result[name.slice(2)] = value
      index += 2
    }
  }
  return result
}

function printUsage() {
  process.stdout.write([
    "用法：",
    "  npm run software:build -- --version 0.2.0 --output data/software-releases/wurenji-0.2.0",
    "  npm run software:verify -- --input data/software-releases/wurenji-0.2.0",
    "  npm run software:install -- --input <发布目录> --confirm INSTALL",
    "  npm run software:rollback -- --state <安装状态目录> --confirm ROLLBACK --confirm-data-restore RESTORE_PRE_UPGRADE_DATA",
    "",
    "install 和 rollback 会操作 Compose 服务和业务数据，必须先确认环境变量及 compose-files 指向目标环境。"
  ].join("\n") + "\n")
}
