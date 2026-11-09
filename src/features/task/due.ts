import type { DayItem } from '../../core/contracts'
import { db, type TaskLogRow, type TaskRow } from '../../core/db'
import { dayStart } from '../../core/time'

/* ============ 纯函数（必须可测） ============ */

/**
 * 下一次到期：先把时间对齐到 anchorTimeOfDay，再加天数。
 * 顺序反了就会永远差一天，所以这两步的次序不能调。
 */
export function nextDueAt(from: number, days: number, anchor?: string): number {
  const d = new Date(from)
  if (anchor) {
    const [h, m] = anchor.split(':').map(Number)
    d.setHours(h || 0, m || 0, 0, 0)
  }
  d.setDate(d.getDate() + Math.max(1, Math.round(days)))
  return d.getTime()
}

/** 新建任务时的第一次到期：今天到点还没过就用今天，过了就明天 */
export function firstDueAt(from: number, anchor = '09:00'): number {
  const [h, m] = anchor.split(':').map(Number)
  const d = new Date(from)
  d.setHours(h || 0, m || 0, 0, 0)
  if (d.getTime() <= from) d.setDate(d.getDate() + 1)
  return d.getTime()
}

export interface DueNotice {
  taskId: string
  title: string
  icon: string
  overdueDays: number
}

/** 周期任务与一次性任务同等对待，判断依据是 dueAt 而不是 kind */
export function checkDue(tasks: TaskRow[], now: number): DueNotice[] {
  return tasks
    .filter(t => t.enabled && t.dueAt != null && t.dueAt <= now)
    .map(t => ({
      taskId: t.id,
      title: t.title,
      icon: t.icon || Array.from(t.title)[0] || '·',
      overdueDays: Math.floor((now - (t.dueAt as number)) / 86_400_000)
    }))
    .sort((a, b) => b.overdueDays - a.overdueDays)
}

/** 时间轴上属于「待办」的那一段 */
export async function dueTasksIn(start: number, end: number): Promise<DayItem[]> {
  const rows = await db.tasks.where('dueAt').between(start, end, true, false).toArray()
  return rows
    .filter(t => t.enabled)
    .map(t => ({
      kind: 'task' as const,
      id: t.id,
      at: t.dueAt as number,
      title: t.title,
      icon: t.icon || Array.from(t.title)[0]
    }))
}

/** 时间轴上属于「已完成」的那一段 */
export async function logsIn(start: number, end: number): Promise<DayItem[]> {
  const rows = await db.taskLogs.where('doneAt').between(start, end, true, false).toArray()
  return rows.map((l: TaskLogRow) => ({
    kind: 'log' as const,
    id: l.id,
    at: l.doneAt,
    title: l.taskTitle,
    icon: l.taskIcon || Array.from(l.taskTitle)[0],
    source: l.source,
    done: true
  }))
}

export type DueTone = 'overdue' | 'soon' | 'later' | 'done' | 'none'

export interface DueChip {
  text: string
  tone: DueTone
}

/**
 * 任务右边那个小标签：只说「几天后」，不报具体日期 ——
 * 用户关心的是「还差几天」，不是「哪天几点」。
 * 按自然日算（今天/明天/N 天后），比拿毫秒差整除更符合直觉。
 */
export function dueChip(
  task: Pick<TaskRow, 'kind' | 'enabled' | 'dueAt'>,
  now: number
): DueChip {
  if (task.kind === 0 && !task.enabled) return { text: '已完成', tone: 'done' }
  if (task.dueAt == null) return { text: '没有时间', tone: 'none' }

  const days = Math.round((dayStart(task.dueAt) - dayStart(now)) / 86_400_000)
  if (task.dueAt <= now) {
    return days < 0
      ? { text: `逾期 ${-days} 天`, tone: 'overdue' }
      : { text: '今天到期', tone: 'overdue' }
  }
  if (days <= 0) return { text: '今天', tone: 'soon' }
  if (days === 1) return { text: '明天', tone: 'soon' }
  return { text: `${days} 天后`, tone: days <= 3 ? 'soon' : 'later' }
}

/**
 * 这个任务算不算「彻底做完了」：
 * 一次性做完就完；限次做够次数就完；周期任务永远不算完（关提醒只是关提醒）。
 * 限次看完成记录数，不看 enabled —— 手动关提醒不该让任务看起来像做完了。
 */
export function isFinished(
  task: Pick<TaskRow, 'kind' | 'enabled' | 'limitCount' | 'closedAt'>,
  doneCount: number
): boolean {
  if (task.closedAt != null) return true
  if (task.kind === 0) return !task.enabled
  if (task.kind === 2) return doneCount >= Math.max(1, task.limitCount ?? 1)
  return false
}
