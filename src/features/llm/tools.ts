import type { AppTool, JsonSchemaProp, ToolResult } from '../../core/contracts'
import { allTools } from '../../core/container'
import { parseLocal } from '../../core/time'

/* ============ Tool → OpenAI function ============ */

export interface OpenAITool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** 去掉自家用的 enumNames / format:icon 等，只留标准 JSON Schema 字段 */
function sanitizeSchema(prop: JsonSchemaProp): Record<string, unknown> {
  const out: Record<string, unknown> = { type: prop.type }
  if (prop.description) out.description = prop.description
  if (prop.enum) out.enum = prop.enum
  if (prop.default !== undefined) out.default = prop.default
  if (prop.minimum !== undefined) out.minimum = prop.minimum
  if (prop.maximum !== undefined) out.maximum = prop.maximum
  if (prop.pattern) out.pattern = prop.pattern
  if (prop.format === 'date-time') out.format = 'date-time'
  return out
}

export function toOpenAITools(enabledModules: string[]): OpenAITool[] {
  return allTools
    .filter(tool => enabledModules.includes(tool.moduleId))
    .map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(tool.parameters.properties).map(([key, prop]) => [key, sanitizeSchema(prop)])
          ),
          required: tool.parameters.required ?? []
        }
      }
    }))
}

export function findTool(name: string): AppTool | undefined {
  return allTools.find(tool => tool.name === name)
}

/* ============ 参数强校验 ============ */

export interface ValidateOk {
  ok: true
  args: Record<string, unknown>
}
export interface ValidateFail {
  ok: false
  error: string
}

function coerce(prop: JsonSchemaProp, value: unknown): unknown {
  if (typeof value === 'string') {
    if (prop.type === 'number' || prop.type === 'integer') {
      const trimmed = value.trim()
      if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return prop.type === 'integer' ? Math.round(Number(trimmed)) : Number(trimmed)
    }
    if (prop.type === 'boolean' && (value === 'true' || value === 'false')) return value === 'true'
  }
  return value
}

export function validateArgs(tool: AppTool, raw: unknown): ValidateOk | ValidateFail {
  if (raw == null) raw = {}
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '参数必须是一个对象' }
  const input = { ...(raw as Record<string, unknown>) }
  const props = tool.parameters.properties
  const args: Record<string, unknown> = {}

  for (const [key, prop] of Object.entries(props)) {
    let value = coerce(prop, input[key])
    if (value === undefined || value === null || value === '') {
      if (tool.parameters.required?.includes(key)) return { ok: false, error: `${key} 是必填项` }
      if (prop.default !== undefined) value = prop.default
      if (value === undefined) continue
    }

    const typeOk =
      prop.type === 'string'
        ? typeof value === 'string'
        : prop.type === 'boolean'
          ? typeof value === 'boolean'
          : typeof value === 'number' && Number.isFinite(value)
    if (!typeOk) return { ok: false, error: `${key} 的类型应为 ${prop.type}` }

    if (prop.type === 'integer' && typeof value === 'number' && !Number.isInteger(value)) {
      return { ok: false, error: `${key} 必须是整数` }
    }
    if (prop.enum && !prop.enum.includes(value as string | number)) {
      return { ok: false, error: `${key} 只能是 ${prop.enum.join(' / ')}` }
    }
    if (typeof value === 'number') {
      if (prop.minimum !== undefined && value < prop.minimum) return { ok: false, error: `${key} 不能小于 ${prop.minimum}` }
      if (prop.maximum !== undefined && value > prop.maximum) return { ok: false, error: `${key} 不能大于 ${prop.maximum}` }
    }
    if (typeof value === 'string') {
      if (prop.pattern && !new RegExp(prop.pattern).test(value)) return { ok: false, error: `${key} 格式不符合要求` }
      if (prop.format === 'date-time') {
        try {
          parseLocal(value)
        } catch {
          return { ok: false, error: `${key} 应写成 "2026-10-28 14:00" 这样的本机时间` }
        }
      }
      if (prop.format === 'icon' && Array.from(value).length > 2) return { ok: false, error: `${key} 只能是一个 emoji` }
    }
    args[key] = value
  }

  // 界面会带 version 这类不走 schema 的内部字段，原样透传给工具
  for (const [key, value] of Object.entries(input)) {
    if (!(key in props) && value !== undefined) args[key] = value
  }
  return { ok: true, args }
}

export interface RunToolResult {
  result: ToolResult
  /** 回传给模型的内容，超长会被截断 */
  forModel: string
}

const MAX_RESULT_CHARS = 1800

export async function runTool(
  tool: AppTool,
  args: Record<string, unknown>,
  source: 0 | 1
): Promise<RunToolResult> {
  const result = await tool.execute(args, { source })
  let forModel = JSON.stringify({ ok: result.ok, message: result.message, data: result.data ?? null })
  if (forModel.length > MAX_RESULT_CHARS) {
    forModel = `${forModel.slice(0, MAX_RESULT_CHARS)}…（结果过长已截断，需要更细的数据请带 limit 再查一次）`
  }
  return { result, forModel }
}
