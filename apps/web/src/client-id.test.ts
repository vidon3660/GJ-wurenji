import { describe, expect, it } from "vitest"
import { createClientId } from "./client-id"

describe("client id", () => {
  it("creates a UUID compatible identifier", () => {
    expect(createClientId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
