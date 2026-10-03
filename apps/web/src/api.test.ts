import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, api } from "./api"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("api", () => {
  it("sends JSON requests with the session cookie", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(api<{ ok: boolean }>("/example", { method: "POST", body: JSON.stringify({ value: 1 }) })).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith("/api/example", expect.objectContaining({
      credentials: "include",
      method: "POST",
      headers: expect.any(Headers)
    }))
    const request = fetchMock.mock.calls[0]![1] as RequestInit
    expect((request.headers as Headers).get("Content-Type")).toBe("application/json")
  })

  it("lets the browser set multipart boundaries for FormData", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }))
    vi.stubGlobal("fetch", fetchMock)
    const form = new FormData()
    form.append("file", new Blob(["archive"]), "resource.zip")

    await api("/v3/resource-packages/upload", { method: "POST", body: form })

    const request = fetchMock.mock.calls[0]![1] as RequestInit
    expect(request.body).toBe(form)
    expect((request.headers as Headers).has("Content-Type")).toBe(false)
  })

  it("surfaces backend validation messages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: ["场景无效", "请检查参数"] }), {
      status: 400,
      headers: { "content-type": "application/json" }
    })))

    const request = api("/example")
    await expect(request).rejects.toBeInstanceOf(ApiError)
    await expect(request).rejects.toEqual(expect.objectContaining({
      message: "场景无效；请检查参数",
      status: 400
    }))
  })
})
