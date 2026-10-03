import Papa from "papaparse"

export interface ParsedStudentRow {
  email: string
  displayName: string
  password: string
}

const aliases = {
  email: ["email", "邮箱", "账号邮箱"],
  displayName: ["displayname", "name", "姓名", "学生姓名"],
  password: ["password", "密码", "初始密码"]
}

function valueOf(row: Record<string, string>, names: string[]): string {
  for (const [key, value] of Object.entries(row)) {
    const normalizedKey = key.trim().toLowerCase().replaceAll(" ", "")
    if (names.includes(normalizedKey)) return value?.trim() ?? ""
  }
  return ""
}

export function parseStudentCsv(content: string): ParsedStudentRow[] {
  const parsed = Papa.parse<Record<string, string>>(content.replace(/^\uFEFF/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim()
  })
  const fatalError = parsed.errors.find((error) => error.type === "Quotes" || error.type === "Delimiter")
  if (fatalError) throw new Error(`CSV 格式错误：${fatalError.message}`)
  const rows = parsed.data.map((row) => ({
    email: valueOf(row, aliases.email).toLowerCase(),
    displayName: valueOf(row, aliases.displayName),
    password: valueOf(row, aliases.password)
  })).filter((row) => row.email || row.displayName)
  if (rows.length === 0) throw new Error("CSV 中没有可导入的学生记录")
  const invalidIndex = rows.findIndex((row) => !row.email || !row.displayName)
  if (invalidIndex >= 0) throw new Error(`第 ${invalidIndex + 2} 行缺少邮箱或姓名`)
  return rows
}
