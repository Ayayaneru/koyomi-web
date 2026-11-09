/* 日期工具：全部按本地时区算，不引入任何日期库 */

export const DAY_MS = 86_400_000

const pad = (n: number) => String(n).padStart(2, '0')

export function fmtDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fmtDateTime(ts: number): string {
  return `${fmtDate(ts)} ${fmtTime(ts)}`
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function weekdayName(ts: number): string {
  return WEEKDAYS[new Date(ts).getDay()]
}

export function weekdayShort(ts: number): string {
  return WEEKDAYS[new Date(ts).getDay()].slice(1)
}

/** 当天 00:00 的毫秒数 */
export function dayStart(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function dayEnd(ts: number): number {
  return dayStart(addDays(ts, 1))
}

export function addDays(ts: number, n: number): number {
  const d = new Date(ts)
  d.setDate(d.getDate() + n)
  return d.getTime()
}

export function addMonths(ts: number, n: number): number {
  const d = new Date(ts)
  d.setMonth(d.getMonth() + n)
  return d.getTime()
}

/** 所在周的周一 00:00（单双周判断的基准，不用 ISO 周数） */
/** 一周从周日开始：2026-11-01（周日）→ 那天 0 点 */
export function sundayOf(ts: number): number {
  const d = new Date(dayStart(ts))
  d.setDate(d.getDate() - d.getDay())
  return d.getTime()
}

export function mondayOf(ts: number): number {
  const d = new Date(dayStart(ts))
  const wd = d.getDay() // 0 = 周日
  const back = wd === 0 ? 6 : wd - 1
  d.setDate(d.getDate() - back)
  return d.getTime()
}

/** 两个时间点相隔几个「自然日」，只比日期部分 */
export function diffDays(a: number, b: number): number {
  return Math.round((dayStart(a) - dayStart(b)) / DAY_MS)
}

/** "2026-10-28 14:00" → 本地毫秒。模型给的时间一律按这个格式解析 */
export function parseLocal(text: string): number {
  const m = String(text).trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/)
  if (!m) throw new Error(`时间格式应为 "2026-10-28 14:00"，收到：${text}`)
  const [, y, mo, d, h, mi] = m
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), 0, 0).getTime()
}

/** <input type="datetime-local"> 的值 */
export function toInputDateTime(ts: number): string {
  return `${fmtDate(ts)}T${fmtTime(ts)}`
}

export function fromInputDateTime(value: string): number {
  return parseLocal(value.replace('T', ' '))
}

/** <input type="date"> 的值 */
export function toInputDate(ts: number): string {
  return fmtDate(ts)
}

export function fromInputDate(value: string): number {
  return parseLocal(value)
}

/** 42 格月历（从周一开始） */
export function monthCells(ts: number): { ts: number; inMonth: boolean }[] {
  const d = new Date(ts)
  const first = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  // 2026-11-01：月历改成周日开头（表头顺序跟着变），和周日开始的周视图对齐
  const start = sundayOf(first)
  return Array.from({ length: 42 }, (_, i) => {
    const cur = addDays(start, i)
    return { ts: cur, inMonth: new Date(cur).getMonth() === d.getMonth() }
  })
}

/** 文件名时间戳：20261026-2102 */
export function stamp(ts = Date.now()): string {
  const d = new Date(ts)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

export function hourLabel(h: number): string {
  return `${pad(h)}:00`
}
