import { ref } from 'vue'
import { addDays, fmtDate, parseLocal } from '../../core/time'

/**
 * 中国法定节假日与调休（只在月/周日历上做标记，不影响任何业务数据）。
 *
 * 两种来源：
 *  1. **内置**：国办发明电〔2025〕7 号（2026 年）。离线可用，永远有一份兜底。
 *  2. **联网**：holiday-cn（https://github.com/NateScarlet/holiday-cn）的静态 JSON，
 *     每年国办通知发布后由社区更新；点月历上的「更新」拉取，存进 IndexedDB，优先于内置。
 *     没有数据的年份不会瞎标 —— 拉到空数组时如实告诉用户「还没公布」。
 *
 * 节日名的位置统一是「这一段放假的第一天」（春节标在 2/15，即假期首日），
 * 内置和联网同一套规则，两个来源看起来一致。
 */

export type HolidayKind = 'off' | 'work'

export interface HolidayInfo {
  kind: HolidayKind
  /** 只在放假段第一天给名字，其余天不重复写节日名 */
  name?: string
}

export interface HolidayYearData {
  year: number
  days: Record<string, HolidayInfo>
  /** 出处，界面上可以给人看 */
  source: 'builtin' | 'remote'
  updatedAt?: number
  papers?: string[]
}

interface OffSpan {
  from: string
  to: string
  name: string
}

const OFF_SPANS: OffSpan[] = [
  { from: '2026-01-01', to: '2026-01-03', name: '元旦' },
  { from: '2026-02-15', to: '2026-02-23', name: '春节' },
  { from: '2026-04-04', to: '2026-04-06', name: '清明' },
  { from: '2026-05-01', to: '2026-05-05', name: '劳动节' },
  { from: '2026-06-19', to: '2026-06-21', name: '端午节' },
  { from: '2026-09-25', to: '2026-09-27', name: '中秋节' },
  { from: '2026-10-01', to: '2026-10-07', name: '国庆节' }
]

const WORK_DAYS = [
  '2026-01-04',
  '2026-02-14',
  '2026-02-28',
  '2026-05-09',
  '2026-09-20',
  '2026-10-10'
]

function buildBuiltin(): Map<number, HolidayYearData> {
  const years = new Map<number, HolidayYearData>()
  const ensure = (year: number): HolidayYearData => {
    let row = years.get(year)
    if (!row) {
      row = { year, days: {}, source: 'builtin' }
      years.set(year, row)
    }
    return row
  }

  for (const span of OFF_SPANS) {
    const start = parseLocal(span.from)
    const end = parseLocal(span.to)
    for (let day = start; day <= end; day = addDays(day, 1)) {
      const key = fmtDate(day)
      ensure(Number(key.slice(0, 4))).days[key] = {
        kind: 'off',
        name: key === span.from ? span.name : undefined
      }
    }
  }
  for (const key of WORK_DAYS) {
    ensure(Number(key.slice(0, 4))).days[key] = { kind: 'work' }
  }
  return years
}

const builtin = buildBuiltin()
const remote = new Map<number, HolidayYearData>()

/** 数据变了（联网更新 / 恢复内置）就 +1，界面 computed 读它能自动重算 */
export const holidayVersion = ref(0)

/* ============ 联网数据解析 ============ */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isInfo(value: unknown): value is { date: string; name?: string; isOffDay: boolean } {
  if (!value || typeof value !== 'object') return false
  const day = value as Record<string, unknown>
  return typeof day.date === 'string' && DATE_RE.test(day.date) && typeof day.isOffDay === 'boolean'
}

/**
 * 解析 holiday-cn 的 JSON。结构：
 * { year: 2026, papers: [...], days: [{ name, date, isOffDay }] }
 * 坏行跳过；整份不可用就抛错（调用方提示「数据源格式变了」）。
 */
export function parseHolidayCn(raw: unknown): HolidayYearData {
  if (!raw || typeof raw !== 'object') throw new Error('数据源返回的不是 JSON 对象')
  const obj = raw as Record<string, unknown>
  const year = Number(obj.year)
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('数据源里没有年份')
  if (!Array.isArray(obj.days)) throw new Error('数据源里没有 days 数组')
  const list: unknown[] = obj.days

  const days: Record<string, HolidayInfo> = {}
  const offDates: string[] = []
  let skipped = 0

  for (const item of list) {
    if (!isInfo(item)) {
      skipped++
      continue
    }
    const info: HolidayInfo = { kind: item.isOffDay ? 'off' : 'work' }
    days[item.date] = info
    if (item.isOffDay) offDates.push(item.date)
  }

  // 只在每一段放假的第一天写节日名
  const sorted = [...offDates].sort()
  sorted.forEach((date, index) => {
    const prev = index > 0 ? sorted[index - 1] : ''
    const isFirstOfBlock = prev !== fmtDate(addDays(parseLocal(date), -1))
    if (isFirstOfBlock) {
      const name = findName(list, date)
      if (name) days[date].name = name
    }
  })

  if (skipped > 0 && Object.keys(days).length === 0) throw new Error('数据源里的日期全部无法解析')

  return {
    year,
    days,
    source: 'remote',
    updatedAt: Date.now(),
    papers: Array.isArray(obj.papers) ? (obj.papers.filter(p => typeof p === 'string') as string[]) : []
  }
}

function findName(list: unknown[], date: string): string | undefined {
  for (const item of list) {
    if (!isInfo(item) || item.date !== date) continue
    const name = (item as { name?: unknown }).name
    if (typeof name === 'string' && name.trim()) return name.trim()
  }
  return undefined
}

/* ============ 查询 ============ */

export function applyRemoteYear(data: HolidayYearData): void {
  remote.set(data.year, data)
  holidayVersion.value++
}

export function dropRemoteYear(year: number): void {
  if (remote.delete(year)) holidayVersion.value++
}

export function getYearData(year: number): HolidayYearData | undefined {
  return remote.get(year) ?? builtin.get(year)
}

export function holidayOf(ts: number): HolidayInfo | undefined {
  const key = fmtDate(ts)
  const year = Number(key.slice(0, 4))
  return (remote.get(year) ?? builtin.get(year))?.days[key]
}

/** 格子里那句短标签：节日名 > 休 / 班 > 空 */
export function holidayLabel(ts: number): string {
  const info = holidayOf(ts)
  if (!info) return ''
  if (info.name) return info.name
  return info.kind === 'off' ? '休' : '班'
}

export function holidayYears(): number[] {
  return [...new Set([...builtin.keys(), ...remote.keys()])].sort()
}

/** 2027 年的安排公布后，往 OFF_SPANS / WORK_DAYS 各加几行即可；也可以直接用界面上的「更新」 */
export const BUILTIN_YEARS = [...builtin.keys()].sort()
