import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)
const outputPath = resolve(argument("output") ?? `artifacts/regression/local-regression-${timestamp()}.json`)
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm"
const checks = []

await runCheck("TEST-ALL", "npm test -- --run", ["test", "--", "--run"])
await runCheck("TYPECHECK", "npm run typecheck", ["run", "typecheck"])

const report = {
  format: "wurenji-local-regression",
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  status: checks.every((check) => check.status === "PASSED") ? "PASSED" : "FAILED",
  checks
}
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify({ status: report.status, checks: checks.map(({ code, status }) => ({ code, status })), output: outputPath })}\n`)
if (report.status !== "PASSED") process.exitCode = 1

async function runCheck(code, command, args) {
  const startedAt = Date.now()
  try {
    const executable = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : npmCommand
    const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", [npmCommand, ...args].join(" ")] : args
    const result = await execFile(executable, commandArgs, { cwd: process.cwd(), windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
    checks.push({ code, status: "PASSED", command, durationMs: Date.now() - startedAt, output: summarize(result.stdout) })
  } catch (error) {
    checks.push({ code, status: "FAILED", command, durationMs: Date.now() - startedAt, output: summarize(error?.stdout), error: summarize(error?.stderr ?? error?.message) })
  }
}

function summarize(value) { return String(value ?? "").slice(-12_000) }
function argument(name) { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : undefined }
function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") }
