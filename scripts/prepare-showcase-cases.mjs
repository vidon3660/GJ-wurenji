import { spawnSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const outputDirectory = resolve(root, "artifacts", "showcase")
await mkdir(outputDirectory, { recursive: true })

const cases = [
  {
    code: "SHOWCASE-CITY-SHOW",
    title: "系统展示-城市集群表演-3000架",
    script: "scripts/prepare-show-alert-browser-fixture.mjs",
    output: "artifacts/showcase/city-show.json",
    env: {
      RUNTIME_FIXTURE_PREFIX: "系统展示-城市集群表演",
      RUNTIME_FIXTURE_SHOW_STOP_AT: "RUNTIME_ACTIVE",
      RUNTIME_FIXTURE_IS_ACCEPTANCE_DATA: "false",
      RUNTIME_FIXTURE_OUTPUT: "artifacts/showcase/city-show.json"
    }
  },
  {
    code: "SHOWCASE-CITY-LOGISTICS",
    title: "系统展示-城市低空物流-20架",
    script: "scripts/prepare-stu012-browser-fixture.mjs",
    output: "artifacts/showcase/city-logistics.json",
    env: {
      STU012_FIXTURE_SCALE: "LOGISTICS_20",
      STU012_FIXTURE_STOP_AT: "RUNTIME_ACTIVE",
      STU012_FIXTURE_IS_ACCEPTANCE_DATA: "false",
      STU012_FIXTURE_REPLAY_EVENT: "ORDER_PRIORITY_CHANGED",
      STU012_FIXTURE_TITLE: "系统展示-城市低空物流-20架",
      STU012_FIXTURE_OUTPUT: "artifacts/showcase/city-logistics.json"
    }
  },
  {
    code: "SHOWCASE-VTL-INSPECTION",
    title: "系统展示-垂起广域巡检-5架",
    script: "scripts/prepare-vtl-browser-fixture.mjs",
    output: "artifacts/showcase/vtl-inspection.json",
    env: {
      VTL_FIXTURE_SCALE: "VTL_5",
      VTL_FIXTURE_STOP_AT: "RUNTIME_ACTIVE",
      VTL_FIXTURE_IS_ACCEPTANCE_DATA: "false",
      VTL_FIXTURE_TITLE: "系统展示-垂起广域巡检-5架",
      VTL_FIXTURE_OUTPUT: "artifacts/showcase/vtl-inspection.json"
    }
  }
]

const preparedCases = []
for (const definition of cases) {
  const outputPath = resolve(root, definition.output)
  if (process.env.SHOWCASE_FORCE !== "true") {
    try {
      const payload = JSON.parse(await readFile(outputPath, "utf8"))
      preparedCases.push({ code: definition.code, title: definition.title, output: definition.output, payload })
      process.stdout.write(`\n[showcase] Reusing ${definition.title}\n`)
      continue
    } catch {
      // Prepare the missing or invalid case below.
    }
  }
  process.stdout.write(`\n[showcase] Preparing ${definition.title}\n`)
  const result = spawnSync(process.execPath, [resolve(root, definition.script)], {
    cwd: root,
    env: { ...process.env, ...definition.env },
    stdio: "inherit"
  })
  if (result.status !== 0) throw new Error(`${definition.title} 准备失败，退出码 ${result.status ?? "unknown"}`)
  const payload = JSON.parse(await readFile(outputPath, "utf8"))
  preparedCases.push({ code: definition.code, title: definition.title, output: definition.output, payload })
}

const index = {
  format: "wurenji-showcase-cases",
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  login: {
    teacher: { email: "teacher@demo.local", password: process.env.DEMO_TEACHER_PASSWORD ?? "" },
    student: { email: "student@demo.local", password: process.env.DEMO_STUDENT_PASSWORD ?? "" }
  },
  cases: preparedCases
}
await writeFile(resolve(outputDirectory, "showcase-cases.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8")
process.stdout.write(`\n[showcase] Ready: ${resolve(outputDirectory, "showcase-cases.json")}\n`)
