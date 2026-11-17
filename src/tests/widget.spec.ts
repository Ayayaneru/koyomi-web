import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, patchConfig, type EventRow, type TaskRow } from '../core/db'
import { buildWidgetSnapshot, widgetShape, WIDGET_DEFAULT_COUNT, WIDGET_DEFAULT_DAYS } from '../core/widget'

const HOUR = 3_600_000
const DAY = 24 * HOUR

function event(id: string, startAt: number, endAt: number): EventRow {
  return {
    id,
    title: '日程 ' + id,
    startAt,
    endAt,
    repeatKind: 0,
    weekParity: 0,
    source: 1,
    version: 1,
    createdAt: startAt,
    updatedAt: startAt
  }
}

function task(id: string, dueAt: number, enabled = true): TaskRow {
  return {
    id,
    title: '任务 ' + id,
    kind: 0,
    dueAt,
    enabled,
    version: 1,
    createdAt: dueAt,
    updatedAt: dueAt
  }
}

beforeEach(async () => {
  await db.events.clear()
  await db.tasks.clear()
  await db.config.clear()
})

describe('桌面小工具快照（2026-11-15）', () => {
  it('默认最近 7 天、显示 2 条；越界的值会夹回来', () => {
    expect(widgetShape()).toEqual({ days: WIDGET_DEFAULT_DAYS, count: WIDGET_DEFAULT_COUNT })
    expect(widgetShape({ days: 0, count: 9 })).toEqual({ days: 1, count: 2 })
    expect(widgetShape({ days: 999, count: 0 })).toEqual({ days: 30, count: 1 })
  })

  it('逾期没做的任务排最前，进行中的日程不消失，超范围的不进快照', async () => {
    const now = Date.now()
    await patchConfig({ prefs: { widget: { days: 7, count: 2 } } })
    await db.events.bulkAdd([
      event('doing', now - HOUR / 2, now + HOUR / 2),
      event('later', now + HOUR, now + 2 * HOUR),
      event('far', now + 9 * DAY, now + 9 * DAY + HOUR)
    ])
    await db.tasks.bulkAdd([
      task('overdue', now - HOUR),
      task('soon', now + HOUR / 4),
      task('closed', now + HOUR / 8, false)
    ])

    const snap = await buildWidgetSnapshot(now)
    expect(snap.v).toBe(1)
    expect(snap.entries.map(e => e.title)).toEqual(['任务 overdue', '日程 doing'])
    expect(snap.entries[0].overdue).toBe(true)
    expect(snap.entries[1].overdue).toBeUndefined()
    expect(snap.entries[0].path).toBe('/task')
    expect(snap.entries[1].path).toBe(`/schedule?at=${now - HOUR / 2}`)
  })

  it('设置成 1 条就只给 1 条，且取最近的那条', async () => {
    const now = Date.now()
    await patchConfig({ prefs: { widget: { days: 3, count: 1 } } })
    await db.tasks.bulkAdd([task('a', now + 2 * HOUR), task('b', now + HOUR)])
    const snap = await buildWidgetSnapshot(now)
    expect(snap.count).toBe(1)
    expect(snap.entries.map(e => e.title)).toEqual(['任务 b'])
  })
})
