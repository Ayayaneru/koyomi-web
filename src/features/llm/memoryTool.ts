import type { AppTool, ToolResult } from '../../core/contracts'
import { getConfig, patchConfig, type Preset } from '../../core/db'
import { activePreset, presetList } from './prompt'

/** 人格和记忆的长度上限：防止模型把 system 越写越长 */
const MAX_PERSONA = 2000
const MAX_CONTEXT = 4000
/** 确认框里预览截断到多少字 */
const PREVIEW_CHARS = 90

type Args = Record<string, unknown>

const ALL_MODULES = ['schedule', 'task', 'vault']
const MODULE_LABEL: Record<string, string> = { schedule: '日程', task: '任务', vault: '日记' }

function short(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return '（空）'
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat
}

function labelOf(target: string): string {
  return target === 'persona' ? '人格' : '记忆'
}

/**
 * 让模型自己维护「预设」的人格和记忆。
 * 2026-11-01：开关从 selfEdit 拆成三个独立的 —— 人格 / 记忆 / 能用哪些模块，
 * 每个预设自己决定开哪个。改之前一定有确认框，框里显示改前改后。
 */
export async function updateMemory(args: Args): Promise<ToolResult> {
  const cfg = await getConfig()
  const preset = activePreset(cfg)

  const target = String(args.target ?? '').trim()
  if (target !== 'context' && target !== 'persona') {
    return { ok: false, message: 'target 只能是 context（记忆）或 persona（人格）' }
  }

  const allowed = target === 'persona' ? preset.allowEditPersona : preset.allowEditMemory
  if (!allowed) {
    return {
      ok: false,
      message: `「${preset.name}」这个预设不许你改${labelOf(target)}。想改先让用户在助理预设页把开关打开。`
    }
  }

  const content = String(args.content ?? '').trim()
  if (!content) return { ok: false, message: '内容不能为空' }

  const limit = target === 'persona' ? MAX_PERSONA : MAX_CONTEXT
  if (content.length > limit) {
    return {
      ok: false,
      message: `太长了（${content.length} 字），上限 ${limit} 字。精简之后再来一次。`
    }
  }

  const before = target === 'persona' ? preset.persona : preset.context

  // 整体替换：模型要给出改完的完整内容，不是往后面追加
  const next = presetList(cfg).map<Preset>(item =>
    item.id === preset.id ? { ...item, [target]: content } : item
  )
  await patchConfig({ prefs: { presets: next } })

  return {
    ok: true,
    data: { preset: preset.id, target, before: before.length, after: content.length },
    message: `已更新「${preset.name}」的${labelOf(target)}（${before.length} → ${content.length} 字）`
  }
}

/** 改「能用哪些模块」：只能从用户全局打开的模块里挑，不能凭空解锁 */
export async function updateAccess(args: Args): Promise<ToolResult> {
  const cfg = await getConfig()
  const preset = activePreset(cfg)

  if (!preset.allowEditModules) {
    return { ok: false, message: `「${preset.name}」这个预设不许你改工具范围。` }
  }

  const raw = String(args.modules ?? '')
  const wanted = raw
    .split(/[,，\s]+/)
    .map(item => item.trim())
    .filter(Boolean)

  const global = cfg.prefs.modules ?? []
  const picked = wanted.filter(id => ALL_MODULES.includes(id) && global.includes(id))
  const rejected = wanted.filter(id => !picked.includes(id))

  const next = presetList(cfg).map<Preset>(item =>
    item.id === preset.id ? { ...item, modules: picked } : item
  )
  await patchConfig({ prefs: { presets: next } })

  const names = picked.map(id => MODULE_LABEL[id] ?? id).join('、') || '（没有）'
  return {
    ok: true,
    data: { preset: preset.id, modules: picked, rejected },
    message:
      `「${preset.name}」现在的工具：${names}` +
      (rejected.length ? `；这几个用不了：${rejected.join('、')}` : '')
  }
}

export const memoryUpdateTool: AppTool = {
  name: 'memory_update',
  moduleId: 'llm',
  description:
    '更新当前预设的人格或长期记忆，整体替换（不是追加）。你手上已经有人格和记忆的当前内容（人格在 system 开头、记忆在 context 里），改之前先对照，别凭印象重写。只在用户明确要求、或你们一起确认过要改的时候用。',
  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        title: '改哪部分',
        enum: ['context', 'persona'],
        enumNames: ['记忆', '人格'],
        description: 'context = 记忆（只存关键的事和偏好）；persona = 人格（说话方式）'
      },
      content: {
        type: 'string',
        title: '新内容',
        format: 'textarea',
        description: '改完之后的完整内容，会整体替换原来那段'
      },
      reason: {
        type: 'string',
        title: '为什么改',
        description: '一句话说明，用户会在确认框里看到'
      }
    },
    required: ['target', 'content']
  },
  requireConfirm: true,
  preview: async args => {
    const cfg = await getConfig()
    const preset = activePreset(cfg)
    const target = String(args.target ?? '')
    const before = target === 'persona' ? preset.persona : preset.context
    return [
      `改「${preset.name}」的${labelOf(target)}`,
      `原：${short(before)}`,
      `新：${short(String(args.content ?? ''))}`
    ].join('\n')
  },
  execute: updateMemory
}

export const accessUpdateTool: AppTool = {
  name: 'access_update',
  moduleId: 'llm',
  description:
    '改当前预设能用哪几个模块的工具。只能从用户已经打开的模块里挑，不能解锁用户关掉的。只在用户明确要求时用。',
  parameters: {
    type: 'object',
    properties: {
      modules: {
        type: 'string',
        title: '要启用哪些',
        description: '逗号分隔，可选：schedule（日程）、task（任务）、vault（日记）。留空 = 一个都不要'
      },
      reason: {
        type: 'string',
        title: '为什么改',
        description: '一句话说明，用户会在确认框里看到'
      }
    },
    required: ['modules']
  },
  requireConfirm: true,
  preview: async args => {
    const cfg = await getConfig()
    const preset = activePreset(cfg)
    const before = preset.modules.map(id => MODULE_LABEL[id] ?? id).join('、') || '（没有）'
    const raw = String(args.modules ?? '')
    const picked = raw
      .split(/[,，\s]+/)
      .map(item => item.trim())
      .filter(Boolean)
      .map(id => MODULE_LABEL[id] ?? id)
      .join('、')
    return [`改「${preset.name}」能用的工具`, `原：${before}`, `新：${picked || '（没有）'}`].join('\n')
  },
  execute: updateAccess
}
