import { Injectable, OnApplicationBootstrap } from "@nestjs/common"
import { InjectRepository } from "@nestjs/typeorm"
import { hash } from "bcryptjs"
import { Repository } from "typeorm"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createDemoScene, showTemplatePolicyForAircraftCount, vtlTemplatePolicyForAircraftCount, type EvaluationDimension, type QuestionDefinition, type ReferenceAnswerSummary, type SceneType, type V3Coordinate } from "@wurenji/shared"
import { PracticeEntity, UserEntity } from "./entities.js"
import { sha256Canonical } from "./v3/common/canonical-json.js"
import { ResourcePackageEntity } from "./v3/resources/resource-package.entity.js"
import { createBuiltinLogisticsNodes } from "./v3/resources/builtin-logistics-nodes.js"
import { defaultEvaluationRubric } from "./v3/resources/evaluation-rubric.js"
import {
  ClassMemberEntity,
  ClassroomEntity,
  CourseEntity,
  ExerciseTemplateEntity,
  ExerciseVersionEntity,
  TeachingAssignmentEntity
} from "./education/education.entities.js"
import { QuestionBankEntity, QuestionBankVersionEntity } from "./education/question-bank.entities.js"
import { normalizeQuestionDefinitions } from "./education/question-bank.validation.js"

const GD_NORTH_OFFLINE_EXTENT: [number, number, number, number] = [113.287, 23.067, 113.323, 23.103]

@Injectable()
export class SeedService implements OnApplicationBootstrap {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(PracticeEntity) private readonly practices: Repository<PracticeEntity>,
    @InjectRepository(CourseEntity) private readonly courses: Repository<CourseEntity>,
    @InjectRepository(ClassroomEntity) private readonly classrooms: Repository<ClassroomEntity>,
    @InjectRepository(ClassMemberEntity) private readonly members: Repository<ClassMemberEntity>,
    @InjectRepository(ExerciseTemplateEntity) private readonly templates: Repository<ExerciseTemplateEntity>,
    @InjectRepository(ExerciseVersionEntity) private readonly versions: Repository<ExerciseVersionEntity>,
    @InjectRepository(TeachingAssignmentEntity) private readonly assignments: Repository<TeachingAssignmentEntity>,
    @InjectRepository(QuestionBankEntity) private readonly questionBanks: Repository<QuestionBankEntity>,
    @InjectRepository(QuestionBankVersionEntity) private readonly questionBankVersions: Repository<QuestionBankVersionEntity>,
    @InjectRepository(ResourcePackageEntity) private readonly resourcePackages: Repository<ResourcePackageEntity>
  ) {}

  async onApplicationBootstrap() {
    const seedEnabled = process.env.SEED_DEMO_DATA === "true" || (process.env.SEED_DEMO_DATA === undefined && process.env.NODE_ENV !== "production")
    if (!seedEnabled) return
    const admin = await this.ensureUser("admin@demo.local", "平台管理员", "admin", seedPassword("DEMO_ADMIN_PASSWORD"))
    const teacher = await this.ensureUser("teacher@demo.local", "陈老师", "teacher", seedPassword("DEMO_TEACHER_PASSWORD"))
    const student = await this.ensureUser("student@demo.local", "张同学", "student", seedPassword("DEMO_STUDENT_PASSWORD"))
    const student2 = await this.ensureUser("student2@demo.local", "李同学", "student", seedPassword("DEMO_STUDENT2_PASSWORD"))

    let practice = await this.practices.findOne({ where: { title: "城市物流配送实验" } })
    if (!practice) {
      const scene = createDemoScene()
      practice = await this.practices.save(this.practices.create({
        title: scene.title,
        type: scene.type,
        status: "PUBLISHED",
        sceneDraft: scene,
        publishedScene: scene,
        sceneVersion: 1,
        createdBy: teacher
      }))
    }

    const course = await this.ensureCourse(teacher)
    const classroom = await this.ensureClassroom(course, teacher)
    await this.ensureMembership(classroom, student)
    await this.ensureMembership(classroom, student2)
    await this.ensureTemplate("城市物流配送调度基础", "CITY_LOGISTICS", teacher)
    await this.ensureTemplate("城市集群表演安全规划", "CITY_SHOW", teacher)
    await this.ensureTemplate("垂起广域巡检基础训练", "VTOL_INSPECTION", teacher)
    await this.ensureTemplate("上海外滩编队表演演示案例", "CITY_SHOW", teacher)
    await this.ensureTemplate("广州北部低空物流演示案例", "CITY_LOGISTICS", teacher)
    await this.ensureTemplate("贵州山区垂起巡检演示案例", "VTOL_INSPECTION", teacher)
    await this.ensureQuestionBank(teacher)
    await this.ensureSceneQuestionBank(teacher, "城市编队表演安全与舞步训练题库", "CITY_SHOW", "按飞行运行结果判定表演方案：安全间隔、事件处置和程序完成情况由仿真数据计算。", [
      {
        code: "SHOW-SAFETY-01", type: "SIMULATION_EVIDENCE", prompt: "仿真运行结束后，运行事件控制率应达到 90% 及以上。", gradingRule: { kind: "METRIC_THRESHOLD", metricCode: "EVENT_CONTROL", operator: "GTE", threshold: 90 }, stageCode: "SHOW_REVIEW", sortOrder: 1
      },
      {
        code: "SHOW-ALERT-01", type: "SIMULATION_EVIDENCE", prompt: "仿真运行结束后，告警确认率应达到 90% 及以上。", gradingRule: { kind: "METRIC_THRESHOLD", metricCode: "ALERT_ACKNOWLEDGEMENT", operator: "GTE", threshold: 90 }, stageCode: "SHOW_REVIEW", sortOrder: 2
      },
    ])
    await this.ensureSceneQuestionBank(teacher, "垂起巡检任务规划与应急处置题库", "VTOL_INSPECTION", "按航线检查和运行快照判定巡检方案：任务覆盖、能量余度和事件处置由仿真数据计算。", [
      {
        code: "VTL-COVERAGE-01", type: "SIMULATION_EVIDENCE", prompt: "仿真结束后，必做巡检对象覆盖率应达到 95% 及以上。", gradingRule: { kind: "METRIC_THRESHOLD", metricCode: "TASK_COVERAGE", operator: "GTE", threshold: 95 }, stageCode: "VTL_REVIEW", sortOrder: 1
      },
      {
        code: "VTL-ENERGY-01", type: "SIMULATION_EVIDENCE", prompt: "仿真结束后，平均剩余能量应达到 20% 及以上。", gradingRule: { kind: "METRIC_THRESHOLD", metricCode: "ENERGY_RESERVE", operator: "GTE", threshold: 20 }, stageCode: "VTL_REVIEW", sortOrder: 2
      },
      {
        code: "VTL-EVENT-01", type: "SIMULATION_EVIDENCE", prompt: "仿真结束后，运行事件处置率应达到 100%。", gradingRule: { kind: "METRIC_THRESHOLD", metricCode: "EVENT_RESPONSE", operator: "GTE", threshold: 100 }, stageCode: "VTL_REVIEW", sortOrder: 3
      }
    ])
    await this.ensureV3ResourcePackages(admin)
    if (practice) await this.ensureAssignment(classroom, practice, teacher)
  }

  private async ensureUser(email: string, displayName: string, role: UserEntity["role"], password: string) {
    const existing = await this.users.findOne({ where: { email } })
    if (existing) return existing
    return this.users.save(this.users.create({ email, displayName, role, passwordHash: await hash(password, 10) }))
  }

  private async ensureCourse(teacher: UserEntity) {
    const existing = await this.courses.findOne({ where: { code: "UAV-SIM-2026" } })
    if (existing) return existing
    return this.courses.save(this.courses.create({ code: "UAV-SIM-2026", name: "无人集群虚拟仿真实训", term: "2026 秋季", createdBy: teacher }))
  }

  private async ensureClassroom(course: CourseEntity, teacher: UserEntity) {
    const existing = await this.classrooms.findOne({ where: { course: { id: course.id }, code: "LOW-2401" } })
    if (existing) return existing
    return this.classrooms.save(this.classrooms.create({ course, code: "LOW-2401", name: "低空 2401", createdBy: teacher }))
  }

  private async ensureMembership(classroom: ClassroomEntity, student: UserEntity) {
    const existing = await this.members.findOne({ where: { classroom: { id: classroom.id }, student: { id: student.id } } })
    if (!existing) await this.members.save(this.members.create({ classroom, student }))
  }

  private async ensureTemplate(title: string, type: SceneType, teacher: UserEntity) {
    const existing = await this.templates.findOne({ where: { title } })
    if (existing) return existing
    const template = await this.templates.save(this.templates.create({
      title,
      type,
      difficulty: type === "CITY_LOGISTICS" ? "BEGINNER" : "INTERMEDIATE",
      summary: type === "CITY_LOGISTICS"
        ? "完成订单分配、航线与时刻规划，在满足安全约束的前提下提高准时率。"
        : type === "VTOL_INSPECTION"
          ? "完成广域巡检任务分区、垂起固定翼八阶段航线、能量判断和动态集群处置。"
          : "将表演轨迹适配到城市空间，完成编号映射、起降组织和多机安全检查。",
      tags: type === "CITY_LOGISTICS" ? ["订单调度", "时刻规划", "飞行安全"] : type === "VTOL_INSPECTION" ? ["任务分区", "地形剖面", "垂起转换", "能量管理"] : ["轨迹导入", "场地适配", "集群安全"],
      status: "PUBLISHED",
      currentVersion: 1,
      createdBy: teacher
    }))
    const scene = createDemoScene()
    scene.id = crypto.randomUUID()
    scene.type = type
    scene.title = title
    if (type === "CITY_SHOW") {
      scene.aircraft = { ...scene.aircraft, name: "教学表演无人机", count: 12, maxPayloadKg: 0.5 }
      scene.taskPoints = scene.taskPoints.slice(0, 4).map((point, index) => ({ ...point, id: `show-target-${index + 1}`, name: `表演目标 ${index + 1}`, payloadKg: 0, deadlineSeconds: 90 + index * 30, stage: index < 2 ? 1 : 2 }))
    }
    const referenceAnswer: ReferenceAnswerSummary = type === "CITY_LOGISTICS"
      ? {
          hardConstraints: ["订单完成率达到 100%", "不存在碰撞、禁飞区侵入和航程超限"],
          metricTargets: [{ label: "准时率", target: "不低于 90%" }, { label: "返航余量", target: "不低于 10%" }],
          guidance: "先校核订单载重和时限，再按空间邻近关系分配飞机并错开交叉航段。"
        }
      : type === "VTOL_INSPECTION"
        ? {
            hardConstraints: ["全部必做巡检对象均有明确归属", "所有航段通过地形、转换和能量检查", "不存在任务遗漏和无法安全退出的航线"],
            metricTargets: [{ label: "任务覆盖率", target: "达到 100%" }, { label: "剩余能量", target: "高于教学安全余度" }, { label: "事件处置", target: "在规定时限内完成" }],
            guidance: "先按地形与工作量划分任务区，再规划转换点和备降路径，最后用单机与多机检查确认执行顺序。"
          }
        : {
          hardConstraints: ["全部表演目标完成", "无人机安全返航", "不存在多机碰撞"],
          metricTargets: [{ label: "水平安全间距", target: "不低于场景规则" }, { label: "阶段到达", target: "在时限内完成" }],
          guidance: "先完成编号和目标映射，再使用高度层和起飞时差消除转场冲突。"
        }
    const evaluationScheme: EvaluationDimension[] = type === "CITY_LOGISTICS"
      ? [
          { name: "飞行安全", weight: 35, metrics: ["碰撞", "禁飞区", "返航余量"] },
          { name: "完成与准时", weight: 30, metrics: ["完成率", "准时率"] },
          { name: "调度效率", weight: 20, metrics: ["总航程", "利用率"] },
          { name: "应急处置", weight: 15, metrics: ["响应时间", "处置结果"] }
        ]
      : type === "VTOL_INSPECTION"
        ? [
            { name: "任务区与分配", weight: 20, metrics: ["对象覆盖", "分配完整", "工作量均衡"] },
            { name: "航线与能量", weight: 30, metrics: ["阶段完整", "地形净空", "能量余度", "备降方案"] },
            { name: "检查与运行", weight: 25, metrics: ["单机检查", "多机关系", "执行计划", "阶段观察"] },
            { name: "事件处置", weight: 15, metrics: ["响应时间", "任务转移", "集群重组"] },
            { name: "复盘质量", weight: 10, metrics: ["未完成原因", "改进建议"] }
          ]
        : [
          { name: "飞行安全", weight: 40, metrics: ["碰撞", "间距", "越界"] },
          { name: "轨迹与时序", weight: 25, metrics: ["轨迹完整", "阶段到达"] },
          { name: "运行组织", weight: 20, metrics: ["编号映射", "起降编排"] },
          { name: "应急处置", weight: 15, metrics: ["响应时间", "处置结果"] }
        ]
    await this.versions.save(this.versions.create({ template, version: 1, taskBrief: template.summary, sceneSnapshot: scene, referenceAnswer, evaluationScheme, publishedAt: new Date() }))
    return template
  }

  private async ensureAssignment(classroom: ClassroomEntity, practice: PracticeEntity, teacher: UserEntity) {
    const existing = await this.assignments.findOne({ where: { classroom: { id: classroom.id }, practice: { id: practice.id } } })
    if (existing) {
      if (existing.dueAt.getTime() <= Date.now()) {
        existing.dueAt = new Date(Date.now() + 14 * 86_400_000)
        await this.assignments.save(existing)
      }
      return
    }
    await this.assignments.save(this.assignments.create({
      title: practice.title,
      classroom,
      practice,
      exerciseVersion: null,
      status: "PUBLISHED",
      availableAt: new Date(),
      dueAt: new Date(Date.now() + 14 * 86_400_000),
      createdBy: teacher
    }))
  }

  private async ensureV3ResourcePackages(admin: UserEntity) {
    const packages: Array<Pick<ResourcePackageEntity, "packageType" | "name" | "version" | "manifest">> = [
      { packageType: "RULE", name: "V3 教学规则", version: "1.0.0", manifest: { rules: ["stage", "spatial", "runtime"] } },
      { packageType: "REGION", name: "上海外滩城市无人机编队表演演示区", version: "1.0.0", manifest: createImportedRegionManifest("CITY_SHOW", "SH-BUND-SHOW-01", "上海外滩城市无人机编队表演演示区", "使用上海外滩离线地图，训练滨水功能区规划、编队航迹设计和多机安全表演。", { longitude: 121.4915, latitude: 31.2400 }, [121.478, 31.228, 121.505, 31.252], 11) },
      { packageType: "REGION", name: "广州北部城市低空物流演示区", version: "1.0.0", manifest: createImportedRegionManifest("CITY_LOGISTICS", "GZ-NORTH-LOGISTICS-01", "广州北部城市低空物流演示区", "使用广州北部离线地图，训练中心机场、配送点、航线规划和订单调度。", { longitude: 113.2000, latitude: 23.3900 }, [113.15, 23.35, 113.25, 23.43], 12) },
      { packageType: "REGION", name: "贵州山区垂起广域巡检演示区", version: "1.0.0", manifest: createImportedRegionManifest("VTOL_INSPECTION", "GZ-MOUNTAIN-VTOL-01", "贵州山区垂起广域巡检演示区", "使用贵州山区离线地图和真实地形，训练巡检对象分区、垂起转换、地形净空和备降决策。", { longitude: 106.5965, latitude: 26.5046 }, [106.5296, 26.4839, 106.6635, 26.5253], 13) },
      { packageType: "SCALE_TEMPLATE", name: "V3 表演规模模板", version: "1.0.0", manifest: createScaleTemplateManifest("CITY_SHOW", [100, 500, 1000, 3000]) },
      { packageType: "SCALE_TEMPLATE", name: "V3 物流规模模板", version: "1.0.0", manifest: createScaleTemplateManifest("CITY_LOGISTICS", [3, 5, 10, 20, 50]) },
      { packageType: "SCALE_TEMPLATE", name: "V3 垂起巡检规模模板", version: "1.0.0", manifest: createScaleTemplateManifest("VTOL_INSPECTION", [1, 5, 20]) },
      { packageType: "AIRCRAFT", name: "V3 统一教学机型", version: "1.0.0", manifest: { modelCode: "TEACHING-UAV-01" } },
      { packageType: "EVENT", name: "V3 表演事件", version: "1.0.0", manifest: createEventManifest("CITY_SHOW", [
        { code: "WEATHER_LIMIT", title: "风力接近运行限制", category: "WEATHER", severity: "WARNING", affectedRatio: 0.12, detectionDelaySeconds: 3, escalationDelaySeconds: 45 },
        { code: "POSITIONING_DRIFT", title: "编队定位精度下降", category: "POSITIONING_ELECTROMAGNETIC", severity: "WARNING", affectedRatio: 0.08, detectionDelaySeconds: 4, escalationDelaySeconds: 40 },
        { code: "COMMUNICATION_LOSS", title: "通信与控制链路异常", category: "COMMUNICATION_CONTROL", severity: "ERROR", affectedRatio: 0.06, detectionDelaySeconds: 6, escalationDelaySeconds: 30 },
        { code: "MOTOR_DEGRADATION", title: "动力系统性能下降", category: "AIRCRAFT_DEVICE", severity: "ERROR", affectedRatio: 0.03, detectionDelaySeconds: 2, escalationDelaySeconds: 35 },
        { code: "BATTERY_ANOMALY", title: "电池状态异常", category: "AIRCRAFT_DEVICE", severity: "WARNING", affectedRatio: 0.04, detectionDelaySeconds: 2, escalationDelaySeconds: 40 }
      ]) },
      { packageType: "EVENT", name: "V3 物流事件", version: "1.0.0", manifest: createEventManifest("CITY_LOGISTICS", [
        { code: "WEATHER_CHANGE", title: "局部气象条件恶化", category: "WEATHER_ENVIRONMENT", severity: "WARNING", detectionDelaySeconds: 5, escalationDelaySeconds: 45 },
        { code: "POSITIONING_DEGRADED", title: "定位导航质量下降", category: "POSITIONING_NAVIGATION", severity: "ERROR", detectionDelaySeconds: 4, escalationDelaySeconds: 30 },
        { code: "COMMUNICATION_LOSS", title: "通信链路异常", category: "COMMUNICATION_LINK", severity: "ERROR", detectionDelaySeconds: 6, escalationDelaySeconds: 35 },
        { code: "AIRCRAFT_FAULT", title: "无人机设备故障", category: "AIRCRAFT_DEVICE", severity: "ERROR", detectionDelaySeconds: 3, escalationDelaySeconds: 25 },
        { code: "ROUTE_SUSPENDED", title: "航线运行条件变化", category: "ROUTE_OPERATION", severity: "WARNING", detectionDelaySeconds: 2, escalationDelaySeconds: 40 },
        { code: "NODE_UNAVAILABLE", title: "配送节点暂不可用", category: "ROUTE_OPERATION", severity: "WARNING", detectionDelaySeconds: 2, escalationDelaySeconds: 40 },
        { code: "DYNAMIC_ORDER", title: "动态新增订单", category: "ORDER_TASK_CHANGE", severity: "INFO", detectionDelaySeconds: 0, escalationDelaySeconds: 60 },
        { code: "ORDER_CANCELLED", title: "订单任务取消", category: "ORDER_TASK_CHANGE", severity: "WARNING", detectionDelaySeconds: 0, escalationDelaySeconds: 60 }
      ]) },
      { packageType: "EVENT", name: "V3 垂起巡检事件", version: "1.0.0", manifest: createEventManifest("VTOL_INSPECTION", [
        { code: "VTL_WEATHER", title: "巡检区域气象恶化", category: "WEATHER", severity: "WARNING", detectionDelaySeconds: 4, escalationDelaySeconds: 40 },
        { code: "VTL_POSITIONING", title: "巡检区域定位质量下降", category: "POSITIONING", severity: "ERROR", detectionDelaySeconds: 4, escalationDelaySeconds: 30 },
        { code: "VTL_COMMUNICATION", title: "广域通信链路异常", category: "COMMUNICATION", severity: "ERROR", detectionDelaySeconds: 5, escalationDelaySeconds: 35 },
        { code: "VTL_ENERGY_POWER", title: "能量或动力余度下降", category: "ENERGY_POWER", severity: "CRITICAL", detectionDelaySeconds: 2, escalationDelaySeconds: 20 },
        { code: "VTL_DEVICE", title: "航空器设备异常", category: "DEVICE", severity: "ERROR", detectionDelaySeconds: 3, escalationDelaySeconds: 25 },
        { code: "VTL_TRANSITION", title: "模式转换条件异常", category: "MODE_TRANSITION", severity: "ERROR", detectionDelaySeconds: 2, escalationDelaySeconds: 25 },
        { code: "VTL_ROUTE_AREA", title: "航线或区域条件变化", category: "ROUTE_AREA", severity: "WARNING", detectionDelaySeconds: 2, escalationDelaySeconds: 40 },
        { code: "VTL_TASK_CONDITION", title: "巡检对象条件变化", category: "TASK_CONDITION", severity: "WARNING", detectionDelaySeconds: 0, escalationDelaySeconds: 60 }
      ]) },
      {
        packageType: "REPORT",
        name: "V3 统一评价报告",
        version: "1.0.0",
        manifest: {
          outputs: ["SINGLE_DOCX", "SINGLE_PDF"],
          include: ["planningMap", "flightTimeline", "objectiveMetrics", "teacherRubric", "eventResponse"],
          rubrics: [defaultEvaluationRubric("CITY_SHOW"), defaultEvaluationRubric("CITY_LOGISTICS"), defaultEvaluationRubric("VTOL_INSPECTION")]
        }
      }
    ]
    const placeholderDocuments = await this.resourcePackages.find({ where: { packageType: "DOCUMENT_TEMPLATE", source: "BUILT_IN" } })
    for (const placeholder of placeholderDocuments.filter((item) => item.status === "ACTIVE" || item.status === "STAGED")) {
      placeholder.status = "RETIRED"
      placeholder.retiredAt = new Date()
      await this.resourcePackages.save(placeholder)
    }
    const supersededRegionCodes = new Set([
      "LOG-HUB-NORTH-01",
      "SHOW-WATERFRONT-01",
      "SHOW-PARK-01",
      "SHOW-CIVIC-01",
      "LOG-COAST-01",
      "LOG-GZ-OFFLINE-01",
      "VTL-HILLS-WEST-01",
      "LOG-HILL-01"
    ])
    const supersededRegions = await this.resourcePackages.find({ where: {
      packageType: "REGION",
      status: "ACTIVE"
    } })
    for (const region of supersededRegions.filter((item) => {
      const regionCode = builtinRegionCode(item.manifest)
      return regionCode !== null && supersededRegionCodes.has(regionCode)
    })) {
      region.status = "RETIRED"
      region.retiredAt = new Date()
      await this.resourcePackages.save(region)
    }
    for (const definition of packages) {
      let existing = await this.resourcePackages.findOne({ where: {
        packageType: definition.packageType,
        name: definition.name,
        version: definition.version
      } })

      // Region names can change while published assignments still freeze the
      // original package id. Reuse the oldest built-in package for a region
      // code and retire newer duplicates so existing snapshots receive the
      // refreshed manifest instead of silently keeping stale map resources.
      if (definition.packageType === "REGION") {
        const regionCode = builtinRegionCode(definition.manifest)
        if (regionCode) {
          const activeRegionPackages = await this.resourcePackages.find({ where: {
            packageType: "REGION",
            source: "BUILT_IN",
            status: "ACTIVE"
          }, order: { createdAt: "ASC" } })
          const sameRegion = activeRegionPackages.filter((item) => builtinRegionCode(item.manifest) === regionCode)
          if (sameRegion.length > 0) {
            existing = sameRegion[0]!
            for (const sibling of sameRegion.slice(1)) {
              sibling.status = "RETIRED"
              sibling.retiredAt = new Date()
              await this.resourcePackages.save(sibling)
            }
          }
        }
      }

      const activeSiblings = await this.resourcePackages.find({ where: {
        packageType: definition.packageType,
        name: definition.name,
        source: "BUILT_IN",
        status: "ACTIVE"
      } })
      for (const sibling of activeSiblings) {
        if (sibling.id === existing?.id) continue
        sibling.status = "RETIRED"
        sibling.retiredAt = new Date()
        await this.resourcePackages.save(sibling)
      }
      if (existing) {
        const definitionSha256 = sha256Canonical(definition.manifest)
        const identityMatches = existing.name === definition.name && existing.version === definition.version
        if (existing.source === "BUILT_IN" && (existing.status !== "ACTIVE" || existing.sha256 !== definitionSha256 || !identityMatches)) {
          // Keep a legacy package identity stable when published snapshots still
          // reference it; only a matching identity may receive the new digest.
          // The manifest itself is always refreshed so the frozen task gets the
          // corrected map URL and offline resource metadata.
          existing.manifest = definition.manifest
          if (identityMatches) existing.sha256 = definitionSha256
          existing.status = "ACTIVE"
          existing.retiredAt = null
          existing.activatedAt ??= new Date()
          await this.resourcePackages.save(existing)
        }
        continue
      }
      await this.resourcePackages.save(this.resourcePackages.create({
        ...definition,
        schemaVersion: 1,
        minimumPlatformVersion: "0.1.0",
        sha256: sha256Canonical(definition.manifest),
        status: "ACTIVE",
        createdBy: admin,
        activatedAt: new Date(),
        retiredAt: null
      }))
    }
  }

  private async ensureQuestionBank(teacher: UserEntity) {
    const title = "城市物流配送综合训练题库"
    const questions = normalizeQuestionDefinitions([
      {
        code: "LOGISTICS-COMPLETION-01", type: "SIMULATION_EVIDENCE", prompt: "仿真运行结束后，订单完成率应达到 100%。", correctAnswer: null,
        explanation: "系统按运行快照中的完成订单数计算。", maxScore: 15, stageCode: "LOGISTICS_REVIEW",
        gradingRule: { kind: "METRIC_THRESHOLD", metricCode: "ORDER_COMPLETION", operator: "GTE", threshold: 100 }, sortOrder: 1
      },
      {
        code: "LOGISTICS-ONTIME-01", type: "SIMULATION_EVIDENCE", prompt: "仿真运行结束后，准时到达率应达到 90% 及以上。", correctAnswer: null,
        explanation: "系统按订单实际到达时间和任务时间窗计算。", maxScore: 20, stageCode: "LOGISTICS_REVIEW",
        gradingRule: { kind: "METRIC_THRESHOLD", metricCode: "ON_TIME_DELIVERY", operator: "GTE", threshold: 90 }, sortOrder: 2
      },
      {
        code: "LOGISTICS-RESPONSE-01", type: "SIMULATION_EVIDENCE", prompt: "发生运行事件时，处置时限达标率应达到 100%。", correctAnswer: null,
        explanation: "系统按事件发现、动作执行和教师设定时限计算。", maxScore: 15, stageCode: "LOGISTICS_EMERGENCY_HANDLING",
        gradingRule: { kind: "METRIC_THRESHOLD", metricCode: "ACTION_DEADLINE", operator: "GTE", threshold: 100 }, sortOrder: 3
      },
      {
        code: "LOGISTICS-SPATIAL-01", type: "SIMULATION_EVIDENCE", prompt: "正式航线不得与建筑物、障碍物或禁限飞区发生三维冲突。", correctAnswer: null,
        explanation: "系统按航线验证中的空间关系证据计算。", maxScore: 15, stageCode: "LOGISTICS_ROUTE_VALIDATION",
        gradingRule: { kind: "METRIC_THRESHOLD", metricCode: "BUILDING_COLLISION", operator: "LTE", threshold: 0 }, sortOrder: 4
      },
      {
        code: "LOGISTICS-AIR-01", type: "SIMULATION_EVIDENCE", prompt: "调度运行期间机间隔离冲突应为 0 项。", correctAnswer: null,
        explanation: "系统按调度时段、共享航线和交叉航线检查结果计算。", maxScore: 10, stageCode: "LOGISTICS_ORDER_SCHEDULING",
        gradingRule: { kind: "METRIC_THRESHOLD", metricCode: "AIR_CONFLICT", operator: "LTE", threshold: 0 }, sortOrder: 5
      },
      {
        code: "LOGISTICS-PERFORMANCE-01", type: "SIMULATION_EVIDENCE", prompt: "运行方案不得触发机型高度、速度、航程或可用性限制。", correctAnswer: null,
        explanation: "系统按航线验证和调度检查中的机型性能证据计算。", maxScore: 10, stageCode: "LOGISTICS_ROUTE_VALIDATION",
        gradingRule: { kind: "METRIC_THRESHOLD", metricCode: "PERFORMANCE_LIMIT", operator: "LTE", threshold: 0 }, sortOrder: 6
      },
      {
        code: "LOGISTICS-ENERGY-01", type: "SIMULATION_EVIDENCE", prompt: "所有任务结束后的最低剩余电量应达到 20% 及以上。", correctAnswer: null,
        explanation: "系统按调度计算和运行快照中的任务剩余电量计算。", maxScore: 15, stageCode: "LOGISTICS_DELIVERY_RUNTIME",
        gradingRule: { kind: "METRIC_THRESHOLD", metricCode: "ENERGY_RESERVE", operator: "GTE", threshold: 20 }, sortOrder: 7
      }
    ])
    return this.ensurePublishedQuestionBank(teacher, {
      title,
      sceneType: "CITY_LOGISTICS",
      summary: "按航线检查、订单完成、准时到达和事件处置指标判定物流方案。",
      questions,
      changeNote: "开发环境物流示例题库"
    })
  }

  private async ensureSceneQuestionBank(teacher: UserEntity, title: string, sceneType: SceneType, summary: string, definitions: Array<Partial<QuestionDefinition> & Pick<QuestionDefinition, "code" | "type" | "prompt" | "gradingRule" | "stageCode" | "sortOrder">>) {
    const questions = normalizeQuestionDefinitions(definitions.map((question) => ({
      ...question,
      difficulty: question.difficulty ?? "INTERMEDIATE",
      knowledgePoints: question.knowledgePoints ?? [sceneType === "CITY_SHOW" ? "编队表演" : "垂起巡检"],
      options: question.options ?? [],
      correctAnswer: question.correctAnswer ?? null,
      explanation: question.explanation ?? "系统先校验结构化参数和仿真指标，教师根据运行数据判定。",
      maxScore: question.maxScore ?? (question.type === "SIMULATION_EVIDENCE" ? 50 : 25)
    })))
    await this.ensurePublishedQuestionBank(teacher, { title, sceneType, summary, questions, changeNote: "开发环境三场景示例题库" })
  }

  /**
   * Keep demo question banks useful after the database has already been seeded.
   * Published versions are immutable because assignments keep their version id;
   * a changed seed definition therefore creates one new published version while
   * leaving historical student work readable.
   */
  private async ensurePublishedQuestionBank(teacher: UserEntity, input: {
    title: string
    sceneType: SceneType
    summary: string
    questions: QuestionDefinition[]
    changeNote: string
  }) {
    let bank = await this.questionBanks.findOne({ where: { title: input.title } })
    if (!bank) {
      bank = await this.questionBanks.save(this.questionBanks.create({
        title: input.title,
        sceneType: input.sceneType,
        summary: input.summary,
        status: "DRAFT",
        currentVersion: 0,
        createdBy: teacher
      }))
    }
    const metadataChanged = bank.sceneType !== input.sceneType || bank.summary !== input.summary
    if (metadataChanged) {
      bank.sceneType = input.sceneType
      bank.summary = input.summary
    }

    const versions = await this.questionBankVersions.find({
      where: { bank: { id: bank.id } },
      order: { version: "DESC" }
    })
    const digest = sha256Canonical(input.questions)
    const alreadyPublished = versions.some((version) => version.status === "PUBLISHED" && sha256Canonical(normalizeQuestionDefinitions(version.questions)) === digest)
    if (alreadyPublished) {
      if (metadataChanged || bank.status !== "PUBLISHED") {
        bank.status = "PUBLISHED"
        await this.questionBanks.save(bank)
      }
      return bank
    }

    const nextVersion = Math.max(bank.currentVersion ?? 0, ...versions.map((version) => version.version)) + 1
    await this.questionBankVersions.save(this.questionBankVersions.create({
      bank,
      version: nextVersion,
      status: "PUBLISHED",
      questions: input.questions,
      createdBy: teacher,
      changeNote: input.changeNote,
      publishedAt: new Date()
    }))
    bank.currentVersion = nextVersion
    bank.status = "PUBLISHED"
    return this.questionBanks.save(bank)
  }
}

function createScaleTemplateManifest(sceneType: SceneType, scales: number[]) {
  const show = sceneType === "CITY_SHOW"
  const vtl = sceneType === "VTOL_INSPECTION"
  return {
    sceneType,
    templates: scales.map((totalAircraft) => {
      const showPolicy = show ? showTemplatePolicyForAircraftCount(totalAircraft) : null
      const vtlPolicy = vtl ? vtlTemplatePolicyForAircraftCount(totalAircraft) : null
      return ({
      code: `${show ? "SHOW" : vtl ? "VTL" : "LOGISTICS"}_${totalAircraft}`,
      title: `${totalAircraft} 架${show ? "表演" : vtl ? "垂起巡检" : "物流"}模板`,
      totalAircraft,
      defaultGroupCount: showPolicy?.defaultGroupCount ?? vtlPolicy?.defaultGroupCount ?? totalAircraft,
      eventCountRange: showPolicy?.eventCountRange ?? vtlPolicy?.eventCountRange ?? { minimum: 1, maximum: Math.max(2, Math.ceil(totalAircraft / 5)) },
      maximumConcurrentEvents: showPolicy?.maximumConcurrentEvents ?? vtlPolicy?.maximumConcurrentEvents ?? 2,
      allowedActions: show
        ? ["PAUSE_PROGRAM", "RESUME_PROGRAM", "GROUP_RETURN", "GROUP_LAND"]
        : vtl
          ? ["RETURN_AIRCRAFT", "DIVERT_AIRCRAFT", "TRANSFER_TASK", "ADJUST_GROUP", "CANCEL_NOT_STARTED"]
          : ["REASSIGN_ORDER", "HOLD_ROUTE", "RETURN_AIRCRAFT", "DIVERT_AIRCRAFT"],
      aggregationLevel: show && totalAircraft >= 1000 ? "CLUSTER" : totalAircraft >= 100 ? "GROUP" : "UNIT"
      })
    })
  }
}

function createEventManifest(sceneType: SceneType, events: Array<Record<string, unknown>>) {
  return { sceneType, events }
}

function builtinRegionCode(manifest: Record<string, unknown>): string | null {
  const regionCode = manifest.regionCode
  return typeof regionCode === "string" && regionCode.trim() ? regionCode.trim() : null
}

function createRegionManifest(
  sceneType: SceneType,
  regionCode: string,
  title: string,
  summary: string,
  center: V3Coordinate,
  terrainResourceVersion: string,
  variant: number
) {
  const localLongitudeRadius = 0.0105 + variant * 0.00035
  const localLatitudeRadius = 0.0075 + variant * 0.00025
  const offlineNorth = regionCode.startsWith("GD-NORTH-") || regionCode === "LOG-HUB-NORTH-01"
  const boundary = offlineNorth
    ? rectangleFromExtent(GD_NORTH_OFFLINE_EXTENT)
    : rectangle(center, localLongitudeRadius, localLatitudeRadius)
  const version = `2026.${String(variant).padStart(2, "0")}`
  const logisticsNodes = sceneType === "CITY_LOGISTICS" ? createBuiltinLogisticsNodes(regionCode, center, variant) : undefined
  const vtlTaskObjects = sceneType === "VTOL_INSPECTION" ? createBuiltinVtlTaskObjects(regionCode, center, localLongitudeRadius, localLatitudeRadius) : undefined
  const vtlLandingSites = sceneType === "VTOL_INSPECTION" ? createBuiltinVtlLandingSites(regionCode, center) : undefined
  const vtlAircraftParameters = sceneType === "VTOL_INSPECTION" ? {
    modelCode: "VTOL-TEACHING-01",
    version: "1.0.0",
    batteryCapacityWh: 1_200,
    reserveEnergyRatio: 0.2,
    verticalPowerWatts: 2_400,
    hoverPowerWatts: 1_800,
    cruisePowerWatts: 900,
    taskPowerWatts: 1_050,
    climbSpeedMps: 4,
    cruiseSpeedMps: 22,
    transitionSpeedMps: 12,
    minimumTransitionHeightMeters: 60,
    maximumOperatingAltitudeMeters: 300
  } : undefined
  return {
    catalogVersion: 1,
    sceneType,
    regionCode,
    title,
    summary,
    center,
    boundary,
    heightDatum: "AGL",
    terrainResourceVersion,
    imageryState: "AVAILABLE",
    ...(offlineNorth ? {
      imagery: {
        provider: "SINGLE_TILE",
        url: "/map/logistics/gd-north-core-orthophoto.jpg",
        // The repository ships a deterministic teaching fallback. Replace it
        // with the formal L17 package and its checksum before production use.
        version: "demo-1.0.0",
        sha256: "5a26913d4beff3e5b696fbdb317ac177533c3c93a124b651d9cf5e0e8dd94721",
        extent: GD_NORTH_OFFLINE_EXTENT
      }
    } : {}),
    ...(logisticsNodes ? { logisticsNodes } : {}),
    ...(vtlTaskObjects ? { vtlTaskObjects } : {}),
    ...(vtlLandingSites ? { vtlLandingSites } : {}),
    ...(vtlAircraftParameters ? { vtlAircraftParameters } : {}),
    layers: [
      {
        code: "BUILDINGS",
        title: "建筑与障碍物",
        state: "AVAILABLE",
        source: "教学建筑轮廓数据",
        version,
        features: [
          ...createTeachingBuildingFeatures(sceneType, regionCode, center, localLongitudeRadius, localLatitudeRadius, variant),
          {
            id: `${regionCode}-obstacle-1`,
            name: "高杆障碍物",
            geometryType: "POINT",
            position: { longitude: center.longitude - localLongitudeRadius * 0.18, latitude: center.latitude + localLatitudeRadius * 0.24 },
            heightMeters: 24 + variant * 4,
            properties: { category: "OBSTACLE", obstacleType: "TOWER", radiusMeters: 6 + variant, verified: true }
          }
        ],
        ...(offlineNorth ? { dataUrl: "/map/logistics/gd-north-core-buildings.geojson" } : {})
      },
      {
        code: "RESTRICTIONS",
        title: "限制与风险区域",
        state: "AVAILABLE",
        source: "教学限制区数据",
        version,
        features: [{
          id: `${regionCode}-restriction-1`,
          name: "限制飞行参考区",
          geometryType: "POLYGON",
          positions: rectangle({ longitude: center.longitude - localLongitudeRadius * 0.42, latitude: center.latitude + localLatitudeRadius * 0.4 }, localLongitudeRadius * 0.12, localLatitudeRadius * 0.14),
          properties: { category: "RESTRICTED", maximumHeightMeters: 60 + variant * 5 }
        }]
      },
      {
        code: "POSITIONING",
        title: "定位导航",
        state: variant === 6 ? "DEGRADED" : "AVAILABLE",
        source: "教学定位覆盖模型",
        version,
        features: [{
          id: `${regionCode}-positioning-1`,
          name: variant === 6 ? "弱定位覆盖区" : "定位基准站",
          geometryType: "POINT",
          position: { longitude: center.longitude + localLongitudeRadius * 0.15, latitude: center.latitude - localLatitudeRadius * 0.18 },
          properties: { horizontalAccuracyMeters: variant === 6 ? 8 : 1.5, available: true }
        }]
      },
      {
        code: "COMMUNICATION",
        title: "通信链路",
        state: variant === 5 ? "DEGRADED" : "AVAILABLE",
        source: "教学通信覆盖模型",
        version,
        features: [{
          id: `${regionCode}-communication-1`,
          name: "通信保障节点",
          geometryType: "POINT",
          position: { longitude: center.longitude - localLongitudeRadius * 0.08, latitude: center.latitude - localLatitudeRadius * 0.28 },
          properties: { coverageMeters: 850 + variant * 40, redundancy: variant % 2 === 0 }
        }]
      },
      {
        code: "ENVIRONMENT",
        title: "环境与气象",
        state: "AVAILABLE",
        source: "教学环境栅格摘要",
        version,
        features: [{
          id: `${regionCode}-environment-1`,
          name: "环境影响区",
          geometryType: "POLYGON",
          positions: rectangle({ longitude: center.longitude + localLongitudeRadius * 0.05, latitude: center.latitude - localLatitudeRadius * 0.02 }, localLongitudeRadius * 0.34, localLatitudeRadius * 0.3),
          properties: { prevailingWindDirectionDegrees: 45 + variant * 20, referenceWindSpeedMps: 3 + variant * 0.4 }
        }]
      }
    ]
  }
}

function createImportedRegionManifest(
  sceneType: SceneType,
  regionCode: string,
  title: string,
  summary: string,
  center: V3Coordinate,
  extent: readonly [number, number, number, number],
  variant: number
) {
  const manifest = createRegionManifest(sceneType, regionCode, title, summary, center, `OFFLINE-${regionCode}-20260929`, variant) as Record<string, any>
  const [west, south, east, north] = extent
  const longitudeRadius = (east - west) / 2
  const latitudeRadius = (north - south) / 2
  const importedBuildingFeatures = createTeachingBuildingFeatures(sceneType, regionCode, center, longitudeRadius, latitudeRadius, variant)
  const importedNaturalLayers = readImportedNaturalLayers(regionCode, [west, south, east, north])
  const vector = (name: string, code: string, features: any[] = []) => ({
    code,
    title: name,
    state: "AVAILABLE" as const,
    source: "离线地图矢量资源",
    version: "1.0.0",
    features: code === "BUILDINGS"
      ? importedBuildingFeatures
      : features,
    ...(code === "BUILDINGS" ? { dataUrl: `/map/regions/${regionCode}/buildings.geojson` } : code === "WATER" && importedNaturalLayers.waterFile ? { dataUrl: `/map/regions/${regionCode}/${importedNaturalLayers.waterFile}` } : code === "GREENLAND" && importedNaturalLayers.greenFile ? { dataUrl: `/map/regions/${regionCode}/${importedNaturalLayers.greenFile}` } : {}),
    format: "GEOJSON" as const,
    coordinateReference: "EPSG:4326" as const,
    extent: [west, south, east, north] as [number, number, number, number]
  })
  manifest.boundary = rectangleFromExtent(extent)
  manifest.mapResourceVersion = `MAP-${regionCode}@1.0.0`
  manifest.imagery = {
    provider: "XYZ",
    url: `/map/regions/${regionCode}/road/{z}/{x}/{y}.png`,
    version: "1.0.0",
    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
    extent: [west, south, east, north]
  }
  manifest.terrain = {
    provider: "CESIUM_QUANTIZED_MESH",
    url: `/map/regions/${regionCode}/terrain/cesium-quantized-mesh`,
    version: "1.0.0",
    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
    verticalDatum: "AMSL",
    extent: [west, south, east, north]
  }
  manifest.mapResourceManifest = {
    manifestVersion: 1,
    mapResourceVersion: `MAP-${regionCode}@1.0.0`,
    coordinateReference: "EPSG:4326",
    heightDatum: "AMSL",
    coverage: [west, south, east, north],
    baseLayers: [{ id: "road", format: "XYZ", path: `/map/regions/${regionCode}/road/{z}/{x}/{y}.png`, version: "1.0.0", sha256: "0".repeat(64), coordinateReference: "EPSG:4326", extent: [west, south, east, north] }],
    vectorLayers: [
      { id: "buildings", format: "GEOJSON", path: `/map/regions/${regionCode}/buildings.geojson`, version: "1.0.0", sha256: "0".repeat(64), coordinateReference: "EPSG:4326", extent: [west, south, east, north] },
      ...(importedNaturalLayers.waterFile ? [{ id: "water", format: "GEOJSON" as const, path: `/map/regions/${regionCode}/${importedNaturalLayers.waterFile}`, version: "1.0.0", sha256: "0".repeat(64), coordinateReference: "EPSG:4326" as const, extent: [west, south, east, north] }] : []),
      ...(importedNaturalLayers.greenFile ? [{ id: "greenland", format: "GEOJSON" as const, path: `/map/regions/${regionCode}/${importedNaturalLayers.greenFile}`, version: "1.0.0", sha256: "0".repeat(64), coordinateReference: "EPSG:4326" as const, extent: [west, south, east, north] }] : [])
    ],
    terrain: { provider: "CESIUM_QUANTIZED_MESH", path: `/map/regions/${regionCode}/terrain/cesium-quantized-mesh`, version: "1.0.0", sha256: "0".repeat(64), extent: [west, south, east, north] }
  }
  manifest.layers = [
    vector("建筑", "BUILDINGS"),
    vector("禁限区域", "RESTRICTIONS"),
    ...(importedNaturalLayers.waterFile ? [vector("水域与河流", "WATER", importedNaturalLayers.water)] : []),
    ...(importedNaturalLayers.greenFile ? [vector("森林与绿地", "GREENLAND", importedNaturalLayers.green)] : []),
    vector("定位导航", "POSITIONING"),
    vector("通信链路", "COMMUNICATION"),
    vector("环境与气象", "ENVIRONMENT")
  ]
  return manifest
}

function readImportedNaturalLayers(regionCode: string, extent: readonly [number, number, number, number]): { waterFile: string | null; greenFile: string | null; water: any[]; green: any[] } {
  const root = resolve(process.env.MAP_DATA_DIR ?? "data/map", "regions", regionCode)
  const waterFile = existsSync(join(root, "water.geojson")) ? "water.geojson" : existsSync(join(root, "hydro-base.geojson")) ? "hydro-base.geojson" : null
  const greenFile = existsSync(join(root, "green.geojson")) ? "green.geojson" : null
  return {
    waterFile,
    greenFile,
    water: waterFile ? readImportedGeoJsonFeatures(join(root, waterFile), "WATER", extent) : [],
    green: greenFile ? readImportedGeoJsonFeatures(join(root, greenFile), "GREENLAND", extent) : []
  }
}

function readImportedGeoJsonFeatures(filePath: string, layer: "WATER" | "GREENLAND", extent: readonly [number, number, number, number]): any[] {
  try {
    const collection = JSON.parse(readFileSync(filePath, "utf8")) as { features?: any[] }
    const [west, south, east, north] = extent
    const result: any[] = []
    for (const item of collection.features ?? []) {
      const properties = item?.properties && typeof item.properties === "object" ? item.properties : {}
      const isWater = layer === "WATER"
        ? Boolean(properties.waterway || properties.water || properties.natural === "water" || properties.landuse === "basin")
        : Boolean(properties.natural === "wood" || properties.natural === "tree_row" || properties.landuse === "forest" || properties.landuse === "grass" || properties.landuse === "orchard" || ["park", "garden", "pitch", "playground", "sports_centre"].includes(String(properties.leisure)))
      if (!isWater) continue
      const geometry = item?.geometry
      if (!geometry || !["Point", "LineString", "Polygon", "MultiPolygon"].includes(geometry.type)) continue
      const geometries = geometry.type === "MultiPolygon" ? geometry.coordinates.map((coordinates: unknown) => ({ type: "Polygon", coordinates })) : [geometry]
      for (const part of geometries) {
        const positions = part.type === "LineString" ? part.coordinates : part.type === "Polygon" ? part.coordinates?.[0] : null
        if (!Array.isArray(positions) || positions.length < (part.type === "LineString" ? 2 : 3)) continue
        const normalized = positions.map((point: unknown) => ({ longitude: Number((point as any)?.[0]), latitude: Number((point as any)?.[1]) })).filter((point: any) => Number.isFinite(point.longitude) && Number.isFinite(point.latitude))
        if (normalized.length < (part.type === "LineString" ? 2 : 3)) continue
        if (!normalized.some((point: any) => point.longitude >= west && point.longitude <= east && point.latitude >= south && point.latitude <= north)) continue
        result.push({
          id: `${layer.toLowerCase()}:${item.id ?? result.length}:${result.length}`,
          name: String(properties.name ?? properties["name:zh"] ?? (layer === "WATER" ? "水域" : "绿地")),
          geometryType: part.type === "LineString" ? "LINESTRING" : "POLYGON",
          positions: normalized,
          properties: { category: layer, ...Object.fromEntries(Object.entries(properties).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value)).slice(0, 12)) }
        })
      }
    }
    return result.slice(0, 1200)
  } catch {
    return []
  }
}

function createTeachingBuildingFeatures(
  sceneType: SceneType,
  regionCode: string,
  center: V3Coordinate,
  longitudeRadius: number,
  latitudeRadius: number,
  variant: number
) {
  if (sceneType !== "CITY_SHOW") {
    return [{
      id: `${regionCode}-building-1`,
      name: "重点建筑群",
      geometryType: "POLYGON" as const,
      positions: rectangle(
        { longitude: center.longitude + longitudeRadius * 0.28, latitude: center.latitude + latitudeRadius * 0.2 },
        longitudeRadius * 0.18,
        latitudeRadius * 0.2
      ),
      heightMeters: 42 + variant * 8,
      properties: { category: "BUILDING", verified: true }
    }]
  }
  const blocks = [
    [-0.58, 0.48, 0.13, 0.12], [-0.3, 0.52, 0.1, 0.16], [0.02, 0.5, 0.14, 0.11], [0.34, 0.44, 0.12, 0.15],
    [-0.62, 0.05, 0.11, 0.17], [-0.28, 0.12, 0.15, 0.12], [0.28, 0.2, 0.18, 0.2], [0.62, 0.04, 0.1, 0.16],
    [-0.5, -0.42, 0.14, 0.11], [-0.16, -0.38, 0.1, 0.16], [0.18, -0.44, 0.13, 0.12], [0.52, -0.36, 0.15, 0.14]
  ] as const
  return blocks.map(([longitudeOffset, latitudeOffset, longitudeSize, latitudeSize], index) => ({
    id: `${regionCode}-building-${index + 1}`,
    name: index === 6 ? "重点建筑群" : `教学建筑 ${String(index + 1).padStart(2, "0")}`,
    geometryType: "POLYGON" as const,
    positions: rectangle(
      {
        longitude: center.longitude + longitudeRadius * longitudeOffset,
        latitude: center.latitude + latitudeRadius * latitudeOffset
      },
      longitudeRadius * longitudeSize,
      latitudeRadius * latitudeSize
    ),
    heightMeters: index === 6 ? 42 + variant * 8 : 16 + ((index * 13 + variant * 7) % 46),
    properties: { category: "BUILDING", verified: false, source: "TEACHING_DEMO" }
  }))
}

function createBuiltinVtlTaskObjects(regionCode: string, center: V3Coordinate, longitudeRadius: number, latitudeRadius: number) {
  return Array.from({ length: 20 }, (_, index) => {
    const column = index % 5
    const row = Math.floor(index / 5)
    const longitude = center.longitude - longitudeRadius * 0.62 + column * longitudeRadius * 0.28
    const latitude = center.latitude - latitudeRadius * 0.55 + row * latitudeRadius * 0.36
    const position = { longitude, latitude, altitudeMeters: 120 + row * 8 }
    const isLinear = index % 5 === 4
    return {
      id: `${regionCode}-object-${String(index + 1).padStart(2, "0")}`,
      code: `T-${String(index + 1).padStart(2, "0")}`,
      title: `${isLinear ? "巡检廊道" : "巡检对象"} ${String(index + 1).padStart(2, "0")}`,
      type: isLinear ? "LINE" : "POINT",
      positions: isLinear
        ? [position, { longitude: longitude + longitudeRadius * 0.16, latitude: latitude + latitudeRadius * 0.05, altitudeMeters: position.altitudeMeters }]
        : [position],
      requirement: isLinear ? "沿线完成连续巡检并记录异常位置" : "完成目标点影像与状态核查",
      completionRule: isLinear ? "航段覆盖率达到100%" : "进入任务半径并完成观察",
      required: true,
      estimatedWorkSeconds: isLinear ? 180 : 90,
      status: "UNASSIGNED",
      incompleteReason: null
    }
  })
}

function createBuiltinVtlLandingSites(regionCode: string, center: V3Coordinate) {
  return [
    {
      id: `${regionCode}-main-landing`,
      code: "VTL-MAIN-01",
      title: "主起降点",
      type: "MAIN",
      position: { longitude: center.longitude, latitude: center.latitude, altitudeMeters: 35 },
      elevationMeters: 35,
      status: "AVAILABLE",
      relatedAlternateSiteIds: [`${regionCode}-alternate-01`, `${regionCode}-alternate-02`]
    },
    {
      id: `${regionCode}-main-landing-02`,
      code: "VTL-MAIN-02",
      title: "东侧主起降点",
      type: "MAIN",
      position: { longitude: center.longitude + 0.004, latitude: center.latitude - 0.003, altitudeMeters: 38 },
      elevationMeters: 38,
      status: "AVAILABLE",
      relatedAlternateSiteIds: [`${regionCode}-alternate-01`, `${regionCode}-alternate-02`]
    },
    {
      id: `${regionCode}-alternate-01`,
      code: "VTL-ALT-01",
      title: "北侧备降点",
      type: "ALTERNATE",
      position: { longitude: center.longitude + 0.006, latitude: center.latitude + 0.005, altitudeMeters: 48 },
      elevationMeters: 48,
      status: "AVAILABLE",
      relatedAlternateSiteIds: []
    },
    {
      id: `${regionCode}-alternate-02`,
      code: "VTL-ALT-02",
      title: "南侧备降点",
      type: "ALTERNATE",
      position: { longitude: center.longitude - 0.006, latitude: center.latitude - 0.005, altitudeMeters: 42 },
      elevationMeters: 42,
      status: "AVAILABLE",
      relatedAlternateSiteIds: []
    }
  ]
}

function rectangle(center: V3Coordinate, longitudeRadius: number, latitudeRadius: number): V3Coordinate[] {
  return [
    { longitude: center.longitude - longitudeRadius, latitude: center.latitude - latitudeRadius },
    { longitude: center.longitude + longitudeRadius, latitude: center.latitude - latitudeRadius },
    { longitude: center.longitude + longitudeRadius, latitude: center.latitude + latitudeRadius },
    { longitude: center.longitude - longitudeRadius, latitude: center.latitude + latitudeRadius }
  ]
}

function rectangleFromExtent(extent: readonly [number, number, number, number]): V3Coordinate[] {
  const [west, south, east, north] = extent
  return [
    { longitude: west, latitude: south },
    { longitude: east, latitude: south },
    { longitude: east, latitude: north },
    { longitude: west, latitude: north }
  ]
}

function seedPassword(name: string): string {
  const value = process.env[name]?.trim()
  if (!value || value.length < 8) throw new Error(`${name} 必须配置且至少 8 位，才能启用演示数据初始化`)
  return value
}
