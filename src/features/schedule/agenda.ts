import { db, type DiaryRow, type EventRow, type TaskLogRow } from '../../core/db'
import { addDays, dayStart } from '../../core/time'
import { expandEvents } from './expand'

/** 日程里能出现的三类东西：日程事件、做过的任务、写过的日记 */
export type AgendaKind = 'event' | 'task' | 'diary'

export interface AgendaItem {
  /** 列表键：事件带实例后缀（重复日程一天一条），任务/日记用自己的 id */
  id: string
  kind: AgendaKind
  /** 点开时要找的原始记录 id（事件是 EventRow.id，任务是 TaskRow.id，日记是自己） */
  rowId: string
  title: string
  at: number
  /** 只有事件有结束时间；任务和日记是「点」，endAt 等于 at */
  endAt: number
  icon?: string
}

export interface AgendaSource {
  events: EventRow[]
  logs: TaskLogRow[]
  diaries: DiaryRow[]
}

/**
 * 一次把三段数据取回来。三张表都在同一个 liveQuery 里读，
 * 所以做完任务、写完日记，日程页会自己刷新。
 */
export async function loadAgenda(from: number, to: number): Promise<AgendaSource> {
  const [events, logs, diaries] = await Promise.all([
    // 凌晨 0–3 点的条目会被挪到前一天 22:00，所以事件和完成记录两头也要多取一天
    db.events.where('startAt').below(addDays(to, 1)).toArray(),
    db.taskLogs.where('doneAt').between(addDays(from, -1), to, true, false).toArray(),
    // 日记的 date 是「归属哪一天」的零点，写它的时刻在 createdAt 里。
    // 凌晨写的会被挪到前一天 22:00，所以两头各多取一天，免得卡在视野边界上丢数据。
    db.diary.where('date').between(addDays(from, -1), addDays(to, 1), true, false).toArray()
  ])
  return { events, logs, diaries }
}

/**
 * 凌晨 0–3 点产生的条目算**前一天**的，落在那天最后一格（22:00）。
 *
 * 2026-11-02：原来只有日记按这个规则，事件和完成记录还是按自然日 ——
 * 凌晨 1 点开的会、做完的事会跑到当天第一格（08:00），和日记差一天。
 * 现在三种都用它，只挪这一种情况；3–8 点、23 点后的夹取交给格子自己做。
 */
export function placeTime(ts: number): number {
  const hour = new Date(ts).getHours()
  if (hour >= 3) return ts
  return addDays(dayStart(ts), -1) + 22 * 3_600_000
}

/**
 * 日记落在哪个格子。「一天」从凌晨 3 点算起：
 * - 0:00–2:59 写的算前一天，落在那天最后一个格子（22:00）—— 熬夜写的还是昨晚的事
 * - 3:00–7:59 落在当天第一个格子（08:00）
 * - 8:00–22:59 照原样
 * - 23:00 以后落在当天最后一个格子（22:00）
 * 日期用日记归属的那天，时分用写它的时刻：补写昨天的日记不会跑到今天。
 */
export function diaryAt(row: DiaryRow): number {
  const written = new Date(row.createdAt)
  const hour = written.getHours()
  const base = dayStart(row.date)

  if (hour < 3) return addDays(base, -1) + 22 * 3_600_000
  if (hour < 8) return base + 8 * 3_600_000
  if (hour >= 23) return base + 22 * 3_600_000
  return base + hour * 3_600_000 + written.getMinutes() * 60_000
}

/** 把三段数据摊平成一条按时间排好的列表 */
export function agendaInRange(
  src: AgendaSource | undefined,
  from: number,
  to: number
): AgendaItem[] {
  if (!src) return []
  const out: AgendaItem[] = []

  // 窗口两头各放宽一天：凌晨的条目挪到前一天之后，可能会落到 [from, to) 之外
  for (const item of expandEvents(src.events, addDays(from, -1), addDays(to, 1))) {
    const at = placeTime(item.at)
    const endAt = Math.max(at, placeTime(item.endAt ?? item.at))
    const row = {
      id: item.id,
      kind: 'event' as const,
      rowId: item.id.split('@')[0],
      title: item.title,
      at,
      endAt
    }
    if (inRange(row, from, to)) out.push(row)
  }

  for (const log of src.logs) {
    const at = placeTime(log.doneAt)
    if (at < from || at >= to) continue
    out.push({
      id: log.id,
      kind: 'task',
      rowId: log.taskId,
      title: log.taskTitle,
      at,
      endAt: at,
      icon: log.taskIcon
    })
  }

  for (const row of src.diaries) {
    const at = diaryAt(row)
    if (at < from || at >= to) continue
    out.push({
      id: row.id,
      kind: 'diary',
      rowId: row.id,
      title: row.title,
      at,
      endAt: at,
      icon: row.mood
    })
  }

  return out.sort((a, b) => a.at - b.at || a.title.localeCompare(b.title))
}

/** 这条东西在不在 [from, to) 里：事件看是否重叠，任务/日记看落点 */
export function inRange(item: AgendaItem, from: number, to: number): boolean {
  if (item.kind === 'event') return item.at < to && (item.endAt > from || item.at >= from)
  return item.at >= from && item.at < to
}

/* ---------- 周表分格（08:00 开始，两小时一格，到 22:00 共 7 格） ---------- */

export const SLOT_START_HOUR = 8
export const SLOT_HOURS = 2
export const SLOT_COUNT = 7
export const SLOT_MS = SLOT_HOURS * 3_600_000

/**
 * 某个时间点落在第几格。8 点前算第一格、22 点后算最后一格 ——
 * 只对「当天的时刻」有意义，跨天的要先按天裁掉（见 slotItemsIn）。
 */
export function slotIndexOf(ts: number, dayTs: number): number {
  const from = dayTs + SLOT_START_HOUR * 3_600_000
  const to = dayTs + (SLOT_START_HOUR + SLOT_COUNT * SLOT_HOURS) * 3_600_000
  if (ts < from) return 0
  if (ts >= to) return SLOT_COUNT - 1
  return Math.min(SLOT_COUNT - 1, Math.max(0, Math.floor((ts - from) / SLOT_MS)))
}

/**
 * 周视图一格里的东西（面板和格子共用同一套，保证点哪个格子、下面列的就是哪些）。
 * - 日程看「跨没跨这个时段」：09:00–12:00 的会在 08–10 和 10–12 两格里都出现；
 * - 任务 / 日记是个时间点，只落在按格子对齐的那一格（8 点前算第一格、22 点后算最后一格）。
 */
export function slotItemsIn(items: AgendaItem[], dayTs: number, slot: number): AgendaItem[] {
  const from = dayTs + (SLOT_START_HOUR + slot * SLOT_HOURS) * 3_600_000
  const to = from + SLOT_HOURS * 3_600_000
  const hit = items.filter(item => {
    // 先按天裁一遍，别的日子（以及跨夜的另一半）不会漏进来
    if (!inRange(item, dayTs, addDays(dayTs, 1))) return false
    if (item.kind === 'event') return item.at < to && item.endAt > from
    return slotIndexOf(item.at, dayTs) === slot
  })
  // 这一格里「刚开始」的排前面，上一格跨进来的排后面 —— 否则跨格事件会把本格新事件挤掉
  return hit.sort((a, b) => {
    const sa = a.kind === 'event' && a.at < from ? 1 : 0
    const sb = b.kind === 'event' && b.at < from ? 1 : 0
    return sa - sb || a.at - b.at
  })
}
