import type { AppTool, ToolResult } from '../../core/contracts'
import { ConflictError, db, updateVersioned, type EventRow } from '../../core/db'
import { newId } from '../../core/crypto'
import { addMonths, fmtDateTime, parseLocal } from '../../core/time'
import { expandEvents } from './expand'

type Args = Record<string, unknown>

function text(args: Args, key: string): string | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  const s = String(v).trim()
  return s === '' ? undefined : s
}

function int(args: Args, key: string): number | undefined {
  const v = args[key]
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : undefined
}

function dateOf(args: Args, key: string): number | undefined {
  const v = text(args, key)
  if (!v) return undefined
  try {
    return parseLocal(v)
  } catch (error) {
    throw new Error(`${key} ${error instanceof Error ? error.message : ''}`)
  }
}

function clampTitle(title: string): string {
  return title.length > 120 ? title.slice(0, 120) : title
}

/** 提醒不在这里排：reminders.ts 挂在 events 表的写钩子上统一重排（提前 5 分钟） */

export async function createEvent(args: Args): Promise<ToolResult> {
  const title = text(args, 'title')
  if (!title) return { ok: false, message: 'title 不能为空' }
  const startAt = dateOf(args, 'startAt')
  if (startAt === undefined) return { ok: false, message: 'startAt 不能为空，格式 "2026-10-28 14:00"' }
  const endAt = dateOf(args, 'endAt') ?? startAt + 60 * 60_000
  if (endAt <= startAt) return { ok: false, message: 'endAt 必须晚于 startAt' }

  const repeatKind = Math.min(3, Math.max(0, int(args, 'repeatKind') ?? 0)) as EventRow['repeatKind']
  const weekParity = Math.min(2, Math.max(0, int(args, 'weekParity') ?? 0)) as EventRow['weekParity']
  const repeatEveryN = int(args, 'repeatEveryN')
  if (repeatKind === 3 && !repeatEveryN) return { ok: false, message: 'repeatKind = 3（每 N 天）时必须给 repeatEveryN' }

  const now = Date.now()
  const row: EventRow = {
    id: newId('ev'),
    title: clampTitle(title),
    location: text(args, 'location'),
    note: text(args, 'note'),
    startAt,
    endAt,
    repeatKind,
    repeatEveryN: repeatKind === 3 ? repeatEveryN : undefined,
    weekParity,
    // 重复日程默认管 3 个月，避免「设了每周就一直重复到天荒地老」
    repeatUntil: dateOf(args, 'repeatUntil') ?? (repeatKind !== 0 ? addMonths(startAt, 3) : undefined),
    source: 0,
    version: 1,
    extJson: null,
    createdAt: now,
    updatedAt: now
  }
  await db.events.add(row)
  return { ok: true, data: row, message: `已创建日程「${row.title}」${fmtDateTime(row.startAt)}` }
}

export async function updateEvent(args: Args): Promise<ToolResult> {
  const id = text(args, 'id')
  if (!id) return { ok: false, message: 'id 不能为空' }
  const current = await db.events.get(id)
  if (!current) return { ok: false, message: '找不到这条日程，可能已被删除' }

  const patch: Partial<EventRow> = {}
  const title = text(args, 'title')
  if (title) patch.title = clampTitle(title)
  const location = text(args, 'location')
  if (location !== undefined) patch.location = location
  const note = text(args, 'note')
  if (note !== undefined) patch.note = note

  const startAt = dateOf(args, 'startAt')
  if (startAt !== undefined) patch.startAt = startAt
  const endAt = dateOf(args, 'endAt')
  if (endAt !== undefined) patch.endAt = endAt
  if (patch.startAt !== undefined && patch.endAt === undefined) {
    const duration = current.endAt - current.startAt
    patch.endAt = patch.startAt + duration
  }
  if (patch.endAt !== undefined && patch.endAt <= (patch.startAt ?? current.startAt)) {
    return { ok: false, message: 'endAt 必须晚于 startAt' }
  }

  const repeatKind = int(args, 'repeatKind')
  if (repeatKind !== undefined) patch.repeatKind = Math.min(3, Math.max(0, repeatKind)) as EventRow['repeatKind']
  const weekParity = int(args, 'weekParity')
  if (weekParity !== undefined) patch.weekParity = Math.min(2, Math.max(0, weekParity)) as EventRow['weekParity']
  const repeatEveryN = int(args, 'repeatEveryN')
  if (repeatEveryN !== undefined) patch.repeatEveryN = repeatEveryN
  const repeatUntil = dateOf(args, 'repeatUntil')
  if (repeatUntil !== undefined) patch.repeatUntil = repeatUntil

  const expected = int(args, 'version') ?? current.version
  try {
    await updateVersioned(db.events, id, expected, patch)
  } catch (error) {
    if (error instanceof ConflictError) {
      const latest = await db.events.get(id)
      return { ok: false, message: `这条日程刚被改过，请以最新内容为准：${JSON.stringify(latest)}` }
    }
    throw error
  }
  const updated = await db.events.get(id)
  return { ok: true, data: updated, message: `已更新日程「${updated?.title ?? ''}」` }
}

export async function queryEvents(args: Args): Promise<ToolResult> {
  const from = dateOf(args, 'from') ?? Date.now() - 86_400_000
  const to = dateOf(args, 'to') ?? from + 7 * 86_400_000
  const limit = Math.min(50, Math.max(1, int(args, 'limit') ?? 20))
  const rows = await db.events.where('startAt').below(to + 86_400_000).toArray()
  const items = expandEvents(rows, from, to)
    .slice(0, limit)
    .map(item => {
      const row = rows.find(r => item.id.startsWith(`${r.id}@`))
      return {
        id: row?.id ?? item.id,
        title: item.title,
        start: fmtDateTime(item.at),
        end: item.endAt ? fmtDateTime(item.endAt) : undefined,
        location: row?.location,
        repeatKind: row?.repeatKind
      }
    })
  return { ok: true, data: items, message: items.length ? `共 ${items.length} 条` : '这段时间没有日程' }
}

export async function deleteEvent(args: Args): Promise<ToolResult> {
  const id = text(args, 'id')
  if (!id) return { ok: false, message: 'id 不能为空' }
  const row = await db.events.get(id)
  if (!row) return { ok: false, message: '找不到这条日程' }
  await db.events.delete(id)
  return { ok: true, data: { id }, message: `已删除日程「${row.title}」` }
}

const repeatKindProp = {
  type: 'integer' as const,
  title: '重复方式',
  description: '重复方式：0 不重复 / 1 每天 / 2 每周 / 3 每 N 天',
  enum: [0, 1, 2, 3],
  enumNames: ['不重复', '每天', '每周', '每 N 天'],
  default: 0
}

const weekParityProp = {
  type: 'integer' as const,
  title: '单双周',
  description: '每周重复时的单双周：0 每周 / 1 单周 / 2 双周',
  enum: [0, 1, 2],
  enumNames: ['每周', '单周', '双周'],
  default: 0
}

export const scheduleCreateEvent: AppTool = {
  name: 'schedule_create_event',
  moduleId: 'schedule',
  description: '创建一条日程或课程。时间用本地时间字符串，例如 "2026-10-28 14:00"。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', title: '日程标题', description: '日程标题' },
      startAt: {
        type: 'string',
        title: '开始时间',
        format: 'date-time',
        description: '格式 "2026-10-28 14:00"'
      },
      endAt: { type: 'string', title: '结束时间', format: 'date-time', description: '不填默认一小时后' },
      location: { type: 'string', title: '地点', description: '地点' },
      note: { type: 'string', title: '备注', format: 'textarea', description: '备注' },
      repeatKind: repeatKindProp,
      repeatEveryN: { type: 'integer', title: '每几天', description: 'repeatKind = 3 时生效，每 N 天一次', minimum: 1 },
      weekParity: weekParityProp,
      repeatUntil: {
        type: 'string',
        title: '重复到哪天',
        format: 'date-time',
        description: '重复截止日期；不填默认 3 个月'
      }
    },
    required: ['title', 'startAt']
  },
  execute: createEvent
}

export const scheduleUpdateEvent: AppTool = {
  name: 'schedule_update_event',
  moduleId: 'schedule',
  description: '修改已有日程。只传要改的字段。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', title: '日程 ID', description: '从 schedule_query_events 或当前上下文取' },
      title: { type: 'string', title: '日程标题' },
      startAt: { type: 'string', title: '开始时间', format: 'date-time' },
      endAt: { type: 'string', title: '结束时间', format: 'date-time' },
      location: { type: 'string', title: '地点' },
      note: { type: 'string', title: '备注', format: 'textarea' },
      repeatKind: repeatKindProp,
      repeatEveryN: { type: 'integer', title: '每几天', minimum: 1 },
      weekParity: weekParityProp,
      repeatUntil: { type: 'string', title: '重复到哪天', format: 'date-time' }
    },
    required: ['id']
  },
  execute: updateEvent
}

export const scheduleQueryEvents: AppTool = {
  name: 'schedule_query_events',
  moduleId: 'schedule',
  description: '按时间段查询日程，返回展开后的实例。',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', title: '从', format: 'date-time', description: '起始时间，默认昨天' },
      to: { type: 'string', title: '到', format: 'date-time', description: '结束时间，默认一周后' },
      limit: { type: 'integer', title: '最多几条', description: '最多返回条数', minimum: 1, maximum: 50, default: 20 }
    },
    required: ['limit']
  },
  execute: queryEvents
}

export const scheduleDeleteEvent: AppTool = {
  name: 'schedule_delete_event',
  moduleId: 'schedule',
  description: '删除一条日程。调用前必须先向用户确认。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', title: '日程 ID', description: '要删除的日程 id' }
    },
    required: ['id']
  },
  requireConfirm: true,
  execute: deleteEvent
}
