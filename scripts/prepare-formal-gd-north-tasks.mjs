import { spawnSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const outputDirectory = resolve(root, "artifacts", "formal-gd-north")
await mkdir(outputDirectory, { recursive: true })

function run(script, env) {
  const result = spawnSync(process.execPath, [resolve(root, script)], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit"
  })
  if (result.status !== 0) throw new Error(`${script} 执行失败，退出码 ${result.status ?? "unknown"}`)
}

const common = {
  RUNTIME_FIXTURE_IS_ACCEPTANCE_DATA: "false",
  RUNTIME_FIXTURE_PUBLISH_ONLY: "true",
  RUNTIME_FIXTURE_SHOW_REGION_CODE: "GD-NORTH-SHOW-01",
  RUNTIME_FIXTURE_LOGISTICS_REGION_CODE: "GD-NORTH-LOGISTICS-01",
  RUNTIME_FIXTURE_SHOW_TITLE: "广东北部城市无人机编队表演正式教学任务",
  RUNTIME_FIXTURE_LOGISTICS_TITLE: "广东北部城市低空物流正式教学任务",
  RUNTIME_FIXTURE_PREFIX: "GD-NORTH-FORMAL",
  RUNTIME_FIXTURE_OUTPUT: "artifacts/formal-gd-north/show-logistics.json"
}

run("scripts/prepare-browser-scale-fixtures.mjs", common)

run("scripts/prepare-vtl-browser-fixture.mjs", {
  VTL_FIXTURE_REGION_CODE: "GD-NORTH-VTOL-01",
  VTL_FIXTURE_IS_ACCEPTANCE_DATA: "false",
  VTL_FIXTURE_PUBLISH_ONLY: "true",
  VTL_FIXTURE_TITLE: "广东北部垂起广域巡检正式教学任务",
  VTL_FIXTURE_OUTPUT: "artifacts/formal-gd-north/vtol.json",
  VTL_FIXTURE_SCALE: "VTL_5",
  VTL_FIXTURE_MODE: "TRAINING"
})

const showLogistics = JSON.parse(await readFile(resolve(root, "artifacts/formal-gd-north/show-logistics.json"), "utf8"))
const vtol = JSON.parse(await readFile(resolve(root, "artifacts/formal-gd-north/vtol.json"), "utf8"))
const result = {
  format: "wurenji-formal-gd-north-tasks",
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  tasks: [
    showLogistics.projects.CITY_SHOW,
    showLogistics.projects.CITY_LOGISTICS,
    vtol
  ].map((task) => ({
    title: task.title,
    sceneType: task.sceneType ?? (task.region?.regionCode.includes("SHOW") ? "CITY_SHOW" : task.region?.regionCode.includes("LOGISTICS") ? "CITY_LOGISTICS" : "VTOL_INSPECTION"),
    regionCode: task.regionCode ?? task.region?.regionCode,
    assignmentId: task.assignmentId,
    projectId: task.projectId,
    isAcceptanceData: task.isAcceptanceData ?? false,
    stage: task.stage
  }))
}
await writeFile(resolve(outputDirectory, "tasks.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
