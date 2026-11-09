import {
  db,
  activePresetOf,
  getConfig,
  presetListOf,
  type ConfigRow,
  type Preset
} from '../../core/db'
import { moduleById } from '../../core/container'
import { addDays, fmtDate, fmtDateTime, fmtTime, weekdayName } from '../../core/time'
import type { DayItem } from '../../core/contracts'

/** 变量白名单，硬编码七个。白名单之外不认，不做自定义变量引擎。 */
export const PROMPT_VAR_NAMES = [
  'today',
  'now',
  'weekday',
  'upcoming_events',
  'tasks_due',
  'diary_titles',
  'user_name'
] as const

export type PromptVarName = (typeof PROMPT_VAR_NAMES)[number]

async function briefEvents(days: number): Promise<string> {
  const start = Date.now()
  const end = addDays(start, days)
  const parts = await Promise.all(
    [...moduleById.values()].map(m => (m.id === 'schedule' ? (m.timeline?.({ start, end }) ?? []) : []))
  )
  const items = parts.flat().slice(0, 12)
  if (!items.length) return '（没有安排）'
  return items
    .map((item: DayItem) => `${fmtDate(item.at)} ${weekdayName(item.at)} ${fmtTime(item.at)} ${item.title}`)
    .join('\n')
}

async function briefTasks(): Promise<string> {
  const now = Date.now()
  const rows = await db.tasks.toArray()
  const active = rows
    .filter(t => t.enabled && t.dueAt != null)
    .sort((a, b) => (a.dueAt as number) - (b.dueAt as number))
    .slice(0, 10)
  if (!active.length) return '（没有待办）'
  return active
    .map(t => {
      const due = t.dueAt as number
      const overdue = due <= now
      const days = Math.floor((now - due) / 86_400_000)
      const when = overdue
        ? days >= 1
          ? `逾期 ${days} 天`
          : '今天到期'
        : `${fmtDate(due)} ${weekdayName(due)} ${fmtTime(due)}`
      return `${t.icon ? `${t.icon} ` : ''}${t.title} · ${when}（id: ${t.id}）`
    })
    .join('\n')
}

async function recentDiaryTitles(limit: number, allow: boolean): Promise<string> {
  // 日记默认不交给模型；当前预设开了才读
  if (!allow) return '（这个助理没有日记权限）'
  const rows = await db.diary.orderBy('date').reverse().limit(limit).toArray()
  if (!rows.length) return '（还没写过）'
  return rows.map(row => `${fmtDate(row.date)} ${row.title}`).join('\n')
}

export function buildVars(cfg: ConfigRow, preset?: Preset): Record<PromptVarName, () => Promise<string>> {
  const allowDiary = preset ? Boolean(preset.allowDiary) : cfg.prefs.shareDiary === true
  return {
    today: async () => fmtDate(Date.now()),
    now: async () => fmtDateTime(Date.now()),
    weekday: async () => weekdayName(Date.now()),
    upcoming_events: () => briefEvents(7),
    tasks_due: () => briefTasks(),
    diary_titles: () => recentDiaryTitles(3, allowDiary),
    user_name: async () => cfg.prefs.userName?.trim() || '你'
  }
}

export interface RenderResult {
  text: string
  unknown: string[]
}

export function render(tpl: string, vars: Record<string, string>): RenderResult {
  const unknown = new Set<string>()
  const text = tpl.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
    if (!(name in vars)) {
      unknown.add(name)
      return whole // 保留原样，预览页标红
    }
    // 防止注入内容里的 {{ }} 被二次解析
    return vars[name].replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }')
  })
  return { text, unknown: [...unknown] }
}

export async function resolveVars(cfg?: ConfigRow, preset?: Preset): Promise<Record<string, string>> {
  const current = cfg ?? (await getConfig())
  const factories = buildVars(current, preset)
  const entries = await Promise.all(
    (Object.keys(factories) as PromptVarName[]).map(async name => [name, await factories[name]()] as const)
  )
  return Object.fromEntries(entries)
}

export interface BuiltPrompt {
  /** system：人格 + 当前模块规则，不含用户数据 */
  system: string
  /** context：今日日期、日程摘要、待办，作为独立的一条 user 消息发出去（防注入） */
  context: string
  unknown: string[]
  chars: { persona: number; module: number; context: number }
  tokens: { persona: number; module: number; context: number }
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 1.5)
}

export function modulePromptOf(cfg: ConfigRow, moduleId: string): string {
  const custom = cfg.prompt.modulePrompts?.[moduleId]
  if (custom && custom.trim()) return custom
  return moduleById.get(moduleId)?.defaultModulePrompt ?? ''
}

/* ---------- 预设（Preset）：人格 / 能用的模块 / 记忆 ---------- */

// 真正的实现在 db.ts（工具层也要用，放那边不会跟 container 绕成循环依赖）
export const presetList = presetListOf
export const activePreset = activePresetOf

/** 预设允许的模块 ∩ 设置里全局开着的模块 */
export function presetModuleIds(cfg: ConfigRow, preset: Preset = activePreset(cfg)): string[] {
  const global = cfg.prefs.modules ?? []
  return preset.modules.filter(id => global.includes(id))
}

/**
 * 真正交给模型的工具范围。
 * 「对话」预设还要看「让模型读写日记」那个开关（默认关）；写作 / 心理本来就是冲日记来的，
 * 用户主动选了这两个预设，就不再用那个开关拦一道。
 */
/**
 * 真正交给模型的工具范围。
 * modules 只管日程 / 任务；日记单独由 allowDiary 控制（它要同时满足「全局开着日记模块」）。
 */
export function toolModuleIds(cfg: ConfigRow, preset: Preset = activePreset(cfg)): string[] {
  const ids = presetModuleIds(cfg, preset).filter(id => id !== 'vault')
  const global = cfg.prefs.modules ?? []
  if (preset.allowDiary && global.includes('vault')) return [...ids, 'vault']
  return ids
}

/** 预设允许的工具模块；能自改的预设额外带上 llm（记忆 / 人格工具挂在 llm 下面） */
export function memoryAwareModules(
  cfg: ConfigRow,
  preset: Preset = activePreset(cfg)
): string[] {
  const ids = toolModuleIds(cfg, preset)
  const canEdit =
    Boolean(preset.allowEditPersona) ||
    Boolean(preset.allowEditMemory) ||
    Boolean(preset.allowEditModules)
  return canEdit ? [...ids, 'llm'] : ids
}

export function presetOf(cfg: ConfigRow, presetInput: string | Preset): Preset {
  if (typeof presetInput !== 'string') return presetInput
  return presetList(cfg).find(item => item.id === presetInput) ?? presetList(cfg)[0]
}

export async function buildPrompt(
  presetInput: string | Preset,
  cfgInput?: ConfigRow
): Promise<BuiltPrompt> {
  const cfg = cfgInput ?? (await getConfig())
  const preset = presetOf(cfg, presetInput)

  // 人格 / 上下文留空 = 用全局那两段（「对话」预设靠这个，用户自己改过的不会被预设覆盖）
  const persona = preset.persona.trim() || cfg.prompt.persona || ''
  const contextTpl = preset.context.trim() || cfg.prompt.contextTemplate || ''

  // 规则跟着工具走：有日记权限才拼日记那段，没有就不提
  const moduleIds = toolModuleIds(cfg, preset)
  const modulePrompt = moduleIds
    .map(id => modulePromptOf(cfg, id).trim())
    .filter(Boolean)
    .join('\n')

  const vars = await resolveVars(cfg, preset)
  const context = render(contextTpl, vars)

  const system = [persona.trim(), modulePrompt.trim()].filter(Boolean).join('\n\n')
  return {
    system,
    context: context.text,
    unknown: context.unknown,
    chars: { persona: persona.length, module: modulePrompt.length, context: context.text.length },
    tokens: {
      persona: estimateTokens(persona),
      module: estimateTokens(modulePrompt),
      context: estimateTokens(context.text)
    }
  }
}

/** 给预览页：把两层拼起来看完整效果 */
export function fullPrompt(built: BuiltPrompt): string {
  return `【system】\n${built.system}\n\n【context（作为 user 消息）】\n${built.context}`
}
