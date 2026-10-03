import { AppDataSource } from "./data-source.js"

async function revert() {
  await AppDataSource.initialize()
  try {
    const rows = await AppDataSource.query('SELECT "name" FROM "typeorm_migrations" ORDER BY "id" DESC LIMIT 1') as Array<{ name: string }>
    if (rows[0]?.name === "LegacyBaseline1785802052382") {
      throw new Error("禁止回退旧系统基线迁移；请从备份恢复")
    }
    await AppDataSource.undoLastMigration({ transaction: "all" })
    console.log("Reverted the latest migration")
  } finally {
    await AppDataSource.destroy()
  }
}

void revert().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
