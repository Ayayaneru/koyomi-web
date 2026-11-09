import { describe, expect, it } from 'vitest'
import type { TaskRow } from '../core/db'
import { checkDue, dueChip, firstDueAt, isFinished, nextDueAt } from '../features/task/due'

const at = (text: string) => new Date(text).getTime()

describe('nextDueAt', () => {
  it('跨月', () => {
    expect(nextDueAt(at('2026-01-30T10:00:00'), 3, '09:00')).toBe(at('2026-02-02T09:00:00'))
  })

  it('跨年', () => {
    expect(nextDueAt(at('2026-12-30T10:00:00'), 5, '09:00')).toBe(at('2027-01-04T09:00:00'))
  })

  it('anchor 早于当前时刻：仍然是加满天数，时间点对齐 anchor', () => {
    // 20:00 完成、anchor 09:00、7 天一次 → 11-02 09:00，而不是 11-01 09:00
    expect(nextDueAt(at('2026-10-26T20:00:00'), 7, '09:00')).toBe(at('2026-11-02T09:00:00'))
  })

  it('anchor 晚于当前时刻：同样对齐 anchor，不会提前一天', () => {
    expect(nextDueAt(at('2026-10-26T08:00:00'), 7, '09:30')).toBe(at('2026-11-02T09:30:00'))
  })

  it('没有 anchor 时保留原来的时刻', () => {
    expect(nextDueAt(at('2026-10-26T20:15:00'), 2)).toBe(at('2026-10-28T20:15:00'))
  })
})

describe('firstDueAt', () => {
  it('今天到点还没过就用今天', () => {
    expect(firstDueAt(at('2026-10-26T08:00:00'), '09:00')).toBe(at('2026-10-26T09:00:00'))
  })

  it('今天已经过了就明天', () => {
    expect(firstDueAt(at('2026-10-26T10:00:00'), '09:00')).toBe(at('2026-10-27T09:00:00'))
  })
})

function task(over: Partial<TaskRow>): TaskRow {
  const now = Date.now()
  return {
    id: 'tk_1',
    title: '浇花',
    icon: '🌱',
    kind: 1,
    intervalDays: 7,
    enabled: true,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...over
  }
}

describe('checkDue', () => {
  const now = at('2026-10-26T12:00:00')

  it('只报已到期且启用的任务', () => {
    const list = checkDue(
      [
        task({ id: 'a', dueAt: at('2026-10-24T09:00:00') }),
        task({ id: 'b', dueAt: at('2026-10-30T09:00:00') }),
        task({ id: 'c', dueAt: at('2026-10-20T09:00:00'), enabled: false })
      ],
      now
    )
    expect(list.map(item => item.taskId)).toEqual(['a'])
    expect(list[0].overdueDays).toBe(2)
  })

  it('一次性任务也同等对待（不看 kind）', () => {
    const list = checkDue([task({ id: 'once', kind: 0, intervalDays: undefined, dueAt: now - 1000 })], now)
    expect(list).toHaveLength(1)
    expect(list[0].overdueDays).toBe(0)
  })

  it('图标为空时退化成标题首字', () => {
    const list = checkDue([task({ id: 'x', icon: undefined, dueAt: now - 1000 })], now)
    expect(list[0].icon).toBe('浇')
  })
})

describe('dueChip（卡片右边的「几天后」）', () => {
  const now = at('2026-10-29T08:00:00')
  const chip = (over: Partial<TaskRow>) => dueChip({ kind: 1, enabled: true, dueAt: undefined, ...over }, now)

  it('按自然日算：今天 / 明天 / N 天后', () => {
    expect(chip({ dueAt: at('2026-10-29T21:00:00') })).toEqual({ text: '今天', tone: 'soon' })
    expect(chip({ dueAt: at('2026-10-30T09:00:00') })).toEqual({ text: '明天', tone: 'soon' })
    expect(chip({ dueAt: at('2026-11-01T09:00:00') })).toEqual({ text: '3 天后', tone: 'soon' })
    expect(chip({ dueAt: at('2026-11-20T09:00:00') })).toEqual({ text: '22 天后', tone: 'later' })
  })

  it('逾期说几天，当天过期说今天到期', () => {
    expect(chip({ dueAt: at('2026-10-27T09:00:00') })).toEqual({ text: '逾期 2 天', tone: 'overdue' })
    expect(chip({ dueAt: at('2026-10-29T07:30:00') })).toEqual({ text: '今天到期', tone: 'overdue' })
  })

  it('一次性任务做完、没有时间各有各的说法', () => {
    expect(chip({ kind: 0, enabled: false, dueAt: at('2026-10-20T09:00:00') })).toEqual({
      text: '已完成',
      tone: 'done'
    })
    expect(chip({ dueAt: undefined })).toEqual({ text: '没有时间', tone: 'none' })
  })

  it('不会出现「逾期 0 天」这种写法', () => {
    expect(chip({ dueAt: at('2026-10-29T07:59:00') }).text).toBe('今天到期')
  })
})

describe('isFinished（什么时候算彻底做完）', () => {
  it('一次性：做完（enabled = false）就算完', () => {
    expect(isFinished({ kind: 0, enabled: true }, 0)).toBe(false)
    expect(isFinished({ kind: 0, enabled: false }, 1)).toBe(true)
  })

  it('周期：永远不算完，关提醒只是关提醒', () => {
    expect(isFinished({ kind: 1, enabled: false }, 99)).toBe(false)
  })

  it('限次：做够次数才算完', () => {
    expect(isFinished({ kind: 2, enabled: true, limitCount: 5 }, 4)).toBe(false)
    expect(isFinished({ kind: 2, enabled: false, limitCount: 5 }, 5)).toBe(true)
  })

  it('限次：手动关掉提醒但没做够，不算完', () => {
    expect(isFinished({ kind: 2, enabled: false, limitCount: 5 }, 2)).toBe(false)
  })

  it('限次没填次数时按 1 次算，不会变成无限', () => {
    expect(isFinished({ kind: 2, enabled: true }, 1)).toBe(true)
  })

  it('手动「完成任务」之后一律算结束，周期任务也是', () => {
    expect(isFinished({ kind: 1, enabled: false, closedAt: 1 }, 0)).toBe(true)
    expect(isFinished({ kind: 2, enabled: true, limitCount: 5, closedAt: 1 }, 2)).toBe(true)
    expect(isFinished({ kind: 0, enabled: true, closedAt: 1 }, 0)).toBe(true)
  })
})
