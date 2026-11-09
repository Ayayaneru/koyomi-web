import { describe, expect, it } from 'vitest'
import { LEAD_MINUTES, planEventReminders } from '../features/schedule/reminders'
import type { EventRow } from '../core/db'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** 固定一个「现在」，免得测试跟着运行时间飘 */
const now = new Date(2026, 10, 3, 12, 0, 0, 0).getTime()

function event(patch: Partial<EventRow> = {}): EventRow {
  return {
    id: 'ev1',
    title: '高等数学',
    startAt: now + HOUR,
    endAt: now + 2 * HOUR,
    repeatKind: 0,
    weekParity: 0,
    source: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...patch
  }
}

describe('日程提醒排期', () => {
  it('一次性日程：提前 5 分钟，只排一条', () => {
    const list = planEventReminders([event()], now)
    expect(list).toHaveLength(1)
    expect(list[0].at).toBe(now + HOUR - LEAD_MINUTES * MINUTE)
    expect(list[0].key).toBe(`ev:ev1:${now + HOUR}`)
    expect(list[0].body).toContain('5 分钟后开始')
  })

  it('已经开始 / 提醒时刻已过的，不补发', () => {
    expect(planEventReminders([event({ startAt: now - HOUR, endAt: now })], now)).toEqual([])
    // 3 分钟后开始，提前 5 分钟的那个时刻已经过去了
    expect(planEventReminders([event({ startAt: now + 3 * MINUTE })], now)).toEqual([])
  })

  it('每天重复的：按未来 30 天展开成 30 条', () => {
    const list = planEventReminders([event({ repeatKind: 1 })], now)
    expect(list).toHaveLength(30)
    expect(list[0].at).toBe(now + HOUR - LEAD_MINUTES * MINUTE)
    expect(list[1].at).toBe(now + HOUR + DAY - LEAD_MINUTES * MINUTE)
  })

  it('30 天以后的日程不排（打开 App 会重排）', () => {
    const far = event({ startAt: now + 31 * DAY, endAt: now + 31 * DAY + HOUR })
    expect(planEventReminders([far], now)).toEqual([])
  })

  it('按提醒时刻排序，最早的在前面', () => {
    const list = planEventReminders(
      [event({ id: 'b', startAt: now + 5 * HOUR }), event({ id: 'a', startAt: now + 2 * HOUR })],
      now
    )
    expect(list.map(item => item.key.split(':')[1])).toEqual(['a', 'b'])
  })
})
