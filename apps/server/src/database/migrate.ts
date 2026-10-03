import { AppDataSource } from "./data-source.js"

async function migrate() {
  await AppDataSource.initialize()
  try {
    await ensureRequiredExtensions()
    await adoptLegacySynchronizeSchema()
    const migrations = await AppDataSource.runMigrations({ transaction: "all" })
    console.log(migrations.length === 0 ? "Database is up to date" : `Applied migrations: ${migrations.map((item) => item.name).join(", ")}`)
  } finally {
    await AppDataSource.destroy()
  }
}

const legacyMigration = { timestamp: 1785802052382, name: "LegacyBaseline1785802052382" }
const legacyTables = [
  "users",
  "practices",
  "solutions",
  "solution_versions",
  "simulation_runs",
  "submissions",
  "courses",
  "course_classes",
  "class_members",
  "onboarding_states",
  "exercise_templates",
  "exercise_versions",
  "teaching_assignments",
  "grades",
  "result_files"
]

async function ensureRequiredExtensions() {
  await AppDataSource.query('CREATE EXTENSION IF NOT EXISTS "postgis"')
}

async function adoptLegacySynchronizeSchema() {
  const queryRunner = AppDataSource.createQueryRunner()
  await queryRunner.connect()
  try {
    if (!(await queryRunner.hasTable("users"))) return
    const missing = []
    for (const table of legacyTables) {
      if (!(await queryRunner.hasTable(table))) missing.push(table)
    }
    if (missing.length > 0) throw new Error(`检测到不完整的旧数据库，缺少表：${missing.join(", ")}`)
    if (await queryRunner.hasTable("assignment_drafts")) {
      const recorded = await hasRecordedMigration(queryRunner, legacyMigration.name)
      if (!recorded) throw new Error("检测到未受 migration 管理的 V3 表，请先备份并人工核对数据库状态")
      return
    }
    await AppDataSource.query(`
      CREATE TABLE IF NOT EXISTS "typeorm_migrations" (
        "id" SERIAL NOT NULL,
        "timestamp" bigint NOT NULL,
        "name" character varying NOT NULL,
        CONSTRAINT "PK_typeorm_migrations" PRIMARY KEY ("id")
      )
    `)
    const rows = await AppDataSource.query('SELECT "name" FROM "typeorm_migrations"') as Array<{ name: string }>
    if (rows.length > 0 && !rows.some((row) => row.name === legacyMigration.name)) {
      throw new Error("数据库已有未知 migration 历史，不能自动登记旧基线")
    }
    if (!rows.some((row) => row.name === legacyMigration.name)) {
      await AppDataSource.query(
        'INSERT INTO "typeorm_migrations" ("timestamp", "name") VALUES ($1, $2)',
        [legacyMigration.timestamp, legacyMigration.name]
      )
      console.log(`Adopted legacy synchronize schema as ${legacyMigration.name}`)
    }
  } finally {
    await queryRunner.release()
  }
}

async function hasRecordedMigration(queryRunner: ReturnType<typeof AppDataSource.createQueryRunner>, name: string): Promise<boolean> {
  if (!(await queryRunner.hasTable("typeorm_migrations"))) return false
  const rows = await queryRunner.query('SELECT 1 FROM "typeorm_migrations" WHERE "name" = $1 LIMIT 1', [name]) as unknown[]
  return rows.length > 0
}

void migrate().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
