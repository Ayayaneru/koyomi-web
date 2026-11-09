import { describe, expect, it } from 'vitest'
import type { EventRow } from '../core/db'
import { addDays, dayStart, diffDays, mondayOf } from '../core/time'
import { eventOccurrences, expandEvents, nextOccurrence } from '../features/schedule/expand'

let seq = 0

function ev(start: string, over: Partial<EventRow> = {}): EventRow {
  const startAt = new Date(start).getTime()
  return {
    id: `ev_${++seq}`,
    title: '测试',
    startAt,
    endAt: startAt + 90 * 60_000,
    repeatKind: 0,
    weekParity: 0,
    source: 0,
    version: 1,
    createdAt: startAt,
    updatedAt: startAt,
    ...over
  }
}

describe('expandEvents 单次与基础重复', () => {
  it('单次事件落在范围内只出现一次', () => {
    const row = ev('2026-10-28T14:00:00')
    const items = expandEvents([row], dayStart(row.startAt), dayStart(row.startAt) + 86_400_000)
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe(`${row.id}@${row.startAt}`)
    expect(items[0].endAt).toBe(row.endAt)
  })

  it('单次事件在范围外不出现', () => {
    const row = ev('2026-10-28T14:00:00')
    const from = dayStart(new Date('2026-11-01').getTime())
    expect(expandEvents([row], from, addDays(from, 7))).toHaveLength(0)
  })

  it('每天重复按天推进', () => {
    const row = ev('2026-10-26T09:00:00', { repeatKind: 1 })
    const from = dayStart(row.startAt)
    const items = expandEvents([row], from, addDays(from, 3))
    expect(items).toHaveLength(3)
    expect(items.map(i => new Date(i.at).getDate())).toEqual([26, 27, 28])
  })

  it('每 N 天重复间隔正确', () => {
    const row = ev('2026-10-26T09:00:00', { repeatKind: 3, repeatEveryN: 2 })
    const from = dayStart(row.startAt)
    const items = expandEvents([row], from, addDays(from, 7))
    expect(items.map(i => new Date(i.at).getDate())).toEqual([26, 28, 30, 1])
  })

  it('repeatUntil 之后的实例不再出现', () => {
    const row = ev('2026-10-26T09:00:00', {
      repeatKind: 1,
      repeatUntil: new Date('2026-10-28T23:59:00').getTime()
    })
    const from = dayStart(row.startAt)
    const items = expandEvents([row], from, addDays(from, 10))
    expect(items).toHaveLength(3)
  })

  it('跨范围的夜间事件也算进当天', () => {
    const row = ev('2026-10-26T23:00:00', { endAt: new Date('2026-10-27T01:00:00').getTime() })
    const from = dayStart(new Date('2026-10-27T00:00:00').getTime())
    const items = expandEvents([row], from, addDays(from, 1))
    expect(items).toHaveLength(1)
  })
})

describe('单双周', () => {
  it('单周只落在奇数周', () => {
    const row = ev('2026-09-09T10:00:00', {
      repeatKind: 2,
      weekParity: 1,
      repeatUntil: new Date('2026-10-31T23:59:00').getTime()
    })
    const from = dayStart(new Date('2026-09-01').getTime())
    const items = expandEvents([row], from, addDays(from, 70))
    const base = mondayOf(row.startAt)
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      const weeks = Math.floor(diffDays(item.at, base) / 7) + 1
      expect(weeks % 2).toBe(1)
    }
  })

  it('双周只落在偶数周', () => {
    const row = ev('2026-09-09T10:00:00', {
      repeatKind: 2,
      weekParity: 2,
      repeatUntil: new Date('2026-10-31T23:59:00').getTime()
    })
    const from = dayStart(new Date('2026-09-01').getTime())
    const items = expandEvents([row], from, addDays(from, 70))
    const base = mondayOf(row.startAt)
    for (const item of items) {
      const weeks = Math.floor(diffDays(item.at, base) / 7) + 1
      expect(weeks % 2).toBe(0)
    }
  })

  it('跨年时单双周不会错位（不用 ISO 周数）', () => {
    const row = ev('2026-12-02T10:00:00', {
      repeatKind: 2,
      weekParity: 1,
      repeatUntil: new Date('2027-02-28T23:59:00').getTime()
    })
    const from = dayStart(new Date('2026-12-01').getTime())
    const items = expandEvents([row], from, new Date('2027-03-01').getTime())
    const base = mondayOf(row.startAt)
    const january = items.filter(i => new Date(i.at).getMonth() === 0)
    expect(january.length).toBeGreaterThan(0)
    for (const item of items) {
      const weeks = Math.floor(diffDays(item.at, base) / 7) + 1
      expect(weeks % 2).toBe(1)
    }
  })
})

describe('辅助函数', () => {
  it('eventOccurrences 不会超出 repeatUntil', () => {
    const row = ev('2026-10-26T09:00:00', {
      repeatKind: 1,
      repeatUntil: new Date('2026-10-27T09:00:00').getTime()
    })
    const list = eventOccurrences(row, row.startAt, addDays(row.startAt, 10))
    expect(list).toHaveLength(2)
  })

  it('nextOccurrence 找到之后最近的一次', () => {
    const row = ev('2026-10-26T09:00:00', { repeatKind: 2 })
    const next = nextOccurrence(row, new Date('2026-10-27T00:00:00').getTime())
    expect(next).toBe(new Date('2026-11-02T09:00:00').getTime())
  })
})
