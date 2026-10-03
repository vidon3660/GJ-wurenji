import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common"
import { InjectRepository } from "@nestjs/typeorm"
import { hash } from "bcryptjs"
import { In, Repository } from "typeorm"
import {
  createSceneTemplate,
  type AssignmentSummary,
  type AssignmentLeaderboard,
  type AuthUser,
  type ClassroomStudent,
  type ClassroomSummary,
  type EducationOverview,
  type EvaluationDimension,
  type ExerciseDifficulty,
  type ExerciseTemplateDetail,
  type ExerciseTemplateSummary,
  type LeaderboardDisplayMode,
  type OnboardingState,
  type PracticeScene,
  type PracticeSummary,
  type ReferenceAnswerSummary,
  type SceneType,
  type StudentAssignmentStatus
} from "@wurenji/shared"
import { PracticeEntity, SolutionEntity, SubmissionEntity, UserEntity } from "../entities.js"
import { GradeEntity } from "../logistics/logistics.entities.js"
import {
  ClassMemberEntity,
  ClassroomEntity,
  CourseEntity,
  ExerciseTemplateEntity,
  ExerciseVersionEntity,
  OnboardingStateEntity,
  TeachingAssignmentEntity
} from "./education.entities.js"
import { normalizeStudentImports, type StudentImportInput } from "./student-import.js"
import { buildLeaderboardEntries } from "./leaderboard.js"
import { onboardingGuideKey, onboardingGuideVersion, validOnboardingRequest } from "./onboarding.js"
import { defaultEvaluationForScene } from "./default-evaluation.js"

interface CreateTemplateInput {
  title?: string
  type?: SceneType
  difficulty?: ExerciseDifficulty
  summary?: string
  tags?: string[]
  taskBrief?: string
  sceneSnapshot?: PracticeScene
  referenceAnswer?: ReferenceAnswerSummary
  evaluationScheme?: EvaluationDimension[]
}

@Injectable()
export class EducationService {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(PracticeEntity) private readonly practices: Repository<PracticeEntity>,
    @InjectRepository(SolutionEntity) private readonly solutions: Repository<SolutionEntity>,
    @InjectRepository(SubmissionEntity) private readonly submissions: Repository<SubmissionEntity>,
    @InjectRepository(GradeEntity) private readonly grades: Repository<GradeEntity>,
    @InjectRepository(CourseEntity) private readonly courses: Repository<CourseEntity>,
    @InjectRepository(ClassroomEntity) private readonly classrooms: Repository<ClassroomEntity>,
    @InjectRepository(ClassMemberEntity) private readonly members: Repository<ClassMemberEntity>,
    @InjectRepository(OnboardingStateEntity) private readonly onboardingStates: Repository<OnboardingStateEntity>,
    @InjectRepository(ExerciseTemplateEntity) private readonly templates: Repository<ExerciseTemplateEntity>,
    @InjectRepository(ExerciseVersionEntity) private readonly exerciseVersions: Repository<ExerciseVersionEntity>,
    @InjectRepository(TeachingAssignmentEntity) private readonly assignments: Repository<TeachingAssignmentEntity>
  ) {}

  async overview(user: AuthUser): Promise<EducationOverview> {
    const [classes, assignments, practices] = await Promise.all([
      this.listClasses(user),
      this.listAssignments(user),
      this.listVisiblePractices(user)
    ])

    if (user.role === "student") {
      const submitted = assignments.filter((assignment) => assignment.studentStatus === "SUBMITTED").length
      const dueSoon = assignments.filter((assignment) => assignment.studentStatus !== "SUBMITTED" && Date.parse(assignment.dueAt) - Date.now() <= 3 * 86_400_000).length
      return {
        metrics: [
          { key: "pending", label: "待完成实训", value: assignments.length - submitted, detail: "当前班级发布" },
          { key: "submitted", label: "已提交", value: submitted, detail: "本学期累计" },
          { key: "due-soon", label: "三日内截止", value: dueSoon, detail: "优先安排" },
          { key: "classes", label: "所在班级", value: classes.length, detail: "课程班级" }
        ],
        assignments,
        classes,
        practices
      }
    }

    const studentIds = new Set<string>()
    for (const classroom of classes) {
      const classMembers = await this.members.find({ where: { classroom: { id: classroom.id } } })
      classMembers.forEach((member) => studentIds.add(member.student.id))
    }
    const publishedCount = practices.filter((practice) => practice.status === "PUBLISHED").length
    return {
      metrics: [
        { key: "active", label: "已发布实训", value: assignments.filter((assignment) => assignment.status === "PUBLISHED").length, detail: "面向班级" },
        { key: "students", label: "在册学生", value: studentIds.size, detail: `${classes.length} 个班级` },
        { key: "practices", label: "场景实训", value: publishedCount, detail: `${practices.length - publishedCount} 个草稿` },
        { key: "templates", label: "任务模板", value: await this.templates.count(), detail: "可复用教学内容" }
      ],
      assignments,
      classes,
      practices
    }
  }

  async getOnboarding(user: AuthUser): Promise<OnboardingState> {
    const guideKey = onboardingGuideKey(user.role)
    const version = onboardingGuideVersion
    const state = await this.onboardingStates.findOne({ where: { user: { id: user.id }, guideKey, version } })
    return { guideKey, version, completed: Boolean(state), skipped: state?.skipped ?? false }
  }

  async completeOnboarding(user: AuthUser, guideKey: string, version: number, skipped: boolean): Promise<OnboardingState> {
    const expectedKey = onboardingGuideKey(user.role)
    if (!validOnboardingRequest(user.role, guideKey, version)) throw new BadRequestException("引导版本无效")
    const owner = await this.users.findOneByOrFail({ id: user.id })
    let state = await this.onboardingStates.findOne({ where: { user: { id: user.id }, guideKey, version } })
    if (!state) state = this.onboardingStates.create({ user: owner, guideKey, version, skipped })
    state.skipped = skipped
    await this.onboardingStates.save(state)
    return { guideKey: expectedKey, version, completed: true, skipped }
  }

  async listTemplates(user: AuthUser): Promise<ExerciseTemplateSummary[]> {
    this.requireTeacher(user)
    const templates = await this.templates.find({ order: { updatedAt: "DESC" } })
    return templates.map((template) => this.templateSummary(template))
  }

  async getTemplate(id: string, user: AuthUser): Promise<ExerciseTemplateDetail> {
    this.requireTeacher(user)
    const template = await this.templates.findOne({ where: { id } })
    if (!template) throw new NotFoundException("任务模板不存在")
    const version = await this.exerciseVersions.findOne({ where: { template: { id }, version: template.currentVersion } })
    if (!version) throw new NotFoundException("任务模板版本不存在")
    return {
      ...this.templateSummary(template),
      versionId: version.id,
      taskBrief: version.taskBrief,
      referenceAnswer: version.referenceAnswer,
      evaluationScheme: version.evaluationScheme
    }
  }

  async createTemplate(user: AuthUser, input: CreateTemplateInput): Promise<ExerciseTemplateDetail> {
    this.requireTeacher(user)
    const title = input.title?.trim()
    const summary = input.summary?.trim()
    const taskBrief = input.taskBrief?.trim()
    if (!title || !summary || !taskBrief) throw new BadRequestException("模板名称、摘要和任务说明不能为空")
    const type = input.type ?? "CITY_LOGISTICS"
    const owner = await this.users.findOneByOrFail({ id: user.id })
    const template = await this.templates.save(this.templates.create({
      title,
      type,
      difficulty: input.difficulty ?? "BEGINNER",
      summary,
      tags: input.tags?.map((tag) => tag.trim()).filter(Boolean).slice(0, 8) ?? [],
      status: "PUBLISHED",
      currentVersion: 1,
      createdBy: owner
    }))
    const version = await this.exerciseVersions.save(this.exerciseVersions.create({
      template,
      version: 1,
      taskBrief,
      sceneSnapshot: input.sceneSnapshot ?? createSceneTemplate(type),
      referenceAnswer: input.referenceAnswer ?? { hardConstraints: ["任务全部完成", "不存在严重飞行安全问题"], metricTargets: [], guidance: "检查任务分配、航线和时刻之间的约束关系。" },
      evaluationScheme: input.evaluationScheme ?? defaultEvaluationForScene(type),
      publishedAt: new Date()
    }))
    return { ...this.templateSummary(template), versionId: version.id, taskBrief, referenceAnswer: version.referenceAnswer, evaluationScheme: version.evaluationScheme }
  }

  async createPracticeFromVersion(versionId: string, user: AuthUser) {
    this.requireTeacher(user)
    const version = await this.exerciseVersions.findOne({ where: { id: versionId } })
    if (!version) throw new NotFoundException("任务模板版本不存在")
    const owner = await this.users.findOneByOrFail({ id: user.id })
    const scene = structuredClone(version.sceneSnapshot)
    scene.id = crypto.randomUUID()
    scene.version = 0
    scene.title = version.template.title
    const practice = await this.practices.save(this.practices.create({
      title: version.template.title,
      type: version.template.type,
      status: "DRAFT",
      sceneDraft: scene,
      publishedScene: null,
      sceneVersion: 0,
      createdBy: owner
    }))
    return { practiceId: practice.id, title: practice.title }
  }

  async listClasses(user: AuthUser): Promise<ClassroomSummary[]> {
    let classrooms: ClassroomEntity[]
    if (user.role === "student") {
      const memberships = await this.members.find({ where: { student: { id: user.id } }, order: { createdAt: "ASC" } })
      classrooms = memberships.map((membership) => membership.classroom)
    } else if (user.role === "admin") {
      classrooms = await this.classrooms.find({ order: { updatedAt: "DESC" } })
    } else {
      classrooms = await this.classrooms.find({ where: { createdBy: { id: user.id } }, order: { updatedAt: "DESC" } })
    }
    return Promise.all(classrooms.map(async (classroom) => ({
      id: classroom.id,
      name: classroom.name,
      code: classroom.code,
      courseId: classroom.course.id,
      courseName: classroom.course.name,
      term: classroom.course.term,
      studentCount: await this.members.count({ where: { classroom: { id: classroom.id } } })
    })))
  }

  async createCourse(user: AuthUser, body: { code?: string; name?: string; term?: string }) {
    this.requireTeacher(user)
    const code = body.code?.trim().toUpperCase()
    const name = body.name?.trim()
    const term = body.term?.trim()
    if (!code || !name || !term) throw new BadRequestException("课程代码、名称和学期不能为空")
    if (await this.courses.findOne({ where: { code } })) throw new ConflictException("课程代码已存在")
    const owner = await this.users.findOneByOrFail({ id: user.id })
    const course = await this.courses.save(this.courses.create({ code, name, term, createdBy: owner }))
    return { id: course.id, code: course.code, name: course.name, term: course.term }
  }

  async createClass(user: AuthUser, body: { courseId?: string; code?: string; name?: string }): Promise<ClassroomSummary> {
    this.requireTeacher(user)
    const code = body.code?.trim().toUpperCase()
    const name = body.name?.trim()
    if (!body.courseId || !code || !name) throw new BadRequestException("课程、班级代码和班级名称不能为空")
    const course = await this.courses.findOne({ where: { id: body.courseId } })
    if (!course) throw new NotFoundException("课程不存在")
    if (user.role !== "admin" && course.createdBy.id !== user.id) throw new ForbiddenException("无权使用该课程")
    const owner = await this.users.findOneByOrFail({ id: user.id })
    const classroom = await this.classrooms.save(this.classrooms.create({ course, code, name, createdBy: owner }))
    return { id: classroom.id, name, code, courseId: course.id, courseName: course.name, term: course.term, studentCount: 0 }
  }

  async listCourses(user: AuthUser) {
    this.requireTeacher(user)
    const courses = user.role === "admin"
      ? await this.courses.find({ order: { updatedAt: "DESC" } })
      : await this.courses.find({ where: { createdBy: { id: user.id } }, order: { updatedAt: "DESC" } })
    return courses.map((course) => ({ id: course.id, code: course.code, name: course.name, term: course.term }))
  }

  async listClassStudents(classroomId: string, user: AuthUser): Promise<ClassroomStudent[]> {
    const classroom = await this.findClassroom(classroomId)
    await this.requireClassroomAccess(classroom, user)
    const members = await this.members.find({ where: { classroom: { id: classroomId } }, order: { createdAt: "ASC" } })
    return members.map((member) => ({ id: member.student.id, displayName: member.student.displayName, email: member.student.email, joinedAt: member.createdAt.toISOString() }))
  }

  async importStudents(classroomId: string, user: AuthUser, rows: StudentImportInput[]) {
    this.requireTeacher(user)
    const classroom = await this.findClassroom(classroomId)
    await this.requireClassroomAccess(classroom, user)
    const normalized = normalizeStudentImports(rows)
    let created = 0
    let added = 0
    for (const row of normalized) {
      let student = await this.users.findOne({ where: { email: row.email } })
      if (student && student.role !== "student") throw new ConflictException(`${row.email} 已被非学生账号使用`)
      if (!student) {
        student = await this.users.save(this.users.create({ email: row.email, displayName: row.displayName, role: "student", passwordHash: await hash(row.password, 10) }))
        created += 1
      }
      const existingMember = await this.members.findOne({ where: { classroom: { id: classroomId }, student: { id: student.id } } })
      if (!existingMember) {
        await this.members.save(this.members.create({ classroom, student }))
        added += 1
      }
    }
    return { received: normalized.length, created, added }
  }

  async listAssignments(user: AuthUser): Promise<AssignmentSummary[]> {
    let assignments: TeachingAssignmentEntity[]
    if (user.role === "student") {
      const memberships = await this.members.find({ where: { student: { id: user.id } } })
      const classIds = memberships.map((membership) => membership.classroom.id)
      assignments = classIds.length === 0 ? [] : await this.assignments.find({ where: { classroom: { id: In(classIds) }, status: "PUBLISHED" }, order: { dueAt: "ASC" } })
    } else if (user.role === "admin") {
      assignments = await this.assignments.find({ order: { dueAt: "ASC" } })
    } else {
      assignments = await this.assignments.find({ where: { createdBy: { id: user.id } }, order: { dueAt: "ASC" } })
    }
    return Promise.all(assignments.map((assignment) => this.assignmentSummary(assignment, user)))
  }

  async createAssignment(user: AuthUser, body: { classroomId?: string; practiceId?: string; exerciseVersionId?: string; title?: string; dueAt?: string }): Promise<AssignmentSummary> {
    this.requireTeacher(user)
    if (!body.classroomId || !body.practiceId) throw new BadRequestException("请选择班级和已发布实训")
    const classroom = await this.findClassroom(body.classroomId)
    await this.requireClassroomAccess(classroom, user)
    const practice = await this.practices.findOne({ where: { id: body.practiceId }, relations: { createdBy: true } })
    if (!practice) throw new NotFoundException("实训不存在")
    if (practice.status !== "PUBLISHED" || !practice.publishedScene) throw new ConflictException("只能向班级发布已完成场景发布的实训")
    if (user.role !== "admin" && practice.createdBy.id !== user.id) throw new ForbiddenException("无权发布该实训")
    if (await this.assignments.findOne({ where: { classroom: { id: classroom.id }, practice: { id: practice.id } } })) throw new ConflictException("该实训已经发布到此班级")
    const dueAt = body.dueAt ? new Date(body.dueAt) : new Date(Date.now() + 14 * 86_400_000)
    if (!Number.isFinite(dueAt.getTime()) || dueAt.getTime() <= Date.now()) throw new BadRequestException("截止时间必须晚于当前时间")
    const exerciseVersion = body.exerciseVersionId ? await this.exerciseVersions.findOne({ where: { id: body.exerciseVersionId } }) : null
    const owner = await this.users.findOneByOrFail({ id: user.id })
    const assignment = await this.assignments.save(this.assignments.create({
      title: body.title?.trim() || practice.title,
      classroom,
      practice,
      exerciseVersion,
      status: "PUBLISHED",
      availableAt: new Date(),
      dueAt,
      createdBy: owner
    }))
    return this.assignmentSummary(assignment, user)
  }

  async listLeaderboards(user: AuthUser): Promise<AssignmentLeaderboard[]> {
    let assignments: TeachingAssignmentEntity[]
    if (user.role === "student") {
      const memberships = await this.members.find({ where: { student: { id: user.id } } })
      const classIds = memberships.map((membership) => membership.classroom.id)
      assignments = classIds.length === 0 ? [] : await this.assignments.find({
        where: { classroom: { id: In(classIds) }, status: "PUBLISHED", leaderboardEnabled: true },
        order: { dueAt: "ASC" }
      })
    } else if (user.role === "admin") {
      assignments = await this.assignments.find({ order: { dueAt: "ASC" } })
    } else {
      assignments = await this.assignments.find({ where: { createdBy: { id: user.id } }, order: { dueAt: "ASC" } })
    }
    return Promise.all(assignments.map((assignment) => this.leaderboardSummary(assignment, user)))
  }

  async getLeaderboard(assignmentId: string, user: AuthUser): Promise<AssignmentLeaderboard> {
    const assignment = await this.findAssignment(assignmentId)
    await this.requireAssignmentAccess(assignment, user)
    if (user.role === "student" && !assignment.leaderboardEnabled) throw new ForbiddenException("教师尚未开放该班排行榜")
    return this.leaderboardSummary(assignment, user)
  }

  async updateLeaderboard(assignmentId: string, user: AuthUser, input: {
    enabled?: boolean
    displayLimit?: number
    displayMode?: LeaderboardDisplayMode
  }): Promise<AssignmentLeaderboard> {
    this.requireTeacher(user)
    const assignment = await this.findAssignment(assignmentId)
    await this.requireAssignmentAccess(assignment, user)
    const displayLimit = Number(input.displayLimit ?? assignment.leaderboardDisplayLimit)
    if (!Number.isInteger(displayLimit) || displayLimit < 3 || displayLimit > 50) throw new BadRequestException("排行榜展示人数必须在 3 到 50 之间")
    const displayMode = input.displayMode ?? assignment.leaderboardDisplayMode
    if (displayMode !== "FULL_NAME" && displayMode !== "ANONYMIZED") throw new BadRequestException("排行榜姓名展示方式无效")
    assignment.leaderboardEnabled = input.enabled ?? assignment.leaderboardEnabled
    assignment.leaderboardDisplayLimit = displayLimit
    assignment.leaderboardDisplayMode = displayMode
    return this.leaderboardSummary(await this.assignments.save(assignment), user)
  }

  private async assignmentSummary(assignment: TeachingAssignmentEntity, user: AuthUser): Promise<AssignmentSummary> {
    const classMembers = await this.members.find({ where: { classroom: { id: assignment.classroom.id } } })
    const studentIds = new Set(classMembers.map((member) => member.student.id))
    const submissions = await this.submissions.find({ where: { practice: { id: assignment.practice.id } } })
    const submittedCount = submissions.filter((submission) => studentIds.has(submission.student.id)).length
    let studentStatus: StudentAssignmentStatus | null = null
    if (user.role === "student") {
      if (submissions.some((submission) => submission.student.id === user.id)) studentStatus = "SUBMITTED"
      else if (await this.solutions.findOne({ where: { practice: { id: assignment.practice.id }, student: { id: user.id } } })) studentStatus = "IN_PROGRESS"
      else studentStatus = "NOT_STARTED"
    }
    return {
      id: assignment.id,
      title: assignment.title,
      practiceId: assignment.practice.id,
      practiceStatus: assignment.practice.status,
      type: assignment.practice.type,
      classroomId: assignment.classroom.id,
      classroomName: assignment.classroom.name,
      status: assignment.status,
      availableAt: assignment.availableAt.toISOString(),
      dueAt: assignment.dueAt.toISOString(),
      studentStatus,
      submittedCount,
      totalStudents: classMembers.length,
      leaderboardEnabled: assignment.leaderboardEnabled,
      leaderboardDisplayLimit: assignment.leaderboardDisplayLimit,
      leaderboardDisplayMode: assignment.leaderboardDisplayMode
    }
  }

  private async leaderboardSummary(assignment: TeachingAssignmentEntity, user: AuthUser): Promise<AssignmentLeaderboard> {
    const grades = await this.grades.find({
      where: { assignment: { id: assignment.id }, status: "PUBLISHED" },
      order: { totalScore: "DESC", publishedAt: "ASC" }
    })
    const leaderboard = buildLeaderboardEntries(
      grades.map((grade) => ({
        studentId: grade.student.id,
        studentName: grade.student.displayName,
        totalScore: grade.totalScore,
        passed: grade.passed,
        publishedAt: grade.publishedAt ?? grade.updatedAt
      })),
      assignment.leaderboardDisplayMode,
      assignment.leaderboardDisplayLimit,
      user.role === "student" ? user.id : null
    )
    return {
      assignmentId: assignment.id,
      assignmentTitle: assignment.title,
      classroomId: assignment.classroom.id,
      classroomName: assignment.classroom.name,
      enabled: assignment.leaderboardEnabled,
      displayLimit: assignment.leaderboardDisplayLimit,
      displayMode: assignment.leaderboardDisplayMode,
      publishedCount: grades.length,
      entries: leaderboard.entries,
      currentStudent: leaderboard.currentStudent
    }
  }

  private templateSummary(template: ExerciseTemplateEntity): ExerciseTemplateSummary {
    return {
      id: template.id,
      title: template.title,
      type: template.type,
      difficulty: template.difficulty,
      summary: template.summary,
      tags: template.tags,
      status: template.status,
      currentVersion: template.currentVersion,
      updatedAt: template.updatedAt.toISOString()
    }
  }

  private async listVisiblePractices(user: AuthUser): Promise<PracticeSummary[]> {
    const practices = await this.practices.find({ order: { updatedAt: "DESC" } })
    const visible = practices.filter((practice) => user.role === "admin"
      || (user.role === "teacher" && practice.createdBy.id === user.id)
      || (user.role === "student" && practice.status === "PUBLISHED" && practice.publishedScene))
    return visible.map((practice) => ({ id: practice.id, title: practice.title, type: practice.type, status: practice.status, sceneVersion: practice.sceneVersion, updatedAt: practice.updatedAt.toISOString() }))
  }

  private async findClassroom(id: string) {
    const classroom = await this.classrooms.findOne({ where: { id } })
    if (!classroom) throw new NotFoundException("班级不存在")
    return classroom
  }

  private async findAssignment(id: string) {
    const assignment = await this.assignments.findOne({ where: { id } })
    if (!assignment) throw new NotFoundException("班级实训不存在")
    return assignment
  }

  private async requireAssignmentAccess(assignment: TeachingAssignmentEntity, user: AuthUser) {
    if (user.role === "admin") return
    if (user.role === "teacher" && assignment.createdBy.id === user.id) return
    if (user.role === "student" && await this.members.findOne({ where: { classroom: { id: assignment.classroom.id }, student: { id: user.id } } })) return
    throw new ForbiddenException("无权访问该班级实训")
  }

  private async requireClassroomAccess(classroom: ClassroomEntity, user: AuthUser) {
    if (user.role === "admin") return
    if (user.role === "teacher" && classroom.createdBy.id === user.id) return
    if (user.role === "student" && await this.members.findOne({ where: { classroom: { id: classroom.id }, student: { id: user.id } } })) return
    throw new ForbiddenException("无权访问该班级")
  }

  private requireTeacher(user: AuthUser) {
    if (user.role !== "teacher" && user.role !== "admin") throw new ForbiddenException("需要教师权限")
  }

}
