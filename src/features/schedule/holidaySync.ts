import { db } from '../../core/db'
import { applyRemoteYear, dropRemoteYear, parseHolidayCn } from './holidays'

/**
 * 节假日联网更新。
 * 数据源：holiday-cn（社区维护的官方通知整理），走 jsDelivr 静态 CDN ——
 * 带 `access-control-allow-origin: *`，浏览器和 APK 的 WebView 都能直接取，不需要代理。
 * 拉到的数据存进 IndexedDB（`holidayCache`），启动时读回来覆盖内置数据；离线就继续用内置的。
 */

/**
 * 多个 CDN 入口按顺序试：`cdn.jsdelivr.net` 在国内经常连不上（手机上一试就「拉取失败」），
 * fastly 和 gcore 是同一个仓库的其它节点，内容一样。
 */
const sources = (year: number) => [
  `https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`,
  `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`,
  `https://gcore.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`
]

export type SyncStatus = 'ok' | 'empty' | 'error'

export interface SyncResult {
  status: SyncStatus
  count: number
  message: string
}

export async function loadCachedHolidays(): Promise<void> {
  try {
    const rows = await db.holidayCache.toArray()
    for (const row of rows) {
      applyRemoteYear({
        year: row.year,
        days: row.days,
        source: 'remote',
        updatedAt: row.updatedAt
      })
    }
  } catch (error) {
    // 缓存读不出来不算故障：内置数据还在
    console.warn('[holiday] 读取本地缓存失败', error)
  }
}

export async function syncHolidays(year: number, timeoutMs = 8000): Promise<SyncResult> {
  let lastError = ''

  for (const url of sources(year)) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { signal: controller.signal, cache: 'no-cache' })
      if (!res.ok) {
        lastError = `数据源返回 HTTP ${res.status}`
        continue
      }
      const data = parseHolidayCn(await res.json())
      if (data.year !== year) {
        lastError = `数据源给的是 ${data.year} 年，和要的不一致`
        continue
      }
      const count = Object.keys(data.days).length
      if (!count) return { status: 'empty', count: 0, message: `${year} 年的放假安排还没公布` }

      applyRemoteYear(data)
      await db.holidayCache.put({
        year,
        days: data.days,
        sourceUrl: url,
        updatedAt: data.updatedAt ?? Date.now()
      })
      return { status: 'ok', count, message: `已更新 ${year} 年，共 ${count} 天有标记` }
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === 'AbortError'
      lastError = aborted ? '请求超时，可能网络不通' : error instanceof Error ? error.message : String(error)
    } finally {
      clearTimeout(timer)
    }
  }

  return { status: 'error', count: 0, message: `拉取失败：${lastError || '网络不通'}` }
}

/** 恢复内置数据（把这个年份的联网缓存删掉） */
export async function resetHolidays(year: number): Promise<void> {
  await db.holidayCache.delete(year)
  dropRemoteYear(year)
}

/** 上一次自动尝试的时间（localStorage，不进备份）：失败也别每次启动都发请求 */
const AUTO_TRY_KEY = 'koyomi.holiday.autoTry'

/**
 * 每月自动更新一次（30 天）。
 * 启动时调用，**不阻塞界面**：网络不通、被墙、数据还没公布都只是静默跳过，
 * 已经存下来的那份继续用。
 */
export async function autoSyncHolidaysIfStale(days = 30): Promise<void> {
  try {
    const last = Number(localStorage.getItem(AUTO_TRY_KEY) ?? 0)
    if (last && Date.now() - last < days * 86400000) return
    localStorage.setItem(AUTO_TRY_KEY, String(Date.now()))
    await syncHolidays(new Date().getFullYear())
  } catch {
    // 启动路径上不能因为联网失败打扰用户
  }
}
