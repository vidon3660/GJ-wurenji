import { afterEach, describe, expect, it, vi } from "vitest"
import { downloadOnlyOfficeFile } from "./show-document.service.js"

const previousInternalUrl = process.env.ONLYOFFICE_INTERNAL_URL
const previousPublicUrl = process.env.ONLYOFFICE_PUBLIC_URL

describe("ONLYOFFICE callback download", () => {
  afterEach(() => {
    restoreEnvironment("ONLYOFFICE_INTERNAL_URL", previousInternalUrl)
    restoreEnvironment("ONLYOFFICE_PUBLIC_URL", previousPublicUrl)
  })

  it("retries a temporary server error and returns the recovered file", async () => {
    configureUrls()
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("temporarily unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(Buffer.from("PK recovered"), { status: 200 }))
    const sleep = vi.fn().mockResolvedValue(undefined)

    const content = await downloadOnlyOfficeFile("http://localhost:49080/cache/document.docx", { fetcher, sleep, delayMs: 10 })

    expect(content.toString()).toBe("PK recovered")
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(10)
  })

  it("retries network failures up to the configured limit", async () => {
    configureUrls()
    const fetcher = vi.fn().mockRejectedValue(new Error("connection reset"))

    await expect(downloadOnlyOfficeFile("http://localhost:49080/cache/document.docx", {
      attempts: 3,
      delayMs: 1,
      fetcher,
      sleep: vi.fn().mockResolvedValue(undefined)
    })).rejects.toThrow("连续 3 次连接失败")
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it("does not retry a non-transient client error", async () => {
    configureUrls()
    const fetcher = vi.fn().mockResolvedValue(new Response("not found", { status: 404 }))

    await expect(downloadOnlyOfficeFile("http://localhost:49080/cache/missing.docx", {
      fetcher,
      sleep: vi.fn().mockResolvedValue(undefined)
    })).rejects.toThrow("ONLYOFFICE 文件下载失败：404")
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("rejects an oversized callback file without retrying", async () => {
    configureUrls()
    const fetcher = vi.fn().mockResolvedValue(new Response("", {
      status: 200,
      headers: { "content-length": String(25 * 1024 * 1024 + 1) }
    }))

    await expect(downloadOnlyOfficeFile("http://localhost:49080/cache/large.docx", {
      fetcher,
      sleep: vi.fn().mockResolvedValue(undefined)
    })).rejects.toThrow("ONLYOFFICE 回调文件超过 25 MB")
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

function configureUrls() {
  process.env.ONLYOFFICE_INTERNAL_URL = "http://onlyoffice"
  process.env.ONLYOFFICE_PUBLIC_URL = "http://localhost:49080"
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
