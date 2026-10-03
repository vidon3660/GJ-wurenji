import { describe, expect, it } from "vitest"
import { normalizeStudentImports } from "./student-import.js"

describe("student import validation", () => {
  it("normalizes email and keeps the teacher supplied password", () => {
    expect(normalizeStudentImports([{ email: " Student3@Demo.Local ", displayName: " 王同学 ", password: "secure-pass-01" }])).toEqual([
      { email: "student3@demo.local", displayName: "王同学", password: "secure-pass-01" }
    ])
  })

  it("rejects duplicate emails", () => {
    expect(() => normalizeStudentImports([
      { email: "student3@demo.local", displayName: "王同学", password: "secure-pass-01" },
      { email: "STUDENT3@demo.local", displayName: "赵同学", password: "secure-pass-02" }
    ])).toThrow("重复邮箱")
  })
})
