import type { RouteRecordRaw } from 'vue-router'

/* ---------- Tool 与表单共用的 JsonSchema（一律扁平） ---------- */

export type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean'

export interface JsonSchemaProp {
  type: JsonSchemaType
  /** 界面上的短标签（不给模型看） */
  title?: string
  description?: string
  /** 枚举值，界面上渲染成分段按钮或 Picker */
  enum?: (string | number)[]
  /** 枚举值的显示文案，与 enum 一一对应 */
  enumNames?: string[]
  default?: string | number | boolean
  minimum?: number
  maximum?: number
  /** 模型侧校验用的正则；界面不校验 */
  pattern?: string
  /** date-time 用原生 datetime-local；icon 用 IconPicker */
  format?: 'date-time' | 'icon' | 'textarea'
}

export interface JsonSchema {
  type: 'object'
  properties: Record<string, JsonSchemaProp>
  required?: string[]
}

export interface ToolResult {
  ok: boolean
  data?: unknown
  message?: string
}

export type ToolSource = 0 | 1

export interface ToolContext {
  /** 0 界面手动 / 1 模型调用。只用于写日志，不影响权限 */
  source: ToolSource
}

export interface AppTool<A extends Record<string, unknown> = Record<string, unknown>> {
  name: string
  moduleId: string
  description: string
  parameters: JsonSchema
  requireConfirm?: boolean
  /**
   * 确认框里额外显示的一段（比如「改前 → 改后」）。
   * 模型自己也能在 tool 结果里看到改动前后的字数。
   */
  preview?: (args: A) => Promise<string> | string
  execute(args: A, ctx?: ToolContext): Promise<ToolResult>
}

/* ---------- 时间轴归一形状 ---------- */

export interface DayItem {
  kind: 'event' | 'task' | 'log'
  id: string
  /** 排序键：事件开始 / 任务到期 / 记录完成时刻 */
  at: number
  endAt?: number
  title: string
  icon?: string
  source?: number
  /** 已完成条目（log）在日视图里灰显 */
  done?: boolean
}

/* ---------- 模块契约 ---------- */

export interface FeatureModule {
  id: string
  routes: RouteRecordRaw[]
  homeEntry: { title: string; icon: string; to: string }
  tools?: AppTool[]
  timeline?: (range: { start: number; end: number }) => Promise<DayItem[]>
  defaultModulePrompt?: string
}
