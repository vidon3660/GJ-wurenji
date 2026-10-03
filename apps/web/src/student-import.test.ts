import { describe, expect, it } from "vitest"
import { parseStudentCsv } from "./student-import"

describe("student CSV import", () => {
  it("supports Chinese headers and quoted names", () => {
    expect(parseStudentCsv("邮箱,姓名,初始密码\nstudent3@demo.local,\"王,同学\",password123")).toEqual([
      { email: "student3@demo.local", displayName: "王,同学", password: "password123" }
    ])
  })

  it("keeps omitted passwords empty so the teacher must set one", () => {
    expect(parseStudentCsv("email,displayName\nstudent4@demo.local,赵同学")[0]?.password).toBe("")
  })
})
