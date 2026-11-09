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
