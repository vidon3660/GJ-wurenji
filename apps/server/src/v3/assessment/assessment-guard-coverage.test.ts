import { GUARDS_METADATA } from "@nestjs/common/constants"
import { describe, expect, it } from "vitest"
import { AuthGuard } from "../../auth/auth.guard.js"
import { OnlyOfficeCallbackController, ShowDocumentController } from "../documents/show-document.controller.js"
import { ShowReadinessController } from "../show-readiness/show-readiness.controller.js"
import { AssessmentWindowGuard } from "./assessment-window.guard.js"

function guardsFor(controller: object): unknown[] {
  return Reflect.getMetadata(GUARDS_METADATA, controller) ?? []
}

describe("assessment write guard coverage", () => {
  it.each([ShowDocumentController, ShowReadinessController])("protects %s student writes", (controller) => {
    expect(guardsFor(controller)).toEqual(expect.arrayContaining([AuthGuard, AssessmentWindowGuard]))
  })

  it("keeps the server-to-server OnlyOffice callback outside request authentication guards", () => {
    expect(guardsFor(OnlyOfficeCallbackController)).toEqual([])
  })
})
