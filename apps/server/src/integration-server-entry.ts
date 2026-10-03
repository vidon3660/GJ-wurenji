import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"

export function integrationServerEntry(): { entry: string; cwd: string } {
  const candidates = [resolve(process.cwd(), "dist/main.js"), resolve(process.cwd(), "apps/server/dist/main.js")]
  const entry = candidates.find((candidate) => existsSync(candidate))
  if (!entry) throw new Error(`找不到服务构建产物，已检查：${candidates.join(", ")}`)
  return { entry, cwd: dirname(dirname(entry)) }
}

export function integrationWorkerEntry(serverRoot: string): string {
  const entry = resolve(serverRoot, "dist/worker.js")
  if (!existsSync(entry)) throw new Error(`找不到 Worker 构建产物：${entry}`)
  return entry
}
