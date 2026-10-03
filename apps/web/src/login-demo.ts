export type DemoLoginRole = "teacher" | "student"

const demoAccountEmails: Record<DemoLoginRole, string> = {
  teacher: "teacher@demo.local",
  student: "student@demo.local"
}

/**
 * Demo passwords are injected into the server environment and must never be
 * bundled into the web client. The login page only needs the account email.
 */
export function demoAccountEmail(role: DemoLoginRole): string {
  return demoAccountEmails[role]
}
