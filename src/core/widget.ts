import { db, getConfig, type TaskRow } from './db'
import { expandEvents } from '../features/schedule/expand'

/**
 * 桌面小工具的数据（2026-11-15）。
 *
 * 快照在 App 里算好再交给原生：WebView 里的 IndexedDB 原生读不到，
 * 原生只负责「按当前时间挑出还没过期的几条」和渲染，不做任何业务判断。
 */

export interface WidgetEntry {
  kind: 'event' | 'task'
  title: string
  /** 排序与显示时间：日程开始 / 任务到期 */
  at: number
  /** 日程结束时间（判断「还在进行中」，任务没有） */
  endAt?: number
  /** 已经过期还没做的任务，原生要一直显示它 */
  overdue?: boolean
  /** 点这条跳去哪：日程带 ?at=，任务是任务页 */
  path: string
}

export interface WidgetSnapshot {
  v: 1
  at: number
  days: number
  count: number
  entries: WidgetEntry[]
}

export const WIDGET_DEFAULT_DAYS = 7
export const WIDGET_DEFAULT_COUNT = 2
export const WIDGET_MAX_COUNT = 2

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(max, Math.max(min, num))
}

/** 用户设置的天数 / 条数，越界就夹回来：1 格高最多两行，所以条数上限是 2 */
export function widgetShape(prefs?: { days?: number; count?: number }): { days: number; count: number } {
  return {
    days: clampInt(prefs?.days, 1, 30, WIDGET_DEFAULT_DAYS),
    count: clampInt(prefs?.count, 1, WIDGET_MAX_COUNT, WIDGET_DEFAULT_COUNT)
  }
}

/**
 * 快照里放什么：从现在起 days 天内的日程 + 到期任务，逾期没做的任务排在最前面。
 * 只留 count 条 —— 小工具只有一格高，多出来的原生也没地方放。
 */
export async function buildWidgetSnapshot(now = Date.now()): Promise<WidgetSnapshot> {
  const cfg = await getConfig()
  const { days, count } = widgetShape(cfg.prefs.widget)
  const end = now + days * 86_400_000

  // 开始时间早于现在的日程也要：正在进行中的那条不能消失，所以往前多看几小时
  const eventRows = await db.events.where('startAt').below(end).toArray()
  const events: WidgetEntry[] = expandEvents(eventRows, now - 6 * 3_600_000, end)
    .filter(item => (item.endAt ?? item.at) >= now)
    .map(item => ({
      kind: 'event' as const,
      title: item.title,
      at: item.at,
      endAt: item.endAt,
      path: `/schedule?at=${item.at}`
    }))

  const taskRows: TaskRow[] = await db.tasks.toArray()
  const tasks: WidgetEntry[] = taskRows
    .filter(task => task.enabled && task.dueAt != null && task.dueAt < end)
    .map(task => ({
      kind: 'task' as const,
      title: task.title,
      at: task.dueAt as number,
      overdue: (task.dueAt as number) < now,
      path: '/task'
    }))

  const entries = [...tasks, ...events].sort((a, b) => a.at - b.at).slice(0, count)
  return { v: 1, at: now, days, count, entries }
}
