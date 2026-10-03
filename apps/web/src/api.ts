const configuredBase = import.meta.env.VITE_API_BASE_URL as string | undefined
const API_BASE = configuredBase?.replace(/\/$/, "") ?? "/api"

export function apiBaseUrl(path: string): string {
  return `${API_BASE}${path}`
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly details?: unknown) {
    super(message)
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")
  const response = await fetch(apiBaseUrl(path), {
    ...options,
    headers,
    credentials: "include"
  })

  const contentType = response.headers.get("content-type") ?? ""
  const body = contentType.includes("application/json") ? await response.json() as unknown : await response.text()
  if (!response.ok) {
    const message = typeof body === "object" && body && "message" in body
      ? Array.isArray((body as { message: unknown }).message)
        ? (body as { message: string[] }).message.join("；")
        : String((body as { message: unknown }).message)
      : `请求失败 (${response.status})`
    throw new ApiError(message, response.status, body)
  }
  return body as T
}

export async function downloadApiFile(path: string, fallbackName: string) {
  const response = await fetch(apiBaseUrl(path), { credentials: "include" })
  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? ""
    const body = contentType.includes("application/json") ? await response.json() as unknown : await response.text()
    const message = typeof body === "object" && body && "message" in body
      ? String((body as { message: unknown }).message)
      : `文件下载失败 (${response.status})`
    throw new ApiError(message, response.status, body)
  }
  const disposition = response.headers.get("content-disposition") ?? ""
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  const filename = encodedName ? decodeURIComponent(encodedName) : fallbackName
  const url = URL.createObjectURL(await response.blob())
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
