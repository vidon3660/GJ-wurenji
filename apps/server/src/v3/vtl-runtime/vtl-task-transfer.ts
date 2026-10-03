import type { VtlRuntimeAircraftView } from "@wurenji/shared"

export type VtlTaskTransferDecision = "WAITING_FOR_SOURCE_EXIT" | "READY_TO_ASSIGN" | "DESTINATION_UNAVAILABLE"

export function vtlTaskTransferDecision(
  sourceStatus: VtlRuntimeAircraftView["status"] | null,
  destinationStatus: VtlRuntimeAircraftView["status"] | null
): VtlTaskTransferDecision {
  if (sourceStatus !== "LANDED") return "WAITING_FOR_SOURCE_EXIT"
  return destinationStatus === "WAITING" || destinationStatus === "ACTIVE"
    ? "READY_TO_ASSIGN"
    : "DESTINATION_UNAVAILABLE"
}
