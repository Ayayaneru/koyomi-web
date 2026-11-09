import type { AppTool, ToolResult } from '../../core/contracts'
import { ConflictError, db, updateVersioned, type TaskLogRow, type TaskRow } from '../../core/db'
import { newId } from '../../core/crypto'
import { fmtDateTime, fmtTime, parseLocal, addDays } from '../../core/time'
import { cancelRemind, remindAt } from '../../core/notify'
import { firstDueAt, nextDueAt } from './due'

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

function singleIcon(value: unknown): string | undefined {
  const s = String(value ?? '').trim()
  if (!s) return undefined
  return Array.from(s)[0]
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

export async function createTask(args: Args): Promise<ToolResult> {
  const title = text(args, 'title')
  if (!title) return { ok: false, message: 'title 不能为空' }
  const kindRaw = int(args, 'kind') ?? 1
  const kind = (kindRaw === 0 ? 0 : kindRaw === 2 ? 2 : 1) as TaskRow['kind']
  const intervalDays = int(args, 'intervalDays')
  const limitCount = int(args, 'limitCount')
  const dueInput = dateOf(args, 'dueAt')
  if (kind === 1 && (!intervalDays || intervalDays < 1)) {
    return { ok: false, message: '周期任务要填 intervalDays（每几天）' }
  }
  if (kind === 0 && dueInput === undefined) {
    return { ok: false, message: '一次性任务要填 dueAt（到期时间）' }
  }
  if (kind === 2) {
    if (!intervalDays || intervalDays < 1) {
      return { ok: false, message: '限次任务要填 intervalDays（每几天）' }
    }
    if (!limitCount || limitCount < 1) {
      return { ok: false, message: '限次任务要填 limitCount（做几次）' }
    }
  }

  const now = Date.now()
  const anchor = dueInput ? fmtTime(dueInput) : '09:00'
  const dueAt = kind === 0 ? (dueInput as number) : dueInput && dueInput > now ? dueInput : firstDueAt(now, anchor)

  const row: TaskRow = {
    id: newId('tk'),
    title: title.length > 80 ? title.slice(0, 80) : title,
    icon: singleIcon(args.icon),
    note: text(args, 'note'),
    kind,
    intervalDays: kind === 0 ? undefined : intervalDays,
    limitCount: kind === 2 ? limitCount : undefined,
    dueAt,
    anchorTimeOfDay: anchor,
    enabled: true,
    version: 1,
    extJson: null,
    createdAt: now,
    updatedAt: now
  }
  await db.tasks.add(row)
  await remindAt(dueAt, '该做这件事了', `${row.icon ? `${row.icon} ` : ''}${row.title}`, `task:${row.id}`)
  return { ok: true, data: row, message: `已创建任务「${row.title}」，下次 ${fmtDateTime(dueAt)}` }
}

/** 完成一次：写日志 + 滚动 dueAt（一次性任务置 enabled = false） */
export async function completeTask(args: Args): Promise<ToolResult> {
  const id = text(args, 'taskId') ?? text(args, 'id')
  if (!id) return { ok: false, message: 'taskId 不能为空' }
  const task = await db.tasks.get(id)
  if (!task) return { ok: false, message: '找不到这个任务' }

  const now = Date.now()
  const source = (int(args, 'source') === 1 ? 1 : 0) as 0 | 1
  const log: TaskLogRow = {
    id: newId('lg'),
    taskId: task.id,
    taskTitle: task.title,
    taskIcon: task.icon,
    doneAt: now,
    prevDueAt: task.dueAt ?? undefined,
    note: text(args, 'note'),
    source,
    extJson: null
  }

  let nextAt: number | undefined
  let doneCount = 0
  const limit = Math.max(1, task.limitCount ?? 1)

  await db.transaction('rw', db.tasks, db.taskLogs, async () => {
    doneCount = (await db.taskLogs.where('taskId').equals(task.id).count()) + 1
    await db.taskLogs.add(log)
    if (task.kind === 0) {
      await db.tasks.update(task.id, { enabled: false, lastDoneAt: now, updatedAt: now })
    } else if (task.kind === 2 && doneCount >= limit) {
      // 限次任务：做够次数就收尾，不再排下一次
      await db.tasks.update(task.id, { enabled: false, lastDoneAt: now, updatedAt: now })
    } else {
      nextAt = nextDueAt(now, task.intervalDays ?? 1, task.anchorTimeOfDay)
      await db.tasks.update(task.id, { lastDoneAt: now, dueAt: nextAt, updatedAt: now })
    }
  })

  if (nextAt) await remindAt(nextAt, '该做这件事了', task.title, `task:${task.id}`)
  else await cancelRemind(`task:${task.id}`)

  const progress = task.kind === 2 ? `第 ${doneCount}/${limit} 次` : ''
  const message = nextAt
    ? `已完成「${task.title}」${progress}，下次 ${fmtDateTime(nextAt)}`
    : task.kind === 2
      ? `已完成「${task.title}」第 ${doneCount}/${limit} 次，这个任务结束了`
      : `已完成「${task.title}」`

  return {
    ok: true,
    data: { taskId: task.id, nextDueAt: nextAt, doneCount, limitCount: task.limitCount },
    message
  }
}

export async function listTasks(args: Args): Promise<ToolResult> {
  const limit = Math.min(50, Math.max(1, int(args, 'limit') ?? 20))
  const rows = await db.tasks.orderBy('dueAt').toArray()
  const items = rows
    .filter(t => t.enabled || t.kind === 0)
    .slice(0, limit)
    .map(t => ({
      id: t.id,
      title: t.title,
      icon: t.icon,
      kind: t.kind === 1 ? '周期' : t.kind === 2 ? '限次' : '一次性',
      intervalDays: t.intervalDays,
      limitCount: t.limitCount,
      dueAt: t.dueAt ? fmtDateTime(t.dueAt) : undefined,
      overdue: t.dueAt != null && t.dueAt <= Date.now(),
      enabled: t.enabled
    }))
  return { ok: true, data: items, message: items.length ? `共 ${items.length} 个任务` : '还没有任务' }
}

export async function queryLogs(args: Args): Promise<ToolResult> {
  const limit = Math.min(50, Math.max(1, int(args, 'limit') ?? 20))
  const from = dateOf(args, 'from') ?? Date.now() - 30 * 86_400_000
  const to = dateOf(args, 'to') ?? Date.now()
  const rows = await db.taskLogs.where('doneAt').between(from, to, true, true).reverse().limit(limit).toArray()
  const items = rows.map(l => ({
    title: l.taskTitle,
    icon: l.taskIcon,
    doneAt: fmtDateTime(l.doneAt),
    note: l.note,
    source: l.source === 1 ? '模型' : l.source === 2 ? '自动' : '手动'
  }))
  return { ok: true, data: items, message: items.length ? `共 ${items.length} 条记录` : '这段时间没有完成记录' }
}

/** 撤销一次「完成」：删掉那条记录，把任务的到期时间退回去（点错了用的） */
export async function undoTaskLog(log: TaskLogRow): Promise<void> {
  const task = await db.tasks.get(log.taskId)
  let restored: number | undefined
  let reopened = false

  await db.transaction('rw', db.tasks, db.taskLogs, async () => {
    await db.taskLogs.delete(log.id)
    if (!task) return
    if (task.kind === 0) {
      await db.tasks.update(task.id, { enabled: true, lastDoneAt: undefined, updatedAt: Date.now() })
      return
    }

    restored = log.prevDueAt ?? addDays(task.dueAt ?? log.doneAt, -(task.intervalDays ?? 1))
    // 限次任务：撤销之后还没到次数，就重新回到待办
    if (task.kind === 2) {
      const left = await db.taskLogs.where('taskId').equals(task.id).count()
      reopened = left < Math.max(1, task.limitCount ?? 1)
    }
    await db.tasks.update(task.id, {
      enabled: reopened ? true : task.enabled,
      dueAt: restored,
      lastDoneAt: undefined,
      updatedAt: Date.now()
    })
  })

  if (!task) return
  await cancelRemind(`task:${task.id}`)
  if (restored && (task.kind === 1 || reopened)) {
    await remindAt(restored, '该做这件事了', task.title, `task:${task.id}`)
  }
}

export async function deleteTask(args: Args): Promise<ToolResult> {
  const id = text(args, 'taskId') ?? text(args, 'id')
  if (!id) return { ok: false, message: 'taskId 不能为空' }
  const row = await db.tasks.get(id)
  if (!row) return { ok: false, message: '找不到这个任务' }
  await db.tasks.delete(id)
  await cancelRemind(`task:${id}`)
  return { ok: true, data: { id }, message: `已删除任务「${row.title}」，历史记录保留` }
}

/** 直接把这个任务结束掉（不记一次完成）：周期 / 限次任务「以后不做了」用的 */
export async function closeTask(taskId: string): Promise<void> {
  const row = await db.tasks.get(taskId)
  if (!row) return
  await db.tasks.update(taskId, { enabled: false, closedAt: Date.now(), updatedAt: Date.now() })
  await cancelRemind(`task:${taskId}`)
}

/** 撤销「结束任务」：回到待办，提醒也重新挂上 */
export async function reopenTask(taskId: string): Promise<void> {
  const row = await db.tasks.get(taskId)
  if (!row) return
  await db.tasks.update(taskId, { enabled: true, closedAt: undefined, updatedAt: Date.now() })
  if (row.dueAt) await remindAt(row.dueAt, '该做这件事了', row.title, `task:${taskId}`)
}

/** 界面上的启停开关：关掉就不再提醒，也不再出现在待办里 */
export async function setTaskEnabled(taskId: string, enabled: boolean): Promise<void> {
  const row = await db.tasks.get(taskId)
  if (!row) return
  try {
    await updateVersioned(db.tasks, taskId, row.version, { enabled })
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error
    await db.tasks.update(taskId, { enabled, updatedAt: Date.now() })
  }
  if (enabled && row.dueAt) {
    await remindAt(row.dueAt, '该做这件事了', row.title, `task:${taskId}`)
  } else {
    await cancelRemind(`task:${taskId}`)
  }
}

export const taskCreateTask: AppTool = {
  name: 'task_create_task',
  moduleId: 'task',
  description:
    '创建一个任务。kind = 0 一次性；kind = 1 每 N 天一次、一直重复；kind = 2 限次（每 N 天一次，做够次数就结束）。参数都是扁平字段。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', title: '任务名', description: '用户自己写的文字，例如「喂鱼」' },
      icon: {
        type: 'string',
        title: '图标',
        format: 'icon',
        description: '单个 emoji，可选。用户没提就别猜，留空会退化成标题首字'
      },
      kind: {
        type: 'integer',
        title: '类型',
        enum: [0, 1, 2],
        enumNames: ['一次性', '周期', '限次'],
        description: '0 一次性 / 1 周期 / 2 限次（做够次数就结束）',
        default: 1
      },
      intervalDays: {
        type: 'integer',
        title: '每几天',
        description: 'kind = 1 或 2 时必填，每 N 天一次',
        minimum: 1
      },
      limitCount: {
        type: 'integer',
        title: '做几次',
        description: 'kind = 2 时必填：一共要做几次',
        minimum: 1
      },
      dueAt: {
        type: 'string',
        title: '到期时间',
        format: 'date-time',
        description: 'kind = 0 时必填；kind = 1 时作为首次到期时间，格式 "2026-10-28 09:00"'
      }
    },
    required: ['title']
  },
  execute: createTask
}

export const taskCompleteTask: AppTool = {
  name: 'task_complete_task',
  moduleId: 'task',
  description: '标记任务已完成，会写一条完成记录，周期任务自动滚到下一次。',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', title: '任务 ID', description: '任务 id' },
      note: { type: 'string', title: '备注', format: 'textarea', description: '这次做的备注，可选' }
    },
    required: ['taskId']
  },
  execute: completeTask
}

export const taskListTasks: AppTool = {
  name: 'task_list_tasks',
  moduleId: 'task',
  description: '列出任务与到期时间。',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', title: '最多几条', minimum: 1, maximum: 50, default: 20, description: '最多返回条数' }
    },
    required: ['limit']
  },
  execute: listTasks
}

export const taskQueryLogs: AppTool = {
  name: 'task_query_logs',
  moduleId: 'task',
  description: '查询「我干过什么」的完成记录。',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', title: '从', format: 'date-time', description: '起始时间，默认 30 天前' },
      to: { type: 'string', title: '到', format: 'date-time', description: '结束时间，默认现在' },
      limit: { type: 'integer', title: '最多几条', minimum: 1, maximum: 50, default: 20 }
    },
    required: ['limit']
  },
  execute: queryLogs
}

export const taskDeleteTask: AppTool = {
  name: 'task_delete_task',
  moduleId: 'task',
  description: '删除任务。历史完成记录会保留。调用前必须先向用户确认。',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', title: '任务 ID', description: '要删除的任务 id' }
    },
    required: ['taskId']
  },
  requireConfirm: true,
  execute: deleteTask
}
