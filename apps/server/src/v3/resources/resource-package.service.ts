import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common"
import { InjectRepository } from "@nestjs/typeorm"
import { createHash, randomUUID } from "node:crypto"
import { EntityManager, In, Repository } from "typeorm"
import {
  parseScaleTemplatePackage,
  isSupportedShowScaleTemplateCode,
  showTemplateAircraftCount,
  resourcePackageTypes,
  type AuthUser,
  type AssignmentDraftConfig,
  type ResourcePackageType,
  type SceneType,
  showDocumentTemplateCodes,
  showDocumentTemplateTitles,
  type ShowDocumentTemplateCode,
  type V3FileAssetView,
  type V3RegionCatalogItem,
  type V3RegionMapReadinessView,
  type V3ResourceArchiveManifest,
  type V3ResourcePackageView,
  type V3ResourceReference,
  type V3ResourceValidationCheck,
  type V3ScaleTemplateCatalogItem
} from "@wurenji/shared"
import { UserEntity } from "../../entities.js"
import { FileAssetEntity } from "../files/file-asset.entity.js"
import { V3FileStorageService } from "../files/file-storage.service.js"
import {
  ResourceArchiveValidationError,
  ResourceArchiveValidator,
  type InspectedResourceArchive,
  type ValidatedResourceArchive
} from "./resource-archive.validator.js"
import { parseRegionCatalogItem } from "./region-catalog.js"
import {
  rubricFromContent,
  teacherScoresFromRubric,
  type EvaluationRubricDefinition
} from "./evaluation-rubric.js"
import {
  ResourcePackageEntity,
  ResourcePackageLifecycleEventEntity,
  ResourcePackageValidationRunEntity
} from "./resource-package.entity.js"
import { checkRegionMapReadiness } from "./map-resource-readiness.js"
import { isShowProgramManifest, parseShowProgramCsv } from "./show-program-import.js"
import { canonicalJson } from "../common/canonical-json.js"

interface RegisterResourcePackageInput {
  packageType?: ResourcePackageType
  name?: string
  version?: string
  schemaVersion?: number
  minimumPlatformVersion?: string
  sha256?: string
  manifest?: Record<string, unknown>
}

export interface ResolvedShowDocumentTemplate {
  packageId: string
  packageVersion: string
  packageSha256: string
  code: ShowDocumentTemplateCode
  title: string
  filename: string
  path: string
}

export interface ResolvedEvaluationRubric {
  packageId: string | null
  packageVersion: string | null
  packageSha256: string | null
  rubricVersion: string
  resourceDefined: boolean
  definition: EvaluationRubricDefinition
  teacherScores: ReturnType<typeof teacherScoresFromRubric>
}

export interface ResourceUpgradePlan {
  currentResourceRefs: V3ResourceReference[]
  candidateResourceRefs: V3ResourceReference[]
  changes: Array<{
    packageType: ResourcePackageType
    current: V3ResourceReference
    replacement: V3ResourceReference
  }>
}

type LifecycleAction = ResourcePackageLifecycleEventEntity["action"]

@Injectable()
export class ResourcePackageService {
  constructor(
    @InjectRepository(ResourcePackageEntity) private readonly packages: Repository<ResourcePackageEntity>,
    @InjectRepository(ResourcePackageValidationRunEntity) private readonly validationRuns: Repository<ResourcePackageValidationRunEntity>,
    @InjectRepository(ResourcePackageLifecycleEventEntity) private readonly lifecycleEvents: Repository<ResourcePackageLifecycleEventEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    private readonly archiveValidator: ResourceArchiveValidator,
    private readonly storage: V3FileStorageService
  ) {}

  async list(user: AuthUser): Promise<V3ResourcePackageView[]> {
    const packages = await this.packages.find({
      where: user.role === "admin" ? {} : { status: "ACTIVE" },
      order: { packageType: "ASC", name: "ASC", createdAt: "DESC" }
    })
    return packages
      .filter((item) => user.role === "admin" || item.packageType !== "DOCUMENT_TEMPLATE" || isFormalShowDocumentPackage(item))
      .map((item) => this.serialize(item))
  }

  async detail(id: string, user: AuthUser) {
    const item = await this.findVisible(id, user)
    const [validations, lifecycle] = user.role === "admin"
      ? await Promise.all([
          this.validationRuns.find({ where: { packageId: id }, order: { createdAt: "DESC" } }),
          this.lifecycleEvents.find({ where: { packageId: id }, order: { createdAt: "DESC" } })
        ])
      : [[], []]
    return {
      package: this.serialize(item),
      validations: validations.map((run) => ({
        id: run.id,
        status: run.status,
        archiveSha256: run.archiveSha256,
        signatureKeyId: run.signatureKeyId,
        checks: run.checks,
        errorMessage: run.errorMessage,
        actorName: run.actor.displayName,
        completedAt: run.completedAt.toISOString()
      })),
      lifecycle: lifecycle.map((event) => ({
        id: event.id,
        action: event.action,
        previousPackageId: event.previousPackageId,
        reason: event.reason,
        actorName: event.actor.displayName,
        createdAt: event.createdAt.toISOString()
      }))
    }
  }

  async listRegions(sceneType?: SceneType): Promise<V3RegionCatalogItem[]> {
    const packages = await this.packages.find({
      where: { packageType: "REGION", status: "ACTIVE" },
      order: { name: "ASC", createdAt: "DESC" }
    })
    return packages
      .map(parseRegionCatalogItem)
      .filter((item): item is V3RegionCatalogItem => item !== null && (!sceneType || item.sceneType === sceneType))
      .sort((left, right) => left.sceneType.localeCompare(right.sceneType) || left.title.localeCompare(right.title, "zh-CN"))
  }

  async mapReadiness(id: string) {
    const item = await this.packages.findOne({ where: { id, packageType: "REGION", status: In(["ACTIVE", "RETIRED"]) } })
    const region = item ? parseRegionCatalogItem(item) : null
    if (!region) throw new NotFoundException("区域资源不可用")
    return checkRegionMapReadiness(region)
  }

  async findRegion(packageId: string, manager: EntityManager = this.packages.manager): Promise<V3RegionCatalogItem> {
    const item = await manager.findOne(ResourcePackageEntity, { where: { id: packageId, packageType: "REGION", status: In(["ACTIVE", "RETIRED"]) } })
    const region = item ? parseRegionCatalogItem(item) : null
    if (!region) throw new NotFoundException("项目引用的区域资源不可用")
    return region
  }

  async assertAssignmentRegionReady(
    sceneType: SceneType,
    packageId: string,
    manager: EntityManager = this.packages.manager,
    requireFormalMapResources = formalMapResourcesRequired()
  ): Promise<V3RegionCatalogItem> {
    const region = await this.findRegion(packageId, manager)
    if (region.sceneType !== sceneType) throw new BadRequestException(`任务场景 ${sceneType} 与区域资源 ${region.title} 不匹配`)
    if (requireFormalMapResources) assertFormalMapReadiness(region, await checkRegionMapReadiness(region), requireFormalMapResources)
    return region
  }

  async listScaleTemplates(sceneType?: SceneType): Promise<V3ScaleTemplateCatalogItem[]> {
    const packages = await this.packages.find({
      where: { packageType: "SCALE_TEMPLATE", status: "ACTIVE" },
      order: { name: "ASC", createdAt: "DESC" }
    })
    return packages
      .flatMap((item) => parseScaleTemplatePackage(item))
      .filter((item) => !sceneType || item.sceneType === sceneType)
      .sort((left, right) => left.sceneType.localeCompare(right.sceneType) || left.totalAircraft - right.totalAircraft)
  }

  async assertScaleTemplateAvailable(
    sceneType: SceneType,
    templateCode: string,
    refs: V3ResourceReference[],
    manager: EntityManager = this.packages.manager
  ): Promise<void> {
    if (sceneType === "CITY_SHOW" && !isSupportedShowScaleTemplateCode(templateCode)) {
      throw new BadRequestException("V1.0 编队表演仅支持 100、500、1000、3000 架模板")
    }
    const ids = refs.filter((ref) => ref.packageType === "SCALE_TEMPLATE").map((ref) => ref.packageId)
    const packages = ids.length > 0
      ? await manager.find(ResourcePackageEntity, { where: { id: In(ids), packageType: "SCALE_TEMPLATE", status: In(["ACTIVE", "RETIRED"]) } })
      : []
    const templates = packages.flatMap((item) => parseScaleTemplatePackage(item))
    if (!templates.some((item) => item.sceneType === sceneType && item.code === templateCode)) {
      throw new BadRequestException("固定规模模板不属于当前发布资源或场景")
    }
  }

  async resolveShowDocumentTemplates(refs: V3ResourceReference[]): Promise<ResolvedShowDocumentTemplate[]> {
    const packageIds = refs.filter((ref) => ref.packageType === "DOCUMENT_TEMPLATE").map((ref) => ref.packageId)
    const packages = packageIds.length > 0
      ? await this.packages.find({ where: { id: In(packageIds) } })
      : []
    const templates = packages.flatMap((item) => parseShowDocumentTemplates(item))
    const byCode = new Map(templates.map((template) => [template.code, template]))
    const missing = showDocumentTemplateCodes.filter((code) => !byCode.has(code))
    if (missing.length > 0) throw new ConflictException(`任务引用的文档资源缺少正式母版：${missing.join("、")}`)
    return showDocumentTemplateCodes.map((code) => byCode.get(code)!)
  }

  async resolveEvaluationRubric(
    sceneType: SceneType,
    refs: V3ResourceReference[],
    manager: EntityManager = this.packages.manager
  ): Promise<ResolvedEvaluationRubric> {
    const reportReferences = refs
      .filter((ref) => ref.packageType === "REPORT")
      .sort((left, right) => compareSemanticVersions(right.version, left.version) || left.name.localeCompare(right.name) || left.packageId.localeCompare(right.packageId))
    if (reportReferences.length === 0) {
      const { rubric } = rubricFromContent(sceneType, {})
      return {
        packageId: null,
        packageVersion: null,
        packageSha256: null,
        rubricVersion: sceneType === "CITY_SHOW" ? "SHOW-RUBRIC@1.1.0" : sceneType === "CITY_LOGISTICS" ? "LOGISTICS-RUBRIC@1.0.0" : "VTL-RUBRIC@1.0.0",
        resourceDefined: false,
        definition: rubric,
        teacherScores: teacherScoresFromRubric(rubric)
      }
    }
    const reference = reportReferences[0]!
    const item = await manager.findOne(ResourcePackageEntity, { where: { id: reference.packageId } })
    if (!item || item.packageType !== "REPORT") throw new ConflictException("项目冻结的 REPORT 资源不存在")
    if (item.status !== "ACTIVE" && item.status !== "RETIRED") throw new ConflictException("项目冻结的 REPORT 资源不可读取")
    if (item.name !== reference.name || item.version !== reference.version || item.sha256 !== reference.sha256) {
      throw new ConflictException("项目冻结的 REPORT 资源摘要与资源记录不一致")
    }
    let resolved: ReturnType<typeof rubricFromContent>
    try {
      resolved = rubricFromContent(sceneType, item.manifest)
    } catch (error) {
      throw new ConflictException(`项目冻结的 REPORT 评价量表无效：${normalizeError(error)}`)
    }
    const rubricVersion = resolved.resourceDefined
      ? formatRubricVersion(item.name, item.version, resolved.rubric.version)
      : formatLegacyRubricVersion(item.name, item.version)
    return {
      packageId: item.id,
      packageVersion: item.version,
      packageSha256: item.sha256,
      rubricVersion,
      resourceDefined: resolved.resourceDefined,
      definition: resolved.rubric,
      teacherScores: teacherScoresFromRubric(resolved.rubric)
    }
  }

  async readArchiveEntry(packageId: string, path: string, expectedPackageSha256: string): Promise<Buffer> {
    const item = await this.packages.findOne({ where: { id: packageId } })
    if (!item || item.packageType !== "DOCUMENT_TEMPLATE") throw new NotFoundException("文档模板资源不存在")
    if (item.sha256 !== expectedPackageSha256) throw new ConflictException("项目冻结的文档模板摘要与资源记录不一致")
    if (item.status !== "ACTIVE" && item.status !== "RETIRED") throw new ConflictException("项目冻结的文档模板资源不可读取")
    if (!item.archiveAsset || !item.archiveManifest) throw new ConflictException("文档模板资源没有可读取的签名归档")
    const descriptor = item.archiveManifest.files.find((file) => file.path === path)
    if (!descriptor || !path.startsWith("payload/") || descriptor.mimeType !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      throw new ConflictException("项目冻结的 Word 母版声明无效")
    }
    const archive = await this.storage.read(item.archiveAsset.objectKey, item.archiveAsset.storageProvider)
    const inspected = await this.archiveValidator.inspect(archive)
    if (inspected.archiveSha256 !== item.sha256) throw new ConflictException("文档模板归档内容已损坏")
    const content = inspected.entries.get(path)
    if (!content || sha256(content) !== descriptor.sha256 || content.byteLength !== descriptor.sizeBytes) {
      throw new ConflictException("Word 母版内容与资源清单不一致")
    }
    return content
  }

  async upload(user: AuthUser, file: Express.Multer.File | undefined): Promise<V3ResourcePackageView> {
    this.requireAdmin(user)
    if (!file) throw new BadRequestException("请选择资源包 ZIP 文件")
    if (!file.originalname.toLowerCase().endsWith(".zip")) throw new BadRequestException("资源包文件扩展名必须为 .zip")
    const inspected = await this.archiveValidator.inspect(file.buffer)
    const { packageType, name, version, schemaVersion, minimumPlatformVersion } = inspected.identity
    if (await this.packages.findOne({ where: { packageType, name, version } })) throw new ConflictException("同名同版本资源包已存在")
    const owner = await this.users.findOneByOrFail({ id: user.id })
    const item = this.packages.create({
      id: randomUUID(),
      packageType,
      name,
      version,
      schemaVersion,
      minimumPlatformVersion,
      sha256: inspected.archiveSha256,
      status: "UPLOADED",
      source: "SIGNED_ARCHIVE",
      manifest: isPlainObject(inspected.rawManifest.content) ? inspected.rawManifest.content : {},
      archiveManifest: inspected.rawManifest as unknown as V3ResourceArchiveManifest,
      archiveAsset: null,
      signatureKeyId: null,
      validationChecks: [],
      validatedAt: null,
      rejectionReason: null,
      createdBy: owner,
      activatedAt: null,
      retiredAt: null
    })
    await this.packages.save(item)
    const objectKey = `resource-packages/${item.id}/${inspected.archiveSha256}.zip`
    let fileWritten = false
    try {
      const stored = await this.storage.write(objectKey, file.buffer, "application/zip")
      fileWritten = true
      if (stored.sha256 !== inspected.archiveSha256) throw new Error("资源包写入后的 SHA-256 与上传内容不一致")
      await this.packages.manager.transaction(async (manager) => {
        const asset = await manager.save(FileAssetEntity, manager.create(FileAssetEntity, {
          id: randomUUID(),
          category: "RESOURCE_PACKAGE",
          storageProvider: stored.storageProvider,
          objectKey: stored.objectKey,
          originalName: sanitizeFilename(file.originalname),
          mimeType: "application/zip",
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          status: "AVAILABLE",
          ownerType: "RESOURCE_PACKAGE",
          ownerId: item.id,
          createdBy: owner
        }))
        item.archiveAsset = asset
        item.status = "VALIDATING"
        await manager.save(ResourcePackageEntity, item)
        await this.recordLifecycle(manager, item, owner, "UPLOADED", null, null)
      })
    } catch (error) {
      if (fileWritten) await this.storage.delete(objectKey, this.storage.provider).catch(() => undefined)
      await this.packages.delete(item.id).catch(() => undefined)
      throw error
    }
    return this.preflight(item.id, user, inspected)
  }

  async importShowProgram(
    user: AuthUser,
    file: Express.Multer.File | undefined,
    input: { name?: string; version?: string; sourceSoftware?: string }
  ): Promise<V3ResourcePackageView> {
    this.requireAdmin(user)
    if (!file) throw new BadRequestException("请选择舞步轨迹 CSV 文件")
    if (!file.originalname.toLowerCase().endsWith(".csv")) throw new BadRequestException("舞步轨迹文件扩展名必须为 .csv")
    const name = input.name?.trim()
    const version = input.version?.trim()
    if (!name || name.length > 120) throw new BadRequestException("表演程序名称不能为空且不能超过 120 个字符")
    if (!isSemanticVersion(version)) throw new BadRequestException("表演程序版本必须使用语义版本，例如 1.0.0")
    let parsed: ReturnType<typeof parseShowProgramCsv>
    try {
      parsed = parseShowProgramCsv(file.buffer, input.sourceSoftware ?? "")
    } catch (error) {
      throw new BadRequestException(normalizeError(error))
    }
    const failedChecks = parsed.checks.filter((check) => !check.passed)
    if (failedChecks.length > 0) {
      throw new BadRequestException(`舞步轨迹空间校验未通过：${failedChecks.map((check) => check.message).join("；")}`)
    }
    if (await this.packages.findOne({ where: { packageType: "SHOW_PROGRAM", name, version } })) {
      throw new ConflictException("同名同版本表演程序已存在")
    }
    const owner = await this.users.findOneByOrFail({ id: user.id })
    const id = randomUUID()
    const digest = sha256(file.buffer)
    const item = this.packages.create({
      id,
      packageType: "SHOW_PROGRAM",
      name,
      version,
      schemaVersion: 1,
      minimumPlatformVersion: "0.1.0",
      sha256: digest,
      status: "STAGED",
      source: "IMPORTED_TRAJECTORY",
      manifest: parsed.manifest as unknown as Record<string, unknown>,
      archiveManifest: null,
      archiveAsset: null,
      signatureKeyId: null,
      validationChecks: parsed.checks,
      validatedAt: new Date(),
      rejectionReason: null,
      createdBy: owner,
      activatedAt: null,
      retiredAt: null
    })
    await this.packages.save(item)
    const objectKey = `resource-packages/${id}/${digest}.csv`
    let fileWritten = false
    try {
      const stored = await this.storage.write(objectKey, file.buffer, "text/csv; charset=utf-8")
      fileWritten = true
      await this.packages.manager.transaction(async (manager) => {
        item.archiveAsset = await manager.save(FileAssetEntity, manager.create(FileAssetEntity, {
          id: randomUUID(),
          category: "RESOURCE_PACKAGE",
          storageProvider: stored.storageProvider,
          objectKey: stored.objectKey,
          originalName: sanitizeFilename(file.originalname),
          mimeType: "text/csv; charset=utf-8",
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          status: "AVAILABLE",
          ownerType: "RESOURCE_PACKAGE",
          ownerId: item.id,
          createdBy: owner
        }))
        await manager.save(ResourcePackageEntity, item)
        await this.recordLifecycle(manager, item, owner, "UPLOADED", null, `从 ${parsed.manifest.sourceSoftware} 导入`)
        await this.recordLifecycle(manager, item, owner, "PREFLIGHT_PASSED", null, "舞步轨迹结构与运行边界校验通过")
      })
    } catch (error) {
      if (fileWritten) await this.storage.delete(objectKey, this.storage.provider).catch(() => undefined)
      await this.packages.delete(item.id).catch(() => undefined)
      throw error
    }
    return this.serialize(await this.packages.findOneByOrFail({ id }))
  }

  async preflight(id: string, user: AuthUser, prepared?: InspectedResourceArchive): Promise<V3ResourcePackageView> {
    this.requireAdmin(user)
    const item = await this.packages.findOne({ where: { id } })
    if (!item) throw new NotFoundException("资源包不存在")
    if (item.source !== "SIGNED_ARCHIVE" || !item.archiveAsset) throw new ConflictException("只有签名归档资源包可以执行预检")
    if (item.status === "ACTIVE" || item.status === "RETIRED") throw new ConflictException("已激活或已退役资源包不能重新预检")
    const actor = await this.users.findOneByOrFail({ id: user.id })
    item.status = "VALIDATING"
    item.validatedAt = null
    item.rejectionReason = null
    await this.packages.save(item)
    try {
      const content = prepared ? null : await this.storage.read(item.archiveAsset.objectKey, item.archiveAsset.storageProvider)
      const inspected = prepared ?? await this.archiveValidator.inspect(content!)
      assertArchiveIdentity(item, inspected)
      if (inspected.archiveSha256 !== item.sha256 || inspected.archiveSha256 !== item.archiveAsset.sha256) throw new ResourceArchiveValidationError("ARCHIVE_HASH", "归档文件 SHA-256 与资源记录不一致")
      const validated = await this.archiveValidator.validate(inspected)
      const checks = [...validated.checks]
      if (validated.manifest.packageType === "DOCUMENT_TEMPLATE") {
        assertFormalShowDocumentManifest(validated.manifest, inspected.entries)
        checks.push({ code: "DOCUMENT_TEMPLATES", passed: true, message: "Three signed DOCX application templates are present and consistent with the archive manifest" })
      }
      if (validated.manifest.packageType === "REGION") {
        assertFormalRegionManifest(validated.manifest, item, checks)
      }
      assertPlatformCompatible(item)
      checks.push({ code: "PLATFORM_COMPATIBILITY", passed: true, message: `最低平台版本 ${item.minimumPlatformVersion} 已满足` })
      await this.assertDependencies(validated.manifest, false)
      checks.push({ code: "DEPENDENCIES", passed: true, message: `已解析 ${validated.manifest.dependencies.length} 个资源依赖` })
      await this.finishPreflight(item, actor, validated, checks)
    } catch (error) {
      await this.rejectPreflight(item, actor, error)
    }
    return this.serialize(await this.packages.findOneByOrFail({ id }))
  }

  async register(user: AuthUser, input: RegisterResourcePackageInput) {
    this.requireAdmin(user)
    if (process.env.V3_ALLOW_UNSIGNED_RESOURCE_REGISTRATION !== "true") throw new ForbiddenException("无签名资源元数据注册已禁用，请上传签名 ZIP")
    const packageType = input.packageType
    const name = input.name?.trim()
    const version = input.version?.trim()
    const minimumPlatformVersion = input.minimumPlatformVersion?.trim() || "0.1.0"
    const sha256 = input.sha256?.trim().toLowerCase()
    const schemaVersion = Number(input.schemaVersion ?? 1)
    if (!packageType || !resourcePackageTypes.includes(packageType)) throw new BadRequestException("资源包类型无效")
    if (!name || name.length > 120) throw new BadRequestException("资源包名称不能为空且不能超过 120 个字符")
    if (!isSemanticVersion(version)) throw new BadRequestException("资源包版本必须使用语义版本，例如 1.0.0")
    if (!isSemanticVersion(minimumPlatformVersion)) throw new BadRequestException("最低平台版本必须使用语义版本")
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1) throw new BadRequestException("资源包 schemaVersion 必须为正整数")
    if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) throw new BadRequestException("资源包 SHA-256 无效")
    if (input.manifest !== undefined && !isPlainObject(input.manifest)) throw new BadRequestException("资源包 manifest 必须为 JSON 对象")
    if (await this.packages.findOne({ where: { packageType, name, version } })) throw new ConflictException("同名同版本资源包已存在")
    const owner = await this.users.findOneByOrFail({ id: user.id })
    const now = new Date()
    const item = await this.packages.save(this.packages.create({
      packageType,
      name,
      version,
      schemaVersion,
      minimumPlatformVersion,
      sha256,
      status: "STAGED",
      source: "UNSIGNED_TEST",
      manifest: input.manifest ?? {},
      archiveManifest: null,
      archiveAsset: null,
      signatureKeyId: null,
      validationChecks: [{ code: "UNSIGNED_TEST", passed: true, message: "仅集成测试允许的无签名资源" }],
      validatedAt: now,
      rejectionReason: null,
      createdBy: owner,
      activatedAt: null,
      retiredAt: null
    }))
    return this.serialize(item)
  }

  async activate(id: string, user: AuthUser, reason?: string) {
    this.requireAdmin(user)
    return this.transitionToActive(id, user, "ACTIVATED", reason)
  }

  async rollback(id: string, user: AuthUser, reason?: string) {
    this.requireAdmin(user)
    return this.transitionToActive(id, user, "ROLLED_BACK", reason, true)
  }

  async retire(id: string, user: AuthUser, reason?: string) {
    this.requireAdmin(user)
    const normalizedReason = normalizeReason(reason)
    const actor = await this.users.findOneByOrFail({ id: user.id })
    await this.packages.manager.transaction("SERIALIZABLE", async (manager) => {
      await lockResourcePackage(manager, id)
      const item = await manager.findOneBy(ResourcePackageEntity, { id })
      if (!item) throw new NotFoundException("资源包不存在")
      if (item.status === "RETIRED") return
      if (item.status !== "ACTIVE" && item.status !== "STAGED") throw new ConflictException("当前资源包状态不能退役")
      item.status = "RETIRED"
      item.retiredAt = new Date()
      await manager.save(item)
      await this.recordLifecycle(manager, item, actor, "RETIRED", null, normalizedReason)
    })
    return this.serialize(await this.packages.findOneByOrFail({ id }))
  }

  async downloadArchive(id: string, user: AuthUser): Promise<{ asset: FileAssetEntity; content: Buffer }> {
    this.requireAdmin(user)
    const item = await this.packages.findOne({ where: { id } })
    if (!item) throw new NotFoundException("资源包不存在")
    if (!item.archiveAsset) throw new NotFoundException("该资源没有签名归档文件")
    const content = await this.storage.read(item.archiveAsset.objectKey, item.archiveAsset.storageProvider)
    return { asset: item.archiveAsset, content }
  }

  async resolveActiveReferences(ids: string[], manager: EntityManager = this.packages.manager): Promise<V3ResourceReference[]> {
    const uniqueIds = [...new Set(ids)]
    if (uniqueIds.length === 0) throw new BadRequestException("发布任务必须引用资源包")
    const packages = await manager.find(ResourcePackageEntity, { where: { id: In(uniqueIds) } })
    if (packages.length !== uniqueIds.length) throw new BadRequestException("存在无效的资源包引用")
    const unavailable = packages.filter((item) => item.status !== "ACTIVE")
    if (unavailable.length > 0) throw new ConflictException(`资源包尚未激活：${unavailable.map((item) => item.name).join("、")}`)
    packages.forEach(assertPlatformCompatible)
    for (const item of packages.filter((resource) => resource.packageType === "DOCUMENT_TEMPLATE")) {
      await this.assertShowDocumentPackageReadable(item)
    }
    return packages
      .sort((left, right) => left.packageType.localeCompare(right.packageType) || left.name.localeCompare(right.name) || left.version.localeCompare(right.version))
      .map((item) => ({
        packageId: item.id,
        packageType: item.packageType,
        name: item.name,
        version: item.version,
        sha256: item.sha256
      }))
  }

  async assertShowProgramAvailable(
    sceneType: SceneType,
    config: AssignmentDraftConfig,
    refs: V3ResourceReference[],
    manager: EntityManager = this.packages.manager
  ): Promise<void> {
    const selectedId = config.showProgramPackageId?.trim() || null
    const programRefs = refs.filter((ref) => ref.packageType === "SHOW_PROGRAM")
    if (sceneType !== "CITY_SHOW") {
      if (selectedId || programRefs.length > 0) throw new BadRequestException("非编队表演任务不能引用舞步程序")
      return
    }
    if (!selectedId) {
      if (programRefs.length > 0) throw new BadRequestException("任务未选择舞步程序，但发布资源包含 SHOW_PROGRAM")
      return
    }
    if (programRefs.length !== 1 || programRefs[0]!.packageId !== selectedId) {
      throw new BadRequestException("任务选择的舞步程序必须且只能引用一个匹配的 SHOW_PROGRAM 资源")
    }
    const item = await manager.findOne(ResourcePackageEntity, { where: { id: selectedId, packageType: "SHOW_PROGRAM", status: "ACTIVE" } })
    if (!item || !isShowProgramManifest(item.manifest)) throw new ConflictException("舞步程序不存在、未激活或内容无效")
    const failedChecks = Array.isArray(item.validationChecks)
      ? (item.validationChecks as unknown as V3ResourceValidationCheck[]).filter((check) => !check.passed)
      : []
    if (failedChecks.length > 0) throw new ConflictException(`舞步程序空间校验未通过：${failedChecks.map((check) => check.message).join("；")}`)
    const expectedAircraft = showTemplateAircraftCount(config.scaleTemplateCode)
    if (item.manifest.aircraftCount !== expectedAircraft) {
      throw new BadRequestException(`舞步程序包含 ${item.manifest.aircraftCount} 架无人机，与 ${expectedAircraft} 架固定规模模板不一致`)
    }
    const maximumHeightMeters = config.showParameters?.maximumHeightMeters
    if (maximumHeightMeters !== undefined && item.manifest.maximumAltitudeMeters > maximumHeightMeters) {
      throw new BadRequestException(`舞步程序最大高度 ${item.manifest.maximumAltitudeMeters} m 超过任务限制 ${maximumHeightMeters} m`)
    }
  }

  async showProgramValidationChecks(
    packageId: string | null | undefined,
    manager: EntityManager = this.packages.manager
  ): Promise<V3ResourceValidationCheck[]> {
    if (!packageId) return []
    const item = await manager.findOne(ResourcePackageEntity, { where: { id: packageId, packageType: "SHOW_PROGRAM" } })
    return Array.isArray(item?.validationChecks) ? item.validationChecks as unknown as V3ResourceValidationCheck[] : []
  }

  async planActiveReferenceUpgrade(
    sceneType: SceneType,
    refs: V3ResourceReference[],
    manager: EntityManager = this.packages.manager
  ): Promise<ResourceUpgradePlan> {
    const frozenPackages = refs.length > 0
      ? await manager.find(ResourcePackageEntity, { where: { id: In(refs.map((ref) => ref.packageId)) } })
      : []
    if (frozenPackages.length !== new Set(refs.map((ref) => ref.packageId)).size) {
      throw new ConflictException("任务冻结的资源引用不完整")
    }
    const frozenById = new Map(frozenPackages.map((item) => [item.id, item]))
    for (const reference of refs) {
      const item = frozenById.get(reference.packageId)
      if (!item || (item.status !== "ACTIVE" && item.status !== "RETIRED")) throw new ConflictException("任务冻结的资源不可读取")
      if (item.packageType !== reference.packageType || item.name !== reference.name || item.version !== reference.version || item.sha256 !== reference.sha256) {
        throw new ConflictException("任务冻结的资源摘要与资源记录不一致")
      }
    }
    const active = await manager.find(ResourcePackageEntity, { where: { status: "ACTIVE" } })
    const currentResourceRefs = [...refs]
    const candidateResourceRefs = currentResourceRefs.map((current) => {
      const replacement = active
        .filter((item) => item.id !== current.packageId)
        .filter((item) => item.packageType === current.packageType)
        .filter((item) => item.manifest.testOnly !== true)
        .filter((item) => {
          if (item.packageType === "REPORT") return supportsReportScene(item, sceneType)
          if (item.packageType === "DOCUMENT_TEMPLATE") return sceneType === "CITY_SHOW" && item.name === current.name && isFormalShowDocumentPackage(item)
          return item.name === current.name
        })
        .filter((item) => compareSemanticVersions(item.version, current.version) > 0)
        .sort((left, right) => compareSemanticVersions(right.version, left.version) || left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id))[0]
      if (!replacement) return current
      assertPlatformCompatible(replacement)
      return toReference(replacement)
    })
    for (const reference of candidateResourceRefs.filter((item, index) => item.packageId !== currentResourceRefs[index]?.packageId && item.packageType === "DOCUMENT_TEMPLATE")) {
      await this.assertShowDocumentPackageReadable(active.find((item) => item.id === reference.packageId)!)
    }
    return {
      currentResourceRefs,
      candidateResourceRefs,
      changes: currentResourceRefs.flatMap((current, index) => {
        const replacement = candidateResourceRefs[index]
        return replacement && replacement.packageId !== current.packageId
          ? [{ packageType: current.packageType, current, replacement }]
          : []
      })
    }
  }

  private async transitionToActive(id: string, user: AuthUser, action: "ACTIVATED" | "ROLLED_BACK", reason?: string, rollbackOnly = false) {
    const actor = await this.users.findOneByOrFail({ id: user.id })
    const normalizedReason = normalizeReason(reason)
    await this.packages.manager.transaction("SERIALIZABLE", async (manager) => {
      await lockResourcePackage(manager, id)
      const item = await manager.findOneBy(ResourcePackageEntity, { id })
      if (!item) throw new NotFoundException("资源包不存在")
      if (item.status === "ACTIVE") return
      if (rollbackOnly && item.status !== "RETIRED") throw new ConflictException("只有已退役版本可以执行回滚")
      if (!rollbackOnly && item.status !== "STAGED") throw new ConflictException("只有通过预检的待激活版本可以激活")
      assertPlatformCompatible(item)
      assertValidatedForActivation(item)
      await this.assertArchiveTrustedForActivation(item)
      if (item.packageType === "DOCUMENT_TEMPLATE" && !isFormalShowDocumentPackage(item)) {
        throw new ConflictException("Document template packages must contain three signed DOCX master templates")
      }
      if (item.archiveManifest) await this.assertDependencies(item.archiveManifest, true, manager)
      const previous = await manager.createQueryBuilder(ResourcePackageEntity, "resource")
        .setLock("pessimistic_write")
        .where('resource."packageType" = :packageType', { packageType: item.packageType })
        .andWhere('resource."name" = :name', { name: item.name })
        .andWhere('resource."status" = :status', { status: "ACTIVE" })
        .getMany()
      const now = new Date()
      for (const active of previous) {
        active.status = "RETIRED"
        active.retiredAt = now
        await manager.save(active)
        await this.recordLifecycle(manager, active, actor, "RETIRED", item.id, `被 ${item.version} 替换`)
      }
      item.status = "ACTIVE"
      item.activatedAt = now
      item.retiredAt = null
      await manager.save(item)
      await this.recordLifecycle(manager, item, actor, action, previous[0]?.id ?? null, normalizedReason)
    })
    return this.serialize(await this.packages.findOneByOrFail({ id }))
  }

  private async finishPreflight(
    item: ResourcePackageEntity,
    actor: UserEntity,
    validated: ValidatedResourceArchive,
    checks: V3ResourceValidationCheck[]
  ): Promise<void> {
    await this.packages.manager.transaction(async (manager) => {
      const current = await manager.findOneByOrFail(ResourcePackageEntity, { id: item.id })
      current.status = "STAGED"
      current.manifest = validated.manifest.content
      current.archiveManifest = validated.manifest
      current.signatureKeyId = validated.manifest.signature.keyId
      current.validationChecks = checks
      current.validatedAt = new Date()
      current.rejectionReason = null
      await manager.save(current)
      await manager.save(ResourcePackageValidationRunEntity, manager.create(ResourcePackageValidationRunEntity, {
        packageId: current.id,
        status: "PASSED",
        archiveSha256: current.sha256,
        signatureKeyId: current.signatureKeyId,
        checks,
        errorMessage: null,
        actor,
        completedAt: new Date()
      }))
      await this.recordLifecycle(manager, current, actor, "PREFLIGHT_PASSED", null, null)
    })
  }

  private async rejectPreflight(item: ResourcePackageEntity, actor: UserEntity, error: unknown): Promise<void> {
    const message = normalizeError(error)
    const checks = error instanceof ResourceArchiveValidationError
      ? error.checks
      : [{ code: "PREFLIGHT", passed: false, message }]
    await this.packages.manager.transaction(async (manager) => {
      const current = await manager.findOneByOrFail(ResourcePackageEntity, { id: item.id })
      current.status = "REJECTED"
      current.validationChecks = checks
      current.validatedAt = new Date()
      current.rejectionReason = message.slice(0, 8_000)
      await manager.save(current)
      await manager.save(ResourcePackageValidationRunEntity, manager.create(ResourcePackageValidationRunEntity, {
        packageId: current.id,
        status: "FAILED",
        archiveSha256: current.sha256,
        signatureKeyId: current.archiveManifest?.signature?.keyId ?? null,
        checks,
        errorMessage: current.rejectionReason,
        actor,
        completedAt: new Date()
      }))
      await this.recordLifecycle(manager, current, actor, "PREFLIGHT_FAILED", null, current.rejectionReason)
    })
  }

  private async assertDependencies(manifest: V3ResourceArchiveManifest, requireActive: boolean, manager: EntityManager = this.packages.manager): Promise<void> {
    for (const dependency of manifest.dependencies) {
      if (dependency.packageType === manifest.packageType && dependency.name === manifest.name && dependency.version === manifest.version) {
        throw new ResourceArchiveValidationError("DEPENDENCIES", "资源包不能依赖自身")
      }
      const item = await manager.findOne(ResourcePackageEntity, { where: {
        packageType: dependency.packageType,
        name: dependency.name,
        version: dependency.version
      } })
      if (!item || (requireActive ? item.status !== "ACTIVE" : !["STAGED", "ACTIVE"].includes(item.status))) {
        throw new ResourceArchiveValidationError("DEPENDENCIES", `资源依赖不可用：${dependency.packageType}/${dependency.name}@${dependency.version}`)
      }
    }
  }

  private async assertShowDocumentPackageReadable(item: ResourcePackageEntity): Promise<void> {
    if (!isFormalShowDocumentPackage(item)) {
      throw new ConflictException(`Document template package is not publishable: ${item.name}`)
    }
    let archive: Buffer
    try {
      archive = await this.storage.read(item.archiveAsset!.objectKey, item.archiveAsset!.storageProvider)
    } catch (error) {
      throw new ConflictException(`Document template archive is unreadable: ${item.name} (${normalizeError(error)})`)
    }
    const inspected = await this.archiveValidator.inspect(archive)
    if (inspected.archiveSha256 !== item.sha256 || inspected.archiveSha256 !== item.archiveAsset!.sha256) {
      throw new ConflictException(`Document template archive checksum mismatch: ${item.name}`)
    }
    try {
      assertFormalShowDocumentManifest(item.archiveManifest!, inspected.entries)
    } catch (error) {
      throw new ConflictException(`Document template package is not publishable: ${item.name} (${normalizeError(error)})`)
    }
  }

  private async assertArchiveTrustedForActivation(item: ResourcePackageEntity): Promise<void> {
    if (item.source === "IMPORTED_TRAJECTORY") {
      if (!item.archiveAsset || !isShowProgramManifest(item.manifest)) throw new ConflictException("导入舞步程序缺少原始文件或有效摘要")
      try {
        const source = await this.storage.read(item.archiveAsset.objectKey, item.archiveAsset.storageProvider)
        if (sha256(source) !== item.sha256 || item.archiveAsset.sha256 !== item.sha256) throw new Error("源文件 SHA-256 与资源记录不一致")
        const reparsed = parseShowProgramCsv(source, item.manifest.sourceSoftware)
        if (canonicalJson(reparsed.manifest) !== canonicalJson(item.manifest)) throw new Error("重新解析结果与导入摘要不一致")
      } catch (error) {
        throw new ConflictException(`舞步程序激活前完整性检查失败：${normalizeError(error)}`)
      }
      return
    }
    if (item.source !== "SIGNED_ARCHIVE") return
    let archive: Buffer
    try {
      archive = await this.storage.read(item.archiveAsset!.objectKey, item.archiveAsset!.storageProvider)
    } catch (error) {
      throw new ConflictException(`资源包归档不可读取：${item.name}（${normalizeError(error)}）`)
    }
    try {
      const inspected = await this.archiveValidator.inspect(archive)
      if (inspected.archiveSha256 !== item.sha256 || inspected.archiveSha256 !== item.archiveAsset!.sha256) {
        throw new ResourceArchiveValidationError("ARCHIVE_HASH", "资源包归档 SHA-256 与资源记录不一致")
      }
      assertArchiveIdentity(item, inspected)
      const validated = await this.archiveValidator.validate(inspected)
      if (validated.manifest.signature.keyId !== item.signatureKeyId) {
        throw new ResourceArchiveValidationError("SIGNATURE", "资源包签名密钥与预检记录不一致")
      }
    } catch (error) {
      throw new ConflictException(`资源包激活前重新验签失败：${normalizeError(error)}`)
    }
  }

  private async recordLifecycle(
    manager: EntityManager,
    item: ResourcePackageEntity,
    actor: UserEntity,
    action: LifecycleAction,
    previousPackageId: string | null,
    reason: string | null
  ): Promise<void> {
    await manager.save(ResourcePackageLifecycleEventEntity, manager.create(ResourcePackageLifecycleEventEntity, {
      packageId: item.id,
      packageType: item.packageType,
      name: item.name,
      version: item.version,
      action,
      previousPackageId,
      reason,
      actor
    }))
  }

  private async findVisible(id: string, user: AuthUser): Promise<ResourcePackageEntity> {
    const item = await this.packages.findOne({ where: { id } })
    if (!item || (user.role !== "admin" && item.status !== "ACTIVE")) throw new NotFoundException("资源包不存在")
    return item
  }

  private serialize(item: ResourcePackageEntity): V3ResourcePackageView {
    const builtInTrusted = item.source === "BUILT_IN" && item.status === "ACTIVE"
    const passed = builtInTrusted || Boolean(item.validatedAt && !item.rejectionReason && item.validationChecks.every((check) => check.passed))
    return {
      id: item.id,
      packageType: item.packageType,
      name: item.name,
      version: item.version,
      schemaVersion: item.schemaVersion,
      minimumPlatformVersion: item.minimumPlatformVersion,
      sha256: item.sha256,
      status: item.status,
      source: item.source,
      manifest: item.manifest,
      archiveManifest: item.archiveManifest,
      archiveAsset: item.archiveAsset ? serializeArchiveAsset(item.id, item.archiveAsset) : null,
      validation: {
        passed,
        checks: item.validationChecks,
        signatureKeyId: item.signatureKeyId,
        validatedAt: item.validatedAt?.toISOString() ?? null,
        rejectionReason: item.rejectionReason
      },
      activatedAt: item.activatedAt?.toISOString() ?? null,
      retiredAt: item.retiredAt?.toISOString() ?? null,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString()
    }
  }

  private requireAdmin(user: AuthUser): void {
    if (user.role !== "admin") throw new ForbiddenException("仅内部管理员可以管理资源包")
  }
}

function serializeArchiveAsset(packageId: string, asset: FileAssetEntity): V3FileAssetView {
  return {
    id: asset.id,
    category: asset.category,
    originalName: asset.originalName,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    sha256: asset.sha256,
    createdAt: asset.createdAt.toISOString(),
    downloadPath: `/api/v3/resource-packages/${packageId}/archive`
  }
}

function assertArchiveIdentity(item: ResourcePackageEntity, inspected: InspectedResourceArchive): void {
  const identity = inspected.identity
  if (
    identity.packageType !== item.packageType || identity.name !== item.name || identity.version !== item.version
    || identity.schemaVersion !== item.schemaVersion || identity.minimumPlatformVersion !== item.minimumPlatformVersion
  ) throw new ResourceArchiveValidationError("ARCHIVE_IDENTITY", "归档 manifest 身份与已上传资源记录不一致")
}

function assertValidatedForActivation(item: ResourcePackageEntity): void {
  if (item.source === "BUILT_IN") return
  if (item.source === "IMPORTED_TRAJECTORY" && item.packageType === "SHOW_PROGRAM" && item.archiveAsset && item.validatedAt && !item.rejectionReason && item.validationChecks.length > 0 && item.validationChecks.every((check) => check.passed)) return
  if (item.source === "UNSIGNED_TEST" && process.env.V3_ALLOW_UNSIGNED_RESOURCE_REGISTRATION === "true") return
  if (item.source !== "SIGNED_ARCHIVE" || !item.archiveAsset || !item.archiveManifest || !item.validatedAt || item.rejectionReason || item.validationChecks.some((check) => !check.passed)) {
    throw new ConflictException("资源包尚未通过完整签名预检")
  }
}

function isSemanticVersion(value: string | undefined): value is string {
  return Boolean(value && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value))
}

function assertPlatformCompatible(item: Pick<ResourcePackageEntity, "name" | "minimumPlatformVersion">): void {
  const platformVersion = process.env.PLATFORM_VERSION ?? "0.1.0"
  if (!isSemanticVersion(platformVersion)) throw new Error(`PLATFORM_VERSION 配置无效：${platformVersion}`)
  if (!isSemanticVersion(item.minimumPlatformVersion)) throw new ConflictException(`资源包 ${item.name} 的最低平台版本无效`)
  if (compareSemanticVersions(platformVersion, item.minimumPlatformVersion) < 0) {
    throw new ConflictException(`资源包 ${item.name} 要求平台版本不低于 ${item.minimumPlatformVersion}，当前版本为 ${platformVersion}`)
  }
}

function compareSemanticVersions(left: string, right: string): number {
  const leftVersion = parseSemanticVersion(left)
  const rightVersion = parseSemanticVersion(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = leftVersion.core[index]! - rightVersion.core[index]!
    if (difference !== 0) return Math.sign(difference)
  }
  if (leftVersion.prerelease.length === 0 || rightVersion.prerelease.length === 0) {
    return leftVersion.prerelease.length === rightVersion.prerelease.length ? 0 : leftVersion.prerelease.length === 0 ? 1 : -1
  }
  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.prerelease[index]
    const rightPart = rightVersion.prerelease[index]
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1
    if (leftPart === rightPart) continue
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null
    if (leftNumber !== null && rightNumber !== null) return Math.sign(leftNumber - rightNumber)
    if (leftNumber !== null || rightNumber !== null) return leftNumber !== null ? -1 : 1
    return leftPart.localeCompare(rightPart)
  }
  return 0
}

function parseSemanticVersion(value: string) {
  const [core, prerelease = ""] = value.split("-", 2)
  return { core: core!.split(".").map(Number), prerelease: prerelease ? prerelease.split(".") : [] }
}

function formatRubricVersion(name: string, packageVersion: string, rubricVersion: string): string {
  const suffix = `@${packageVersion}#${rubricVersion}`
  return `${name.slice(0, Math.max(1, 120 - suffix.length))}${suffix}`
}

function formatLegacyRubricVersion(name: string, packageVersion: string): string {
  const suffix = `@${packageVersion}`
  return `${name.slice(0, Math.max(1, 120 - suffix.length))}${suffix}`
}

function toReference(item: ResourcePackageEntity): V3ResourceReference {
  return {
    packageId: item.id,
    packageType: item.packageType,
    name: item.name,
    version: item.version,
    sha256: item.sha256
  }
}

function supportsReportScene(item: ResourcePackageEntity, sceneType: SceneType): boolean {
  try {
    rubricFromContent(sceneType, item.manifest)
    return true
  } catch {
    return false
  }
}

function normalizeReason(reason: string | undefined): string | null {
  const value = reason?.trim() || null
  if (value && value.length > 1_000) throw new BadRequestException("操作原因不能超过 1000 个字符")
  return value
}

async function lockResourcePackage(manager: EntityManager, id: string): Promise<void> {
  await manager.query('SELECT "id" FROM "resource_packages" WHERE "id" = $1 FOR UPDATE', [id])
}

function sanitizeFilename(filename: string): string {
  const value = filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 240)
  return value || "resource-package.zip"
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function assertFormalMapReadiness(
  region: Pick<V3RegionCatalogItem, "packageId" | "regionCode" | "title" | "sceneType">,
  readiness: V3RegionMapReadinessView,
  required = formalMapResourcesRequired()
): void {
  if (!required) return
  if (readiness.regionPackageId !== region.packageId || readiness.regionCode !== region.regionCode) {
    throw new ConflictException(`${sceneLabel(region.sceneType)}区域资源“${region.title}”的地图就绪结果与当前区域不一致`)
  }
  if (readiness.formalReady) return
  const labels = { TERRAIN: "DEM", IMAGERY: "影像", ELEVATION_SNAPSHOT: "高程快照" } as const
  const issues = readiness.checks
    .filter((check) => check.required && check.status !== "READY")
    .map((check) => `${labels[check.kind]}：${check.message}`)
  throw new ConflictException(`${sceneLabel(region.sceneType)}区域资源“${region.title}”未达到正式发布条件：${issues.join("；") || "地图资源未就绪"}`)
}

export function assertFormalVtlMapReadiness(
  region: Pick<V3RegionCatalogItem, "packageId" | "regionCode" | "title" | "sceneType">,
  readiness: V3RegionMapReadinessView,
  required = formalMapResourcesRequired()
): void {
  assertFormalMapReadiness(region, readiness, required)
}

export function formalMapResourcesRequired(environment: NodeJS.ProcessEnv = process.env): boolean {
  const configured = environment.FORMAL_MAP_RESOURCES_REQUIRED?.trim().toLowerCase()
  if (configured === "true") return true
  if (environment.NODE_ENV === "production") return true
  return false
}

export function formalVtlMapResourcesRequired(environment: NodeJS.ProcessEnv = process.env): boolean {
  return formalMapResourcesRequired(environment)
}

function sceneLabel(sceneType: SceneType): string {
  return sceneType === "CITY_SHOW" ? "编队表演" : sceneType === "CITY_LOGISTICS" ? "城市物流" : "垂起巡检"
}

function parseShowDocumentTemplates(item: ResourcePackageEntity): ResolvedShowDocumentTemplate[] {
  if ((item.status !== "ACTIVE" && item.status !== "RETIRED") || !isFormalShowDocumentPackage(item)) return []
  const documents = Array.isArray(item.archiveManifest!.content.documents) ? item.archiveManifest!.content.documents : []
  return documents.flatMap((value) => {
    if (!isPlainObject(value)) return []
    const code = value.code
    const title = typeof value.title === "string" ? value.title.trim() : ""
    const filename = typeof value.filename === "string" && value.filename.trim() ? value.filename.trim() : `${title}.docx`
    const path = typeof value.path === "string" ? value.path.trim() : ""
    if (!showDocumentTemplateCodes.includes(code as ShowDocumentTemplateCode) || !title || !filename.toLowerCase().endsWith(".docx") || !path.startsWith("payload/") || !path.toLowerCase().endsWith(".docx")) return []
    return [{
      packageId: item.id,
      packageVersion: item.version,
      packageSha256: item.sha256,
      code: code as ShowDocumentTemplateCode,
      title,
      filename: sanitizeFilename(filename),
      path
    }]
  })
}

const showDocumentMimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

function isFormalShowDocumentPackage(item: ResourcePackageEntity): boolean {
  if (
    item.packageType !== "DOCUMENT_TEMPLATE"
    || item.source !== "SIGNED_ARCHIVE"
    || !item.archiveAsset
    || item.archiveAsset.status !== "AVAILABLE"
    || !item.archiveManifest
    || !item.validatedAt
    || item.rejectionReason
    || item.validationChecks.some((check) => !check.passed)
    || item.archiveAsset.sha256 !== item.sha256
  ) return false
  try {
    assertFormalShowDocumentManifest(item.archiveManifest)
    return true
  } catch {
    return false
  }
}

export function assertFormalShowDocumentManifest(manifest: V3ResourceArchiveManifest, entries?: ReadonlyMap<string, Buffer>): void {
  if (manifest.packageType !== "DOCUMENT_TEMPLATE" || manifest.content.sceneType !== "CITY_SHOW") {
    invalidShowDocumentPackage("Document template package must target CITY_SHOW")
  }
  const documents = Array.isArray(manifest.content.documents) ? manifest.content.documents : []
  if (documents.length !== showDocumentTemplateCodes.length) invalidShowDocumentPackage("Document template package must contain exactly three application templates")
  const byCode = new Map<ShowDocumentTemplateCode, { path: string }>()
  for (const value of documents) {
    if (!isPlainObject(value)) invalidShowDocumentPackage("Document template metadata is invalid")
    const code = value.code
    const title = typeof value.title === "string" ? value.title.trim() : ""
    const filename = typeof value.filename === "string" ? value.filename.trim() : ""
    const path = typeof value.path === "string" ? value.path.trim() : ""
    if (!showDocumentTemplateCodes.includes(code as ShowDocumentTemplateCode) || byCode.has(code as ShowDocumentTemplateCode)) {
      invalidShowDocumentPackage("Document template codes are missing or duplicated")
    }
    if (title !== showDocumentTemplateTitles[code as ShowDocumentTemplateCode]) {
      invalidShowDocumentPackage(`Document template title does not match the fixed template: ${String(code)}`)
    }
    if (!title || (filename && !filename.toLowerCase().endsWith(".docx")) || !path.startsWith("payload/") || !path.toLowerCase().endsWith(".docx")) {
      invalidShowDocumentPackage(`Document template metadata is invalid: ${String(code)}`)
    }
    byCode.set(code as ShowDocumentTemplateCode, { path })
  }
  for (const code of showDocumentTemplateCodes) {
    const document = byCode.get(code)
    if (!document) invalidShowDocumentPackage(`Missing document template: ${code}`)
    const descriptor = manifest.files.find((file) => file.path === document.path)
    if (!descriptor || descriptor.role !== code || descriptor.mimeType !== showDocumentMimeType || descriptor.sizeBytes <= 0) {
      invalidShowDocumentPackage(`DOCX archive declaration is invalid: ${code}`)
    }
    if (entries) {
      const content = entries.get(document.path)
      if (!content || content.byteLength !== descriptor.sizeBytes || sha256(content) !== descriptor.sha256 || content[0] !== 0x50 || content[1] !== 0x4b) {
        invalidShowDocumentPackage(`DOCX archive content is invalid: ${code}`)
      }
    }
  }
}

export function assertFormalRegionManifest(
  manifest: V3ResourceArchiveManifest,
  item: Pick<ResourcePackageEntity, "id" | "name" | "version" | "sha256">,
  checks: V3ResourceValidationCheck[] = []
): V3RegionCatalogItem {
  try {
    const region = parseRegionCatalogItem(Object.assign(new ResourcePackageEntity(), {
      id: item.id,
      packageType: "REGION",
      name: item.name,
      version: item.version,
      sha256: item.sha256,
      manifest: manifest.content
    }))
    if (!region) throw new Error("区域资源缺少 catalogVersion 1")
    checks.push({ code: "REGION_CATALOG", passed: true, message: `区域目录 ${region.regionCode} 语义校验通过` })
    return region
  } catch (error) {
    const message = `区域资源语义校验失败：${normalizeError(error)}`
    throw new ResourceArchiveValidationError("REGION_CATALOG", message, [...checks, { code: "REGION_CATALOG", passed: false, message }])
  }
}

function invalidShowDocumentPackage(message: string): never {
  throw new ResourceArchiveValidationError("DOCUMENT_TEMPLATES", message, [{ code: "DOCUMENT_TEMPLATES", passed: false, message }])
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex")
}
