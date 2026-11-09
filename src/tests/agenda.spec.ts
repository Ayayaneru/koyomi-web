import { describe, expect, it } from 'vitest'
import { dayStart } from '../core/time'
import type { DiaryRow, EventRow, TaskLogRow } from '../core/db'
import {
  agendaInRange,
  diaryAt,
  inRange,
  slotIndexOf,
  slotItemsIn,
  type AgendaSource
} from '../features/schedule/agenda'

const day = (text: string) => dayStart(new Date(`${text}T12:00:00`).getTime())
const hhmm = (date: string, h: number, m = 0) => day(date) + h * 3_600_000 + m * 60_000

function makeEvent(over: Partial<EventRow> = {}): EventRow {
  return {
    id: 'ev1',
    title: '评审',
    startAt: hhmm('2026-10-28', 9),
    endAt: hhmm('2026-10-28', 10),
    repeatKind: 0,
    weekParity: 0,
    source: 0,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    ...over
  }
}

function makeLog(over: Partial<TaskLogRow> = {}): TaskLogRow {
  return {
    id: 'lg1',
    taskId: 'tk1',
    taskTitle: '喂鱼',
    doneAt: hhmm('2026-10-28', 8, 5),
    source: 0,
    ...over
  }
}

function makeDiary(over: Partial<DiaryRow> = {}): DiaryRow {
  return {
    id: 'dy1',
    date: day('2026-10-28'),
    title: '今天',
    content: '',
    createdAt: hhmm('2026-10-28', 21, 30),
    updatedAt: hhmm('2026-10-28', 21, 30),
    ...over
  }
}

const src = (over: Partial<AgendaSource> = {}): AgendaSource => ({
  events: [],
  logs: [],
  diaries: [],
  ...over
})

describe('日记落在哪一刻', () => {
  it('用「写它的那个整点」', () => {
    expect(diaryAt(makeDiary())).toBe(hhmm('2026-10-28', 21, 30))
  })

  it('补写昨天的日记，落在昨天那个时间点，不跑到今天', () => {
    const row = makeDiary({ date: day('2026-10-26'), createdAt: hhmm('2026-10-27', 9, 10) })
    expect(diaryAt(row)).toBe(hhmm('2026-10-26', 9, 10))
  })

  it('凌晨 3 点前写的算前一天，落在 22:00 那一格', () => {
    expect(diaryAt(makeDiary({ createdAt: hhmm('2026-10-28', 1, 30) }))).toBe(hhmm('2026-10-27', 22))
    expect(diaryAt(makeDiary({ createdAt: hhmm('2026-10-28', 2, 59) }))).toBe(hhmm('2026-10-27', 22))
  })

  it('3 点到 8 点写的落在当天第一格 08:00', () => {
    expect(diaryAt(makeDiary({ createdAt: hhmm('2026-10-28', 3, 0) }))).toBe(hhmm('2026-10-28', 8))
    expect(diaryAt(makeDiary({ createdAt: hhmm('2026-10-28', 7, 45) }))).toBe(hhmm('2026-10-28', 8))
  })

  it('22:00 以后写的落在当天最后一格 22:00', () => {
    expect(diaryAt(makeDiary({ createdAt: hhmm('2026-10-28', 23, 20) }))).toBe(hhmm('2026-10-28', 22))
    expect(diaryAt(makeDiary({ createdAt: hhmm('2026-10-28', 23, 59) }))).toBe(hhmm('2026-10-28', 22))
  })

  it('白天的照原样，22 点这一小时内也不动', () => {
    expect(diaryAt(makeDiary({ createdAt: hhmm('2026-10-28', 12, 5) }))).toBe(hhmm('2026-10-28', 12, 5))
    expect(diaryAt(makeDiary({ createdAt: hhmm('2026-10-28', 22, 30) }))).toBe(hhmm('2026-10-28', 22, 30))
  })
})

describe('日程 / 任务 / 日记合并', () => {
  it('三类混在一起按时间排', () => {
    const list = agendaInRange(
      src({ events: [makeEvent()], logs: [makeLog()], diaries: [makeDiary()] }),
      day('2026-10-27'),
      day('2026-10-29')
    )
    expect(list.map(i => i.kind)).toEqual(['task', 'event', 'diary'])
    expect(list.map(i => i.title)).toEqual(['喂鱼', '评审', '今天'])
  })

  it('范围外的任务和日记不进来', () => {
    const list = agendaInRange(
      src({
        logs: [makeLog({ doneAt: hhmm('2026-10-20', 8) })],
        diaries: [makeDiary({ date: day('2026-10-20'), createdAt: hhmm('2026-10-20', 21) })]
      }),
      day('2026-10-28'),
      day('2026-10-29')
    )
    expect(list).toHaveLength(0)
  })

  it('重复日程按天展开，每条带实例后缀', () => {
    const event = makeEvent({
      startAt: hhmm('2026-10-26', 9),
      endAt: hhmm('2026-10-26', 10),
      repeatKind: 1
    })
    const list = agendaInRange(src({ events: [event] }), day('2026-10-26'), day('2026-10-29'))
    expect(list).toHaveLength(3)
    expect(new Set(list.map(i => i.id)).size).toBe(3)
    expect(list.map(i => i.rowId)).toEqual(['ev1', 'ev1', 'ev1'])
  })

  it('没有数据源时返回空数组（首帧还没读出来）', () => {
    expect(agendaInRange(undefined, 0, 1)).toEqual([])
  })

  it('任务的图标带过来（面板里显示 emoji）', () => {
    const list = agendaInRange(
      src({ logs: [makeLog({ taskIcon: '🐟' })] }),
      day('2026-10-28'),
      day('2026-10-29')
    )
    expect(list[0].icon).toBe('🐟')
  })
})

describe('inRange', () => {
  it('跨零点的日程两天都算', () => {
    const item = {
      id: 'e',
      kind: 'event' as const,
      rowId: 'e',
      title: '跨夜',
      at: hhmm('2026-10-28', 23),
      endAt: hhmm('2026-10-29', 1),
      icon: undefined
    }
    expect(inRange(item, day('2026-10-28'), day('2026-10-29'))).toBe(true)
    expect(inRange(item, day('2026-10-29'), day('2026-10-30'))).toBe(true)
    expect(inRange(item, day('2026-10-27'), day('2026-10-28'))).toBe(false)
  })

  it('任务和日记只认落点，不认「跨了几个小时」', () => {
    const list = agendaInRange(
      src({ logs: [makeLog({ doneAt: hhmm('2026-10-28', 10, 55) })] }),
      hhmm('2026-10-28', 11),
      hhmm('2026-10-28', 12)
    )
    expect(list).toHaveLength(0)
  })
})

describe('凌晨 0–3 点：事件和完成记录也算前一天', () => {
  const late = day('2026-11-03')
  const prev = day('2026-11-02')
  const night = hhmm('2026-11-02', 22)

  it('01:00 的事件落在前一天 22:00，不出现在当天', () => {
    const source = src({
      events: [makeEvent({ startAt: hhmm('2026-11-03', 1), endAt: hhmm('2026-11-03', 2) })]
    })
    const before = agendaInRange(source, prev, late)
    expect(before).toHaveLength(1)
    expect(before[0].at).toBe(night)
    expect(agendaInRange(source, late, day('2026-11-04'))).toHaveLength(0)
  })

  it('00:40 做完的任务也落在前一天 22:00', () => {
    const source = src({ logs: [makeLog({ doneAt: hhmm('2026-11-03', 0, 40) })] })
    const before = agendaInRange(source, prev, late)
    expect(before).toHaveLength(1)
    expect(before[0].at).toBe(night)
    expect(agendaInRange(source, late, day('2026-11-04'))).toHaveLength(0)
  })

  it('03:00 是分界线：正好 3 点不挪', () => {
    const source = src({ events: [makeEvent({ startAt: hhmm('2026-11-03', 3), endAt: hhmm('2026-11-03', 4) })] })
    expect(agendaInRange(source, prev, late)).toHaveLength(0)
    expect(agendaInRange(source, late, day('2026-11-04'))[0].at).toBe(hhmm('2026-11-03', 3))
  })

  it('23:30 的事件不挪，还是当天（格子自己会夹到最后一格）', () => {
    const source = src({ events: [makeEvent({ startAt: hhmm('2026-11-02', 23, 30), endAt: hhmm('2026-11-03', 0, 30) })] })
    const row = agendaInRange(source, prev, late)
    expect(row).toHaveLength(1)
    expect(row[0].at).toBe(hhmm('2026-11-02', 23, 30))
  })
})

describe('凌晨写的日记算进前一天', () => {
  it('查前一天的列表能看到它，查当天看不到', () => {
    const row = makeDiary({ createdAt: hhmm('2026-10-28', 1, 20) })
    const prev = agendaInRange(src({ diaries: [row] }), day('2026-10-27'), day('2026-10-28'))
    const same = agendaInRange(src({ diaries: [row] }), day('2026-10-28'), day('2026-10-29'))

    expect(prev.map(i => i.title)).toEqual(['今天'])
    expect(same).toHaveLength(0)
  })
})

describe('周表面板：这一格里有哪几件', () => {
  const mon = day('2026-11-02')
  const week = agendaInRange(
    src({
      events: [
        makeEvent({ id: 'mon', startAt: hhmm('2026-11-02', 20), endAt: hhmm('2026-11-02', 21) }),
        makeEvent({ id: 'wed', startAt: hhmm('2026-11-04', 20), endAt: hhmm('2026-11-04', 21) })
      ],
      logs: [
        makeLog({ id: 'early', doneAt: hhmm('2026-11-02', 7, 30) }),
        makeLog({ id: 'late', doneAt: hhmm('2026-11-02', 23, 10) })
      ]
    }),
    day('2026-11-01'),
    day('2026-11-08')
  )

  it('点周一 20:00：只有周一的（23:10 那条也算最后一格），不会把周三的并进来', () => {
    expect(slotItemsIn(week, mon, 6).map(i => i.id.split('@')[0])).toEqual(['mon', 'late'])
    expect(slotItemsIn(week, mon, 6).map(i => i.id)).not.toContain('wed')
  })

  it('换到周三那一格，看到的是周三的', () => {
    expect(slotItemsIn(week, day('2026-11-04'), 6).map(i => i.id.split('@')[0])).toEqual(['wed'])
  })

  it('8 点前算第一格、22 点后算最后一格', () => {
    expect(slotIndexOf(hhmm('2026-11-02', 7, 30), mon)).toBe(0)
    expect(slotIndexOf(hhmm('2026-11-02', 23, 10), mon)).toBe(6)
    expect(slotIndexOf(hhmm('2026-11-02', 9, 59), mon)).toBe(0)
    expect(slotIndexOf(hhmm('2026-11-02', 10, 0), mon)).toBe(1)
    expect(slotItemsIn(week, mon, 0).map(i => i.id)).toEqual(['early'])
    expect(slotItemsIn(week, mon, 6).map(i => i.id.split('@')[0])).toEqual(['mon', 'late'])
  })

  it('空格子就是空的', () => {
    expect(slotItemsIn(week, mon, 3)).toEqual([])
  })
})

describe('周表：跨格的事件', () => {
  const mon = day('2026-11-02')
  const ids = (list: { id: string }[]) => list.map(i => i.id.split('@')[0])

  const week = agendaInRange(
    src({
      events: [
        makeEvent({ id: 'long', startAt: hhmm('2026-11-02', 9), endAt: hhmm('2026-11-02', 12) }),
        makeEvent({ id: 'mid', startAt: hhmm('2026-11-02', 10), endAt: hhmm('2026-11-02', 12) })
      ]
    }),
    day('2026-11-01'),
    day('2026-11-08')
  )

  it('09:00–12:00 在 08–10 和 10–12 两格里都出现，之后就没有了', () => {
    expect(ids(slotItemsIn(week, mon, 0))).toEqual(['long'])
    expect(ids(slotItemsIn(week, mon, 1)).includes('long')).toBe(true)
    expect(ids(slotItemsIn(week, mon, 2))).toEqual([])
  })

  it('第二格里「刚开始」的 10:00 排在跨进来的 09:00 前面（否则会被挤掉）', () => {
    expect(ids(slotItemsIn(week, mon, 1))).toEqual(['mid', 'long'])
  })

  it('跨两格的事件不会把后面格子里的事件藏掉', () => {
    const later = agendaInRange(
      src({
        events: [
          makeEvent({ id: 'a', startAt: hhmm('2026-11-02', 9), endAt: hhmm('2026-11-02', 12) }),
          makeEvent({ id: 'b', startAt: hhmm('2026-11-02', 9), endAt: hhmm('2026-11-02', 12) }),
          makeEvent({ id: 'c', startAt: hhmm('2026-11-02', 10), endAt: hhmm('2026-11-02', 11) })
        ]
      }),
      day('2026-11-01'),
      day('2026-11-08')
    )
    // 格子里只画前两条（面板拿全部）：第二格 10:00 那条排第一，再跟一条跨格的
    expect(ids(slotItemsIn(later, mon, 0)).slice(0, 2)).toEqual(['a', 'b'])
    expect(ids(slotItemsIn(later, mon, 1)).slice(0, 2)).toEqual(['c', 'a'])
    // 三条都在，只是格子里画不下第三条
    expect(ids(slotItemsIn(later, mon, 1))).toEqual(['c', 'a', 'b'])
  })

  it('跨格事件可以只按格子单独选中（面板拿到的就是这一格）', () => {
    expect(ids(slotItemsIn(week, mon, 1))).not.toEqual(ids(slotItemsIn(week, mon, 0)))
  })
})
