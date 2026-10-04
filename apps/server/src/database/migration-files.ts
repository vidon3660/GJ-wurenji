import { readdirSync } from "node:fs"
import { join } from "node:path"

/**
 * Return migration modules for both the tsx development command and the
 * compiled production command. Test modules live beside migrations and must
 * not be imported by TypeORM.
 */
export function resolveMigrationFiles(databaseDirectory: string): string[] {
  const migrationDirectory = join(databaseDirectory, "migrations")
  return readdirSync(migrationDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:js|ts)$/.test(entry.name) && !entry.name.endsWith(".d.ts") && !/\.test\.(?:js|ts)$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((fileName) => join(migrationDirectory, fileName))
}
