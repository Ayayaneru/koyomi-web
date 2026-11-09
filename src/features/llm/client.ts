import { Capacitor, CapacitorHttp } from '@capacitor/core'
import type { LlmConfig } from '../../core/db'

/* ============ OpenAI 兼容协议 ============ */

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[] | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface ChatRequest {
  baseUrl: string
  apiKey: string
  model: string
  temperature?: number
  messages: ChatMessage[]
  tools?: unknown[]
  toolChoice?: 'auto' | 'none'
  signal?: AbortSignal
  responseFormat?: 'json'
  /** 会话 id：OpenCode 要求每个会话带一个稳定的 x-opencode-session */
  session?: string
}

/** 网页开发用的本机代理前缀 → 真实域名（和 vite.config.ts 里那两条代理一一对应） */
const PROXY_TARGETS: Record<string, string> = {
  '/zhipu': 'https://open.bigmodel.cn',
  '/opencode': 'https://opencode.ai'
}

/**
 * 把 Base URL 解析成能真正发请求的地址。
 * 网页里 `/zhipu/…` 由 vite 代理转出去；APK 里没有代理，直接发就是 "no protocol"，
 * 所以这里把已知前缀换回真实域名，不认识的相对地址给一句能看懂的提示。
 */
export function resolveBaseUrl(baseUrl: string): string {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!base.startsWith('/')) return base
  if (!Capacitor.isNativePlatform()) return base
  const prefix = Object.keys(PROXY_TARGETS).find(p => base === p || base.startsWith(`${p}/`))
  if (!prefix) {
    throw new Error(
      `「${base}」是网页开发用的本机代理地址，App 里发不出去。去「模型设置」把 Base URL 改成完整的官网地址（https://…）。`
    )
  }
  return PROXY_TARGETS[prefix] + base.slice(prefix.length)
}

export function joinUrl(baseUrl: string, path: string): string {
  const base = resolveBaseUrl(baseUrl)
  return `${base}${path}`
}

let fallbackSession = ''

/** 没有会话 id 时退化成一个进程内的固定值，至少别每个请求换一个 */
function sessionId(): string {
  if (!fallbackSession) {
    fallbackSession =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `koyomi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
  return fallbackSession
}

/**
 * OpenCode Go 的网关要求每个会话带一个稳定的 x-opencode-session（它靠这个做路由和
 * prompt 缓存），不带会直接 400 MissingSessionID。别的厂商不认这个头，所以只对
 * opencode 的地址加。
 */
function headers(apiKey: string, baseUrl = '', session?: string): Record<string, string> {
  const out: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  }
  if (/opencode/i.test(baseUrl)) out['x-opencode-session'] = session || sessionId()
  return out
}

function bodyOf(req: ChatRequest, stream: boolean) {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream,
    temperature: req.temperature ?? 0.7
  }
  if (req.tools?.length) {
    body.tools = req.tools
    body.tool_choice = req.toolChoice ?? 'auto'
  }
  if (req.responseFormat === 'json') body.response_format = { type: 'json_object' }
  return body
}

/** SSE 流式。三个坑：decode 要 stream:true、按 \n\n 切、必须能 abort */
export async function* chatStream(req: ChatRequest): AsyncGenerator<Record<string, unknown>> {
  const res = await fetch(joinUrl(req.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: headers(req.apiKey, req.baseUrl, req.session),
    body: JSON.stringify(bodyOf(req, true)),
    signal: req.signal
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  if (!res.body) throw new Error('响应没有 body，无法流式读取')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''
    for (const part of parts) {
      for (const line of part.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (!payload) continue
        if (payload === '[DONE]') return
        try {
          yield JSON.parse(payload) as Record<string, unknown>
        } catch {
          /* 厂商偶尔发心跳/注释行，跳过 */
        }
      }
    }
  }
}

/** 原生请求（CapacitorHttp）不认 AbortSignal：包一层，中断时立刻抛 AbortError */
function abortedError(): Error {
  try {
    return new DOMException('Aborted', 'AbortError')
  } catch {
    return new Error('Aborted')
  }
}

/**
 * 给「拿不到 signal 的异步任务」补上可中断能力。
 * APK 里流式被跨域拦掉后会退回 CapacitorHttp，那条路没有 signal，
 * 不加这个的话点「停止」要等整个请求跑完才有反应（= 没反应）。
 */
export async function raceAbort<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task
  if (signal.aborted) throw abortedError()
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortedError())
    signal.addEventListener('abort', onAbort, { once: true })
    task.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

/**
 * 非流式一次取完，VLM 识别用（让它直接吐 JSON）。
 * APK 里走 CapacitorHttp：原生网络层不受 CORS 约束，智谱这类不放行跨域的厂商也能用。
 * 浏览器的流式请求（chatStream）仍然用 fetch —— CapacitorHttp 会把响应整段缓冲，SSE 会失去流式。
 */
export async function chatComplete(req: ChatRequest): Promise<ChatMessage> {
  const body = bodyOf(req, false)
  const url = joinUrl(req.baseUrl, '/chat/completions')

  if (Capacitor.isNativePlatform()) {
    const res = await raceAbort(
      CapacitorHttp.post({
        url,
        headers: headers(req.apiKey, req.baseUrl, req.session),
        data: body,
        connectTimeout: 30_000,
        readTimeout: 120_000
      }),
      req.signal
    )
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`)
    }
    const message = (res.data as { choices?: { message?: ChatMessage }[] })?.choices?.[0]?.message
    if (!message) throw new Error('响应里没有 message')
    return message
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: headers(req.apiKey, req.baseUrl, req.session),
    body: JSON.stringify(body),
    signal: req.signal
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = (await res.json()) as { choices?: { message?: ChatMessage }[] }
  const message = data.choices?.[0]?.message
  if (!message) throw new Error('响应里没有 message')
  return message
}

export interface ProbeResult {
  ok: boolean
  message: string
}

/**
 * 浏览器把请求拦下来时（跨域 / 预检失败），fetch 只会抛一句 Failed to fetch ——
 * 这种才值得退回非流式重试；HTTP 4xx、用户中断都不算。
 */
export function isNetworkBlocked(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return /failed to fetch|load failed|networkerror|network request failed|network connection was lost/i.test(
    text
  )
}

/**
 * 流式聊天，拿不到流就退回「一次性取完」。
 *
 * APK 里页面是 https://localhost，厂商不给 CORS（OpenCode Go / 智谱 / OpenAI）时
 * fetch 的 SSE 请求会被直接拦掉，一点内容都收不到；这时改走 chatComplete ——
 * 它在原生环境用 CapacitorHttp，绕开浏览器的同源策略，代价是没有逐字效果。
 * 只有「一个 delta 都没收到」才重试，收到一半再断的不重试（避免回复重复）。
 */
export async function* chatStreamWithFallback(
  req: ChatRequest
): AsyncGenerator<Record<string, unknown>> {
  let received = false
  try {
    for await (const chunk of chatStream(req)) {
      received = true
      yield chunk
    }
    return
  } catch (error) {
    if (received || req.signal?.aborted || !isNetworkBlocked(error)) throw error
  }

  let message: ChatMessage
  try {
    message = await chatComplete(req)
  } catch (error) {
    // 非流式也被拦：说明这台设备真的连不上（网页形态），给句能看懂的
    if (isNetworkBlocked(error)) {
      throw new Error(
        '请求被拦住了（这家厂商不允许跨域）。网页里请用带「本机代理」的地址；App 里会自动改走原生请求'
      )
    }
    throw error
  }

  // 给上层一个标记：这一轮是整段返回的
  yield { koyomi: 'fallback' }
  if (typeof message.content === 'string' && message.content) {
    yield { choices: [{ delta: { content: message.content }, finish_reason: null }] }
  }
  if (message.tool_calls?.length) {
    yield {
      choices: [
        {
          delta: {
            tool_calls: message.tool_calls.map((call, index) => ({
              index,
              id: call.id,
              type: 'function' as const,
              function: call.function
            }))
          },
          finish_reason: null
        }
      ]
    }
  }
  yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
}

/** 拉模型列表（OpenAI 兼容的 /models）。Opencode Zen、DeepSeek、硅基流动等都支持 */
export async function listModels(cfg: Pick<LlmConfig, 'baseUrl' | 'apiKey'>): Promise<string[]> {
  if (!cfg.baseUrl) throw new Error('还没填 Base URL')
  const res = await fetch(joinUrl(cfg.baseUrl, '/models'), {
    headers: cfg.apiKey ? headers(cfg.apiKey, cfg.baseUrl) : undefined
  })
  if (res.status === 401 || res.status === 403) throw new Error('API Key 不对')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as { data?: { id?: unknown }[]; models?: { id?: unknown }[] }
  const raw = data.data ?? data.models ?? []
  const ids = raw.map(item => item.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (!ids.length) throw new Error('接口没有返回可用的模型')
  return [...new Set(ids)].sort()
}

/** DeepSeek 的余额接口（官方文档 /user/balance） */
export async function fetchBalance(apiKey: string): Promise<string> {
  if (!apiKey) throw new Error('还没填 API Key')
  const res = await fetch('https://api.deepseek.com/user/balance', {
    headers: { Authorization: `Bearer ${apiKey}` }
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as {
    is_available?: boolean
    balance_infos?: { currency?: string; total_balance?: string }[]
  }
  const infos = data.balance_infos ?? []
  if (!infos.length) return data.is_available ? '可用' : '不可用'
  return infos.map(item => `${item.total_balance ?? '?'} ${item.currency ?? ''}`.trim()).join(' · ')
}

/**
 * 配置页探测：真的发一条 1 token 的请求，比看 /models 是否 200 更可信 ——
 * 有些厂商没有 /models，有些把错误也返回 200。
 * 注意相对路径（/zhipu/...）只在 npm run dev 的本机代理下有效。
 */
export async function probeProvider(cfg: Pick<LlmConfig, 'baseUrl' | 'apiKey' | 'model'>): Promise<ProbeResult> {
  if (!cfg.baseUrl) return { ok: false, message: '还没填 Base URL' }
  if (!cfg.apiKey) return { ok: false, message: '还没填 API Key' }
  if (!cfg.model) return { ok: false, message: '还没填模型名' }
  try {
    const res = await fetch(joinUrl(cfg.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: headers(cfg.apiKey, cfg.baseUrl),
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false
      })
    })
    if (res.ok) {
      // 相对路径是本机转发，说成「直连」会让人以为填的是厂商地址
      return {
        ok: true,
        message: cfg.baseUrl.startsWith('/') ? '本机转发通了，模型也认' : '可以直连，模型也认'
      }
    }
    if (res.status === 401 || res.status === 403) return { ok: false, message: '连得上，但 API Key 不对' }
    const detail = (await res.text()).slice(0, 140)
    return { ok: false, message: `HTTP ${res.status}：${detail}` }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `请求被拦或网络不通（${detail}）。多半是该厂商不允许跨域` }
  }
}
