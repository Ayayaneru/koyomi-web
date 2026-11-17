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

/** 一周从周几开始：0 = 周日，1 = 周一（2026-11-15：周表、月表可以各选各的） */
export type WeekStart = 0 | 1

/** 所在周的起点 00:00，按传入的周起始日算 */
export function weekStartOf(ts: number, start: WeekStart = 0): number {
  const d = new Date(dayStart(ts))
  const back = (d.getDay() - start + 7) % 7
  d.setDate(d.getDate() - back)
  return d.getTime()
}

/** 所在周的周日 00:00（默认的周表起点） */
export function sundayOf(ts: number): number {
  return weekStartOf(ts, 0)
}

/** 所在周的周一 00:00（单双周判断的基准，不用 ISO 周数；不跟显示设置走） */
export function mondayOf(ts: number): number {
  return weekStartOf(ts, 1)
}

/** 表头那 7 个字，从传入的周起始日排起：周日开头 → 日一二三四五六 */
export function weekDayLabels(start: WeekStart = 0): string[] {
  const base = ['日', '一', '二', '三', '四', '五', '六']
  return Array.from({ length: 7 }, (_, i) => base[(start + i) % 7])
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

/** 42 格月历，从周起始日排起（默认周日，可传 1 换成周一） */
export function monthCells(ts: number, start: WeekStart = 0): { ts: number; inMonth: boolean }[] {
  const d = new Date(ts)
  const first = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  const gridStart = weekStartOf(first, start)
  return Array.from({ length: 42 }, (_, i) => {
    const cur = addDays(gridStart, i)
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
