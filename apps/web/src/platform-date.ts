export const PLATFORM_TIME_ZONE = "Asia/Shanghai"

const compactDateOptions: Intl.DateTimeFormatOptions = {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
}

const dateTimeOptions: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
}

export function formatPlatformDate(value: string | Date, options: Intl.DateTimeFormatOptions = compactDateOptions): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  return new Intl.DateTimeFormat("zh-CN", { ...options, timeZone: PLATFORM_TIME_ZONE }).format(date)
}

export function formatPlatformDateTime(value: string | Date): string {
  return formatPlatformDate(value, dateTimeOptions)
}
