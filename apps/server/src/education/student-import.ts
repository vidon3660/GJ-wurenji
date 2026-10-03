import { BadRequestException } from "@nestjs/common"

export interface StudentImportInput {
  email?: string
  displayName?: string
  password?: string
}

export interface NormalizedStudentImport {
  email: string
  displayName: string
  password: string
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function normalizeStudentImports(rows: StudentImportInput[]): NormalizedStudentImport[] {
  if (!Array.isArray(rows) || rows.length === 0) throw new BadRequestException("请至少提供一名学生")
  if (rows.length > 500) throw new BadRequestException("单次最多导入 500 名学生")

  const seen = new Set<string>()
  return rows.map((row, index) => {
    const email = row.email?.trim().toLowerCase() ?? ""
    const displayName = row.displayName?.trim() ?? ""
    const password = row.password?.trim() ?? ""
    if (!emailPattern.test(email)) throw new BadRequestException(`第 ${index + 1} 行邮箱格式不正确`)
    if (!displayName) throw new BadRequestException(`第 ${index + 1} 行缺少学生姓名`)
    if (password.length < 8) throw new BadRequestException(`第 ${index + 1} 行密码至少需要 8 位`)
    if (seen.has(email)) throw new BadRequestException(`导入内容包含重复邮箱：${email}`)
    seen.add(email)
    return { email, displayName, password }
  })
}
