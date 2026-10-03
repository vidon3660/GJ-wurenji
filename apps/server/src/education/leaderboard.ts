import type { LeaderboardDisplayMode, LeaderboardEntry } from "@wurenji/shared"

export interface LeaderboardGrade {
  studentId: string
  studentName: string
  totalScore: number
  passed: boolean
  publishedAt: Date
}

export function buildLeaderboardEntries(
  grades: LeaderboardGrade[],
  displayMode: LeaderboardDisplayMode,
  displayLimit: number,
  currentStudentId: string | null
) {
  const sorted = [...grades].sort((left, right) =>
    right.totalScore - left.totalScore
      || left.publishedAt.getTime() - right.publishedAt.getTime()
      || left.studentName.localeCompare(right.studentName, "zh-CN")
  )
  let previousScore: number | null = null
  let previousRank = 0
  const allEntries = sorted.map((grade, index): LeaderboardEntry => {
    const rank = previousScore !== null && Math.abs(previousScore - grade.totalScore) < 0.001 ? previousRank : index + 1
    previousScore = grade.totalScore
    previousRank = rank
    const isCurrentUser = grade.studentId === currentStudentId
    return {
      rank,
      displayName: isCurrentUser ? "我" : displayName(grade.studentName, displayMode),
      totalScore: grade.totalScore,
      passed: grade.passed,
      publishedAt: grade.publishedAt.toISOString(),
      isCurrentUser
    }
  })
  return {
    entries: allEntries.slice(0, Math.max(1, displayLimit)),
    currentStudent: allEntries.find((entry) => entry.isCurrentUser) ?? null
  }
}

export function displayName(name: string, mode: LeaderboardDisplayMode) {
  if (mode === "FULL_NAME") return name
  const characters = Array.from(name.trim())
  if (characters.length === 0) return "匿名学生"
  if (characters.length === 1) return `${characters[0]}同学`
  return `${characters[0]}${"*".repeat(Math.min(3, characters.length - 1))}`
}
