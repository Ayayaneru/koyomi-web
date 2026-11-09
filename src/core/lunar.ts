/**
 * 农历。用浏览器内置的 Intl 中国历（ICU 数据，离线可用），不引任何依赖。
 * 只取「月名 + 日」，够月历格子用；节气、宜忌这些不做。
 */

const DAY_NAMES = [
  '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'
]

export interface LunarInfo {
  /** 正月 / 二月 / 闰二月 / 十一月 / 腊月 */
  month: string
  /** 1-30 */
  day: number
  /** 格子里显示的短标签：初一显示月名，其余显示「初五 / 廿三」 */
  label: string
  /** 是否初一（可以显示月名） */
  isFirstDay: boolean
}

type PartsFormatter = { formatToParts(date: Date): { type: string; value: string }[] }

let formatter: PartsFormatter | null | undefined

function getFormatter(): PartsFormatter | null {
  if (formatter !== undefined) return formatter
  try {
    formatter = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long', day: 'numeric' })
  } catch {
    formatter = null
  }
  return formatter
}

const cache = new Map<number, LunarInfo | null>()

/** 拿某一天的农历；浏览器不支持中国历时返回 null，界面上就只显示公历 */
export function lunarOf(ts: number): LunarInfo | null {
  const key = Math.floor(ts / 86_400_000)
  if (cache.has(key)) return cache.get(key) ?? null

  const fmt = getFormatter()
  if (!fmt) {
    cache.set(key, null)
    return null
  }

  try {
    // 用中午 12 点，避开时区/夏令时把日期推前一天的边界情况
    const date = new Date(ts)
    date.setHours(12, 0, 0, 0)
    const parts = fmt.formatToParts(date)
    const month = parts.find(p => p.type === 'month')?.value ?? ''
    const day = Number(parts.find(p => p.type === 'day')?.value ?? '')
    if (!month || !day) {
      cache.set(key, null)
      return null
    }
    const info: LunarInfo = {
      month,
      day,
      // 初一只显示月名（正月 / 闰六月），其余显示「初五 / 廿三」
      label: day === 1 ? month : (DAY_NAMES[day - 1] ?? ''),
      isFirstDay: day === 1
    }
    cache.set(key, info)
    return info
  } catch {
    cache.set(key, null)
    return null
  }
}

export function lunarLabel(ts: number): string {
  return lunarOf(ts)?.label ?? ''
}

/** 给测试和调试用：清掉按天缓存 */
export function clearLunarCache(): void {
  cache.clear()
}
