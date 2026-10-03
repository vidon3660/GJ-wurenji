import { createHash } from "node:crypto"

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value))
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("规范化 JSON 不支持非有限数值")
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) return value.map(normalize)
  if (typeof value === "object") {
    const object = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(object).sort().map((key) => {
      const item = object[key]
      if (item === undefined) throw new TypeError(`规范化 JSON 不支持 undefined：${key}`)
      return [key, normalize(item)]
    }))
  }
  throw new TypeError(`规范化 JSON 不支持 ${typeof value}`)
}
