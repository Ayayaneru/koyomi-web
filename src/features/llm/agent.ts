import type { LlmConfig } from '../../core/db'
import { chatStreamWithFallback, type ChatMessage, type ChatRequest, type ToolCall } from './client'
import { findTool, runTool, validateArgs, type OpenAITool } from './tools'

/* ============ 调用循环：最多 5 轮，参数错误最多回喂 2 次 ============ */

export type AgentEvent =
  | { type: 'delta'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'tool-start'; name: string; display: string; requireConfirm: boolean }
  | { type: 'tool-result'; name: string; ok: boolean; message: string }
  | { type: 'tool-skip'; name: string }
  | { type: 'notice'; text: string }
  | { type: 'error'; message: string }

export interface ConfirmRequest {
  toolName: string
  description: string
  args: Record<string, unknown>
  /** 工具自己给的一段说明（改前 → 改后），显示在确认框里 */
  preview?: string
}

/**
 * 一次询问里的所有操作（2026-10-31 改）。
 * 模型在一条回复里发 3 个写操作时，以前会连弹 3 个确认框；
 * 现在攒成一批问一次，返回 true = 全部执行，false = 全部取消。
 */
export type ConfirmBatchFn = (requests: ConfirmRequest[]) => Promise<boolean>

export interface AgentOptions {
  cfg: LlmConfig
  system: string
  context: string
  history: ChatMessage[]
  input: string
  tools: OpenAITool[]
  confirm: ConfirmBatchFn
  signal: AbortSignal
  /** 会话 id（OpenCode 用它做路由和 prompt 缓存） */
  session?: string
  /** 测试注入：默认走真实的 SSE 请求（单测里换成假 Provider） */
  stream?: (req: ChatRequest) => AsyncGenerator<Record<string, unknown>>
}

const MAX_ROUNDS = 5
const MAX_ARG_RETRY = 2

interface StreamDelta {
  choices?: {
    delta?: {
      content?: string | null
      tool_calls?: {
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
  }[]
}

export function trimHistory(messages: ChatMessage[], maxTurns: number): ChatMessage[] {
  const keep = Math.max(2, maxTurns * 2)
  if (messages.length <= keep) return messages
  let start = messages.length - keep
  while (start < messages.length && messages[start].role === 'tool') start++
  return messages.slice(start)
}

export function toolDisplay(name: string, args: Record<string, unknown>): string {
  const title = String(args.title ?? args.taskId ?? args.id ?? args.keyword ?? '').trim()
  return title ? `${name} · ${title}` : name
}

export async function* runAgent(opts: AgentOptions): AsyncGenerator<AgentEvent> {
  const messages: ChatMessage[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: `<context>\n${opts.context}\n</context>` },
    ...trimHistory(opts.history, opts.cfg.maxHistoryTurns),
    { role: 'user', content: opts.input }
  ]

  let argRetry = 0

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // 用户点了停止：别再开下一轮（上一轮的请求已经中断）
    if (opts.signal.aborted) {
      yield { type: 'notice', text: '已停止' }
      return
    }
    let text = ''
    const calls: ToolCall[] = []
    const stream = opts.stream ?? chatStreamWithFallback

    try {
      for await (const chunk of stream({
        baseUrl: opts.cfg.baseUrl,
        apiKey: opts.cfg.apiKey,
        model: opts.cfg.model,
        temperature: opts.cfg.temperature,
        messages,
        tools: opts.tools.length ? opts.tools : undefined,
        signal: opts.signal,
        session: opts.session
      })) {
        // 兜底标记：这轮是「整段返回」（浏览器拦了流式请求）
        if ((chunk as { koyomi?: string }).koyomi === 'fallback') {
          continue
        }
        const delta = (chunk as StreamDelta).choices?.[0]?.delta
        if (!delta) continue
        if (delta.content) {
          text += delta.content
          yield { type: 'delta', text: delta.content }
        }
        for (const piece of delta.tool_calls ?? []) {
          const slot = (calls[piece.index] ??= {
            id: piece.id ?? `call_${piece.index}`,
            type: 'function',
            function: { name: '', arguments: '' }
          })
          if (piece.id) slot.id = piece.id
          if (piece.function?.name) slot.function.name += piece.function.name
          if (piece.function?.arguments) slot.function.arguments += piece.function.arguments
        }
      }
    } catch (error) {
      if (opts.signal.aborted) {
        yield { type: 'notice', text: '已停止' }
        return
      }
      yield { type: 'error', message: error instanceof Error ? error.message : String(error) }
      return
    }

    if (text.trim()) {
      yield { type: 'assistant', text }
    }
    if (calls.length) {
      // 有的模型会同时给正文和 tool_calls，两个都要带回历史里
      messages.push({ role: 'assistant', content: text.trim() || null, tool_calls: calls })
    } else if (text.trim()) {
      messages.push({ role: 'assistant', content: text })
    }

    if (!calls.length) return

    // 先把这一轮的所有调用解析、校验完，需要确认的攒成一批问一次
    type Step =
      | { kind: 'error'; call: ToolCall; name: string; message: string; counted: boolean }
      | { kind: 'run'; call: ToolCall; tool: NonNullable<ReturnType<typeof findTool>>; args: Record<string, unknown>; needConfirm: boolean }

    const steps: Step[] = []
    for (const call of calls) {
      const tool = findTool(call.function.name)
      if (!tool) {
        steps.push({
          kind: 'error',
          call,
          name: call.function.name,
          message: `工具 ${call.function.name} 不存在`,
          counted: false
        })
        continue
      }

      let parsed: unknown = {}
      try {
        parsed = call.function.arguments ? JSON.parse(call.function.arguments) : {}
      } catch {
        parsed = null
      }

      const validated = validateArgs(tool, parsed)
      if (!validated.ok) {
        steps.push({
          kind: 'error',
          call,
          name: tool.name,
          message: `参数不对：${validated.error}。请修正后重新调用。`,
          counted: true
        })
        continue
      }

      steps.push({
        kind: 'run',
        call,
        tool,
        args: validated.args,
        needConfirm: Boolean(tool.requireConfirm)
      })
    }

    // 一批确认：这条回复里所有要动数据的操作，只弹一次
    const guarded = steps.filter((step): step is Extract<Step, { kind: 'run' }> => step.kind === 'run' && step.needConfirm)
    let approved = true
    if (guarded.length) {
      // 工具可以给一段「改前 → 改后」的说明，让用户在确认框里看清到底动什么
      const requests: ConfirmRequest[] = []
      for (const step of guarded) {
        requests.push({
          toolName: step.tool.name,
          description: step.tool.description,
          args: step.args,
          preview: step.tool.preview ? await step.tool.preview(step.args) : undefined
        })
      }
      approved = await opts.confirm(requests)
    }

    let argFailed = false
    for (const step of steps) {
      if (step.kind === 'error') {
        if (step.counted) {
          argRetry++
          argFailed = true
        }
        messages.push({ role: 'tool', tool_call_id: step.call.id, content: step.message })
        yield { type: 'tool-result', name: step.name, ok: false, message: step.message }
        continue
      }

      if (step.needConfirm && !approved) {
        messages.push({ role: 'tool', tool_call_id: step.call.id, content: '用户取消了这次操作' })
        yield { type: 'tool-skip', name: step.tool.name }
        continue
      }

      yield {
        type: 'tool-start',
        name: step.tool.name,
        display: toolDisplay(step.tool.name, step.args),
        requireConfirm: step.needConfirm
      }

      try {
        const { result, forModel } = await runTool(step.tool, step.args, 1)
        messages.push({ role: 'tool', tool_call_id: step.call.id, content: forModel })
        yield { type: 'tool-result', name: step.tool.name, ok: result.ok, message: result.message ?? '' }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        messages.push({ role: 'tool', tool_call_id: step.call.id, content: `执行失败：${message}` })
        yield { type: 'tool-result', name: step.tool.name, ok: false, message }
      }
    }

    if (argFailed && argRetry > MAX_ARG_RETRY) {
      messages.push({ role: 'user', content: '工具参数连续出错，请先用一句话告诉我哪里不确定，不要再调工具。' })
    }
  }

  yield { type: 'notice', text: `已经连续调了 ${MAX_ROUNDS} 轮工具，先停在这里。` }
}
