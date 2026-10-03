import { describe, expect, it } from "vitest"
import { canonicalJson, sha256Canonical } from "./canonical-json.js"

describe("canonical JSON", () => {
  it("produces the same hash regardless of object key insertion order", () => {
    expect(canonicalJson({ z: 1, nested: { b: 2, a: 1 } })).toBe('{"nested":{"a":1,"b":2},"z":1}')
    expect(sha256Canonical({ a: 1, b: 2 })).toBe(sha256Canonical({ b: 2, a: 1 }))
  })

  it("rejects values that cannot be replayed as JSON", () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow("非有限数值")
    expect(() => canonicalJson({ value: undefined })).toThrow("undefined")
  })
})
