export function returnedRows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return []
  if (Array.isArray(result[0]) && typeof result[1] === "number") return result[0] as T[]
  return result as T[]
}
