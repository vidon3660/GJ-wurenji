import { defineStore } from "pinia"
import type { AuthUser } from "@wurenji/shared"
import { api } from "../api"

export const useSessionStore = defineStore("session", {
  state: () => ({
    user: null as AuthUser | null,
    loading: true
  }),
  actions: {
    async restore() {
      this.loading = true
      try {
        const result = await api<{ user: AuthUser }>("/auth/me")
        this.user = result.user
      } catch {
        this.user = null
      } finally {
        this.loading = false
      }
    },
    async login(email: string, password: string) {
      const result = await api<{ user: AuthUser }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
      })
      this.user = result.user
    },
    async logout() {
      await api("/auth/logout", { method: "POST" })
      this.user = null
    }
  }
})
