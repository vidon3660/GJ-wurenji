import { BadRequestException } from "@nestjs/common"
import { describe, expect, it } from "vitest"
import { resolveOnlyOfficeDownloadUrl } from "./show-document.service.js"

describe("resolveOnlyOfficeDownloadUrl", () => {
  it("rewrites the public callback origin to the internal document server", () => {
    const result = resolveOnlyOfficeDownloadUrl(
      "http://localhost:49080/cache/files/output.docx?md5=abc",
      "http://wurenji-onlyoffice-poc",
      "http://localhost:49080"
    )

    expect(result.toString()).toBe("http://wurenji-onlyoffice-poc/cache/files/output.docx?md5=abc")
  })

  it("keeps an already internal callback URL unchanged", () => {
    const result = resolveOnlyOfficeDownloadUrl(
      "http://onlyoffice/cache/files/output.docx",
      "http://onlyoffice",
      "http://localhost:58080"
    )

    expect(result.toString()).toBe("http://onlyoffice/cache/files/output.docx")
  })

  it("rejects callback URLs from an untrusted host", () => {
    expect(() => resolveOnlyOfficeDownloadUrl("http://attacker.invalid/file.docx", "http://onlyoffice", "http://localhost:58080"))
      .toThrowError(BadRequestException)
  })
})
