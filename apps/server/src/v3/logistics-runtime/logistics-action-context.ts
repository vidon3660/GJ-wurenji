import { ConflictException } from "@nestjs/common"
import type { LogisticsRuntimeActionCode } from "@wurenji/shared"
import type { RuntimeAlertEntity, RuntimeEventEntity } from "../runtime/runtime.entities.js"

export function assertLogisticsActionContextPending(
  event: RuntimeEventEntity | null,
  alert: RuntimeAlertEntity | null,
  actionCode: LogisticsRuntimeActionCode
): void {
  if (actionCode === "ACKNOWLEDGE_ALERT") {
    if (alert?.status === "RESOLVED") throw new ConflictException("当前物流告警已经处置完成")
    if (alert?.status === "ACKNOWLEDGED") throw new ConflictException("当前物流告警已经确认")
    return
  }
  const lifecycleStatus = String(event?.payload.lifecycleStatus ?? "")
  if (event && (event.status === "RESOLVED" || event.status === "CANCELLED" || ["CONTROLLED", "ENDED", "RESOLVED"].includes(lifecycleStatus))) {
    throw new ConflictException("当前物流事件已经处置完成")
  }
  if (alert?.status === "RESOLVED") throw new ConflictException("当前物流告警已经处置完成")
}
