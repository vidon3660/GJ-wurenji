import { describe, expect, it } from "vitest"
import { buildLeaderboardEntries, displayName } from "./leaderboard.js"

describe("leaderboard", () => {
  it("sorts published grades and gives equal scores the same rank", () => {
    const result = buildLeaderboardEntries([
      { studentId: "s1", studentName: "张同学", totalScore: 88, passed: true, publishedAt: new Date("2026-01-02T00:00:00Z") },
      { studentId: "s2", studentName: "李同学", totalScore: 95, passed: true, publishedAt: new Date("2026-01-01T00:00:00Z") },
      { studentId: "s3", studentName: "王同学", totalScore: 88, passed: true, publishedAt: new Date("2026-01-03T00:00:00Z") }
    ], "ANONYMIZED", 2, "s3")

    expect(result.entries.map((entry) => [entry.rank, entry.totalScore])).toEqual([[1, 95], [2, 88]])
    expect(result.currentStudent).toMatchObject({ rank: 2, displayName: "我", totalScore: 88 })
  })

  it("masks names in anonymized mode", () => {
    expect(displayName("张三丰", "ANONYMIZED")).toBe("张**")
    expect(displayName("Alex", "ANONYMIZED")).toBe("A***")
    expect(displayName("张三", "FULL_NAME")).toBe("张三")
  })
})
