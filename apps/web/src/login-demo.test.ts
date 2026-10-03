import { describe, expect, it } from "vitest"
import { demoAccountEmail } from "./login-demo"

describe("demo login account selection", () => {
  it("selects the configured demo account without carrying a password", () => {
    expect(demoAccountEmail("teacher")).toBe("teacher@demo.local")
    expect(demoAccountEmail("student")).toBe("student@demo.local")
  })
})
