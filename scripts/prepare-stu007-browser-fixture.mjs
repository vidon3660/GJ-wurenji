const apiBase = (process.env.APP_BASE_URL ?? "http://localhost:3000/api").replace(/\/$/, "")
const title = process.env.STU007_FIXTURE_TITLE ?? "STU-007 物流去返程独立新建验收"

const admin = await login("admin@demo.local", process.env.DEMO_ADMIN_PASSWORD ?? "")
const teacher = await login("teacher@demo.local", process.env.DEMO_TEACHER_PASSWORD ?? "")
const student = await login("student@demo.local", process.env.DEMO_STUDENT_PASSWORD ?? "")

const existing = await findEditableProject()
if (existing) {
  process.stdout.write(`${JSON.stringify({ projectId: existing.id, title, reused: true }, null, 2)}\n`)
  process.exit(0)
}

const resources = await request("/v3/resource-packages", { cookie: admin })
const classes = await request("/v1/education/classes", { cookie: teacher })
const regions = await request("/v3/resource-packages/regions/catalog?sceneType=CITY_LOGISTICS", { cookie: admin })
const classroom = classes[0]
const region = regions[0]
const candidate = region?.logisticsNodes?.find((node) => node.type === "DELIVERY_POINT" && node.enabled && node.position)
if (!classroom?.id || !region?.packageId || !candidate?.id) throw new Error("缺少教学班、物流区域或候选配送点")

const resourcePackageIds = selectResources(resources, region.packageId).map((resource) => resource.id)
const draft = await request("/v3/assignments/drafts", {
  method: "POST",
  cookie: teacher,
  body: {
    title,
    sceneType: "CITY_LOGISTICS",
    mode: "TRAINING",
    config: {
      taskBrief: "STU-007 浏览器验收：针对启用配送点分别自主新建去程与返程航线。",
      scaleTemplateCode: "LOGISTICS_3",
      regionPackageId: region.packageId,
      availableAt: new Date(Date.now() - 60_000).toISOString(),
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      allowResubmission: true,
      allowedValidationAttempts: 3,
      allowedRuntimeAttempts: 2,
      resultVisibility: "FULL_REVIEW",
      scenario: {
        orderCount: 3,
        orderReleaseMode: "BATCH",
        priorityProfile: "STANDARD_HEAVY",
        deliveryDistributionMode: "FOCUSED",
        candidateDeliveryPointIds: [candidate.id],
        timeWindowMinutes: 30,
        orderSeed: "stu-007-browser-acceptance"
      }
    }
  }
})
const targets = [{ type: "CLASS", targetId: classroom.id }]
const preview = await request(`/v3/assignments/drafts/${draft.id}/preview`, {
  method: "POST",
  cookie: teacher,
  body: { expectedRevision: draft.revision, targets, resourcePackageIds }
})
await request(`/v3/assignments/drafts/${draft.id}/publish`, {
  method: "POST",
  cookie: teacher,
  body: { expectedRevision: draft.revision, configHash: preview.configHash, targets, resourcePackageIds }
})

const project = await waitForProject()
await request(`/v3/projects/${project.id}/stages/LOGISTICS_REGION_ANALYSIS/start`, {
  method: "POST",
  cookie: student,
  body: { expectedRevision: 1 }
})
let workspace = await request(`/v3/logistics-projects/${project.id}/route-workspace`, { cookie: student })
workspace = await request(`/v3/logistics-projects/${project.id}/region-analysis`, {
  method: "PUT",
  cookie: student,
  body: {
    expectedRevision: workspace.regionAnalysis.revision,
    selectedDeliveryPointIds: [candidate.id],
    notes: "STU-007 验收：确认一个教师候选配送点。"
  }
})
await request(`/v3/logistics-projects/${project.id}/region-analysis/confirm`, {
  method: "POST",
  cookie: student,
  body: { expectedRevision: workspace.regionAnalysis.revision, expectedStageRevision: 2 }
})
await request(`/v3/projects/${project.id}/stages/LOGISTICS_ROUTE_PLANNING/start`, {
  method: "POST",
  cookie: student,
  body: { expectedRevision: 2 }
})
workspace = await request(`/v3/logistics-projects/${project.id}/route-workspace`, { cookie: student })
if (!workspace.canEditRoutes || workspace.draft.routes.length !== 0) throw new Error("STU-007 航线规划夹具未处于空白编辑态")

process.stdout.write(`${JSON.stringify({
  assignmentId: draft.id,
  projectId: project.id,
  title,
  candidateId: candidate.id,
  reused: false
}, null, 2)}\n`)

function selectResources(allResources, regionPackageId) {
  const selected = allResources.filter((resource) => {
    if (resource.status !== "ACTIVE" || resource.manifest?.testOnly === true) return false
    if (resource.packageType === "REGION") return resource.id === regionPackageId
    if (resource.packageType === "DOCUMENT_TEMPLATE") return false
    if (resource.packageType === "SCALE_TEMPLATE" || resource.packageType === "EVENT") {
      return resource.manifest?.sceneType === "CITY_LOGISTICS"
    }
    return true
  })
  const byType = new Map(selected.map((resource) => [resource.packageType, resource]))
  const expectedTypes = ["RULE", "REGION", "SCALE_TEMPLATE", "AIRCRAFT", "EVENT", "REPORT"]
  const missing = expectedTypes.filter((type) => !byType.has(type))
  if (missing.length > 0) throw new Error(`缺少 STU-007 夹具资源：${missing.join(",")}`)
  return expectedTypes.map((type) => byType.get(type))
}

async function findEditableProject() {
  const projects = await request("/v3/my-projects", { cookie: student })
  for (const project of projects.filter((item) => item.title === title && item.sceneType === "CITY_LOGISTICS")) {
    const workspace = await request(`/v3/logistics-projects/${project.id}/route-workspace`, { cookie: student })
    if (workspace.canEditRoutes) return project
  }
  return null
}

async function waitForProject() {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const projects = await request("/v3/my-projects", { cookie: student })
    const project = projects.find((item) => item.title === title && item.sceneType === "CITY_LOGISTICS")
    if (project) return project
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error("发布后未找到 STU-007 学生物流项目")
}

async function login(email, password) {
  const response = await fetch(`${apiBase}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  })
  const body = await parseBody(response)
  if (!response.ok) throw new Error(`登录失败 ${email}: ${response.status} ${JSON.stringify(body)}`)
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0]
  if (!cookie) throw new Error(`登录没有返回会话 Cookie：${email}`)
  return cookie
}

async function request(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  })
  const body = await parseBody(response)
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path} -> ${response.status}: ${JSON.stringify(body)}`)
  return body
}

async function parseBody(response) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
