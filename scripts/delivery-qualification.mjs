export function classConcurrencyFormalQualification(value, options = {}) {
  const minimumStudents = positiveInteger(options.minimumStudents, 20)
  const minimumRounds = positiveInteger(options.minimumRounds, 20)
  const maximumP95Ms = positiveNumber(options.maximumP95Ms, 2_000)
  if (!value) return { status: "PENDING", message: "未找到班级并发验收证据" }
  if (value.status === "BLOCKED") return { status: "PENDING", message: `班级并发验收被环境阻断：${value.reason ?? "未知原因"}` }
  if (value.summary?.functionalPassed === false || Number(value.summary?.failed ?? 0) > 0) {
    return { status: "FAIL", message: "班级并发功能或数据隔离检查失败" }
  }
  const studentCount = Number(value.configuration?.studentCount ?? value.scope?.students?.length ?? 0)
  const rounds = Number(value.configuration?.rounds ?? 0)
  const p95Ms = Number(value.load?.latency?.p95Ms ?? Number.POSITIVE_INFINITY)
  const qualified = studentCount >= minimumStudents && rounds >= minimumRounds && p95Ms <= maximumP95Ms
  return {
    status: qualified ? "PASS" : "PENDING",
    message: `${studentCount}/${minimumStudents} 名学生，${rounds}/${minimumRounds} 轮，P95 ${Number.isFinite(p95Ms) ? p95Ms : "?"}/${maximumP95Ms} ms`,
    qualified
  }
}

export function browserLongRunQualification(value, sceneType, options = {}) {
  const minimumDurationMs = positiveInteger(options.minimumDurationMs, 30 * 60 * 1_000)
  const result = value?.results?.find((item) => item.sceneType === sceneType)
  if (!result) return { status: "PENDING", message: "未找到目标场景浏览器运行证据" }
  if (!result.checks?.functionalPassed) return { status: "FAIL", message: "浏览器功能、帧率、内存或持续连接检查失败" }
  const durationMs = Number(result.rendering?.durationMs ?? 0)
  const streamStayedLive = result.checks?.streamStayedLive === true
  const memoryQualified = result.checks?.memoryGrowthWithinLimit === true
  const scaleQualified = browserScaleQualification(value, sceneType).status === "PASS"
  const qualified = durationMs >= minimumDurationMs && streamStayedLive && memoryQualified && scaleQualified
  const peakGrowth = result.browserMemory?.peakGrowthBytes
  return {
    status: qualified ? "PASS" : "PENDING",
    message: `持续 ${formatDuration(durationMs)}/${formatDuration(minimumDurationMs)}，SSE ${streamStayedLive ? "稳定" : "待补"}，峰值堆增长 ${Number.isFinite(peakGrowth) ? `${Math.round(peakGrowth / 1024 / 1024)} MB` : "待补"}`,
    qualified
  }
}

export function browserScaleQualification(value, sceneType) {
  const result = value?.results?.find((item) => item.sceneType === sceneType)
  if (!result) return { status: "PENDING", message: "未找到目标场景浏览器运行证据", qualified: false }
  if (!result.checks?.functionalPassed) return { status: "FAIL", message: "浏览器功能、帧率、内存或持续连接检查失败", qualified: false }
  const actual = result.scale?.actual ?? {}
  const expected = sceneType === "CITY_SHOW"
    ? { aircraft: 3000 }
    : sceneType === "CITY_LOGISTICS"
      ? { aircraft: 50, orders: 100 }
      : sceneType === "VTOL_INSPECTION"
        ? { aircraft: 20 }
        : null
  if (!expected) return { status: "FAIL", message: `不支持的规模验收场景：${sceneType}`, qualified: false }
  const exact = Object.entries(expected).every(([key, value]) => Number(actual[key]) === value)
  const consistent = result.scale?.consistent === true
  const qualified = exact && consistent && result.scale?.qualified === true
  const target = expected.orders ? `${expected.aircraft} 架/${expected.orders} 单` : `${expected.aircraft} 架`
  const observed = expected.orders ? `${Number(actual.aircraft ?? 0)} 架/${Number(actual.orders ?? 0)} 单` : `${Number(actual.aircraft ?? 0)} 架`
  return {
    status: qualified ? "PASS" : "PENDING",
    message: `实测 ${observed}，目标 ${target}，内部计数${consistent ? "一致" : "不一致或缺失"}`,
    qualified
  }
}

function formatDuration(value) {
  if (value >= 60_000) return `${Math.round(value / 60_000 * 10) / 10} 分钟`
  return `${Math.round(value / 1_000 * 10) / 10} 秒`
}

function positiveInteger(value, fallback) { const parsed = Number.parseInt(value ?? "", 10); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback }
function positiveNumber(value, fallback) { const parsed = Number(value ?? fallback); return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback }
