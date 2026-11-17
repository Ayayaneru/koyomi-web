import type { AppTool, ToolResult } from '../../core/contracts'
import { activePresetOf, db, getConfig, type DiaryRow } from '../../core/db'
import { newId } from '../../core/crypto'
import { dayStart, fmtDate, parseLocal } from '../../core/time'

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

/**
 * 日记默认不开放给模型。
 * 2026-11-01：开关从全局搬进「助理预设」，这里按当前预设判断（运行时兜底，
 * 工具本身已经按预设过滤过了）。
 */
export async function diaryAllowed(): Promise<boolean> {
  const cfg = await getConfig()
  if (!(cfg.prefs.modules ?? []).includes('vault')) return false
  return Boolean(activePresetOf(cfg).allowDiary)
}

async function writeDiary(args: Args): Promise<ToolResult> {
  if (!(await diaryAllowed())) return { ok: false, message: '用户没有把日记开放给模型' }
  const content = text(args, 'content')
  if (!content) return { ok: false, message: 'content 不能为空' }
  const title = text(args, 'title') ?? fmtDate(Date.now())
  const rawDate = text(args, 'date')
  let date = dayStart(Date.now())
  if (rawDate) {
    try {
      date = dayStart(parseLocal(rawDate))
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '日期格式不对' }
    }
  }

  const now = Date.now()
  const row: DiaryRow = {
    id: newId('dy'),
    date,
    title: title.slice(0, 80),
    content,
    tags: text(args, 'tags') ?? '',
    extJson: null,
    createdAt: now,
    updatedAt: now
  }
  await db.diary.add(row)
  return { ok: true, data: row, message: `已写日记「${row.title}」（${fmtDate(date)}）` }
}

export async function searchDiary(args: Args): Promise<ToolResult> {
  if (!(await diaryAllowed())) return { ok: false, message: '用户没有把日记开放给模型' }
  const keyword = (text(args, 'keyword') ?? '').toLowerCase()
  const limit = Math.min(50, Math.max(1, int(args, 'limit') ?? 20))
  const rows = await db.diary.orderBy('date').reverse().toArray()
  const hits = rows
    .filter(row => {
      if (!keyword) return true
      return (
        row.title.toLowerCase().includes(keyword) ||
        row.content.toLowerCase().includes(keyword) ||
        (row.tags ?? '').toLowerCase().includes(keyword)
      )
    })
    .slice(0, limit)
    .map(row => ({
      id: row.id,
      date: fmtDate(row.date),
      title: row.title,
      tags: row.tags,
      excerpt: row.content.length > 120 ? `${row.content.slice(0, 120)}…` : row.content
    }))
  return { ok: true, data: hits, message: hits.length ? `找到 ${hits.length} 篇` : '没有匹配的日记' }
}
/** 按 id 或日期找一篇日记。allowLatest=false（改 / 删）时不允许「不指定就取最近那篇」 */
async function findDiary(args: Args, allowLatest = true): Promise<DiaryRow | undefined> {
  const id = text(args, 'id')
  if (id) return db.diary.get(id)
  const rawDate = text(args, 'date')
  if (rawDate) {
    const date = dayStart(parseLocal(rawDate))
    // 同一天可能写好几篇，取最后更新的那篇
    const rows = await db.diary.where('date').equals(date).toArray()
    return rows.sort((a, b) => b.updatedAt - a.updatedAt)[0]
  }
  if (!allowLatest) return undefined
  return db.diary.orderBy('date').reverse().first()
}

/** 读全文：改日记之前模型必须先把正文拿到手，否则只能改标题 */
export async function readDiary(args: Args): Promise<ToolResult> {
  if (!(await diaryAllowed())) return { ok: false, message: '用户没有把日记开放给模型' }
  let row: DiaryRow | undefined
  try {
    row = await findDiary(args)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '日期格式不对' }
  }
  if (!row) return { ok: false, message: '没找到这篇日记' }
  return {
    ok: true,
    data: {
      id: row.id,
      date: fmtDate(row.date),
      title: row.title,
      tags: row.tags ?? '',
      content: row.content,
      updatedAt: new Date(row.updatedAt).toISOString()
    },
    message: `日记「${row.title}」（${fmtDate(row.date)}，正文 ${row.content.length} 字）`
  }
}
/** 改标题 / 正文 / 标签；正文是整段替换，不是追加 */
export async function updateDiary(args: Args): Promise<ToolResult> {
  if (!(await diaryAllowed())) return { ok: false, message: '用户没有把日记开放给模型' }
  let row: DiaryRow | undefined
  try {
    row = await findDiary(args, false)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '日期格式不对' }
  }
  if (!row) return { ok: false, message: '没找到这篇日记：要带 id，或者带 date（同一天多篇时只能用 id）' }

  const patch: Partial<DiaryRow> = {}
  if (args.title !== undefined) {
    const title = text(args, 'title')
    if (!title) return { ok: false, message: '标题不能改成空' }
    patch.title = title.slice(0, 80)
  }
  if (args.content !== undefined) {
    const content = text(args, 'content')
    if (!content) return { ok: false, message: '正文不能改成空；要删这篇请用 vault_delete_diary' }
    patch.content = content
  }
  if (args.tags !== undefined) patch.tags = text(args, 'tags') ?? ''
  const rawDate = text(args, 'date')
  if (rawDate) {
    try {
      patch.date = dayStart(parseLocal(rawDate))
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '日期格式不对' }
    }
  }
  if (Object.keys(patch).length === 0) return { ok: false, message: '没有要改的字段' }

  patch.updatedAt = Date.now()
  const before = { title: row.title, chars: row.content.length }
  await db.diary.update(row.id, patch)
  const after = (await db.diary.get(row.id)) ?? { ...row, ...patch }
  return {
    ok: true,
    data: after,
    message:
      before.title === after.title
        ? `已改日记「${after.title}」，正文 ${before.chars} → ${after.content.length} 字`
        : `已改日记：${before.title} → ${after.title}，正文 ${before.chars} → ${after.content.length} 字`
  }
}

/** 删掉一整篇，没有回收站 */
export async function deleteDiary(args: Args): Promise<ToolResult> {
  if (!(await diaryAllowed())) return { ok: false, message: '用户没有把日记开放给模型' }
  let row: DiaryRow | undefined
  try {
    row = await findDiary(args, false)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '日期格式不对' }
  }
  if (!row) return { ok: false, message: '没找到这篇日记：要带 id，或者带 date（同一天多篇时只能用 id）' }
  await db.diary.delete(row.id)
  return {
    ok: true,
    data: { id: row.id, title: row.title, date: fmtDate(row.date) },
    message: `已删除日记「${row.title}」（${fmtDate(row.date)}），没有回收站`
  }
}

export const vaultWriteDiary: AppTool = {
  name: 'vault_write_diary',
  moduleId: 'vault',
  description: '写一篇日记。写入前必须先让用户确认内容。',
  parameters: {
    type: 'object',
    properties: {
      date: { type: 'string', title: '日期', format: 'date-time', description: '日期，不填就是今天' },
      title: { type: 'string', title: '标题', description: '标题' },
      content: { type: 'string', title: '正文', format: 'textarea', description: '正文' },
      tags: { type: 'string', title: '标签', description: '标签，逗号分隔' }
    },
    required: ['content']
  },
  requireConfirm: true,
  execute: writeDiary
}

export const vaultSearchDiary: AppTool = {
  name: 'vault_search_diary',
  moduleId: 'vault',
  description: '按关键词搜索日记标题、正文和标签，返回摘要。',
  parameters: {
    type: 'object',
    properties: {
      keyword: { type: 'string', title: '关键词', description: '关键词，留空表示最近几篇' },
      limit: { type: 'integer', title: '最多几条', minimum: 1, maximum: 50, default: 10 }
    },
    required: ['limit']
  },
  execute: searchDiary
}
export const vaultReadDiary: AppTool = {
  name: 'vault_read_diary',
  moduleId: 'vault',
  description: '读一篇日记的全文（标题、标签、正文）。改日记之前先用它把正文拿到手。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', title: '日记 ID', description: '从 vault_search_diary 拿到的 id；给了 id 就不用 date' },
      date: {
        type: 'string',
        title: '日期',
        format: 'date-time',
        description: '哪一天，不填 id 时用它找当天最后一篇；都不填就是最近写的那篇'
      }
    }
  },
  execute: readDiary
}

export const vaultUpdateDiary: AppTool = {
  name: 'vault_update_diary',
  moduleId: 'vault',
  description: '修改已有日记的标题 / 正文 / 标签，只传要改的字段。改之前必须先 read 拿到正文。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', title: '日记 ID', description: '要改的日记 id' },
      date: {
        type: 'string',
        title: '日期',
        format: 'date-time',
        description: '没有 id 时用日期定位（同一天多篇时只能用 id）'
      },
      title: { type: 'string', title: '标题', description: '新标题' },
      content: {
        type: 'string',
        title: '正文',
        format: 'textarea',
        description: '新正文，整段替换而不是追加'
      },
      tags: { type: 'string', title: '标签', description: '新标签，逗号分隔；空字符串表示清空' }
    }
  },
  requireConfirm: true,
  preview: async args => {
    const row = await findDiary(args, false).catch(() => undefined)
    if (!row) return '找不到这篇日记，先 search / read 确认 id'
    const lines = [`「${row.title}」（${fmtDate(row.date)}）`]
    if (args.title !== undefined) lines.push(`标题：${row.title} → ${String(args.title)}`)
    if (args.content !== undefined) lines.push(`正文：${row.content.length} 字 → ${String(args.content).length} 字`)
    if (args.tags !== undefined) lines.push(`标签：${row.tags || '无'} → ${String(args.tags || '无')}`)
    return lines.join('\n')
  },
  execute: updateDiary
}

export const vaultDeleteDiary: AppTool = {
  name: 'vault_delete_diary',
  moduleId: 'vault',
  description: '删除一整篇日记（没有回收站）。调用前必须先向用户确认。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', title: '日记 ID', description: '要删的日记 id' },
      date: {
        type: 'string',
        title: '日期',
        format: 'date-time',
        description: '没有 id 时用日期定位（同一天多篇时只能用 id）'
      }
    }
  },
  requireConfirm: true,
  preview: async args => {
    const row = await findDiary(args, false).catch(() => undefined)
    if (!row) return '找不到这篇日记，先 search / read 确认 id'
    const head = row.content.length > 40 ? `${row.content.slice(0, 40)}…` : row.content
    return `删「${row.title}」（${fmtDate(row.date)}，正文 ${row.content.length} 字）\n${head}\n删除没有回收站。`
  },
  execute: deleteDiary
}
