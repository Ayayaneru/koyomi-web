import type { DayItem } from '../../core/contracts'
import type { EventRow } from '../../core/db'
import { addDays, diffDays, mondayOf } from '../../core/time'

/**
 * 重复展开。纯函数，必须可测。
 * 单双周以 startAt 所在周的周一为基准算「第几周」，不用 ISO 周数 —— 跨年会跳变。
 */
export function eventOccurrences(ev: EventRow, from: number, to: number): number[] {
  const starts: number[] = []
  const duration = Math.max(0, ev.endAt - ev.startAt)
  const until = ev.repeatUntil != null ? Math.min(ev.repeatUntil, to) : to

  if (ev.repeatKind === 0) {
    if (ev.startAt < to && ev.startAt + duration > from) starts.push(ev.startAt)
    return starts
  }

  const step = ev.repeatKind === 1 ? 1 : ev.repeatKind === 2 ? 7 : Math.max(1, ev.repeatEveryN ?? 1)
  const baseMonday = mondayOf(ev.startAt)

  let index = 0
  if (ev.startAt < from - duration) {
    index = Math.max(0, Math.floor(diffDays(from - duration, ev.startAt) / step))
  }

  let guard = 0
  while (guard++ < 5000) {
    const at = addDays(ev.startAt, index * step)
    if (at > until) break
    index++
    if (at + duration <= from) continue
    if (ev.repeatKind === 2 && ev.weekParity !== 0) {
      const weeks = Math.floor(diffDays(at, baseMonday) / 7) + 1
      const odd = weeks % 2 === 1
      if (ev.weekParity === 1 && !odd) continue
      if (ev.weekParity === 2 && odd) continue
    }
    starts.push(at)
  }
  return starts
}

export function expandEvents(events: EventRow[], rangeStart: number, rangeEnd: number): DayItem[] {
  const out: DayItem[] = []
  for (const ev of events) {
    if (ev.repeatKind === 0 && ev.startAt >= rangeEnd) continue
    const duration = Math.max(0, ev.endAt - ev.startAt)
    for (const at of eventOccurrences(ev, rangeStart, rangeEnd)) {
      out.push({
        kind: 'event',
        id: `${ev.id}@${at}`,
        at,
        endAt: at + duration,
        title: ev.title,
        icon: undefined
      })
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

/** 某个时间点之后最近的一次出现（通知只排最近一次） */
export function nextOccurrence(ev: EventRow, after: number): number | null {
  const horizon = after + 400 * 86_400_000
  const list = eventOccurrences(ev, after + 1, horizon)
  return list.length ? list[0] : null
}
