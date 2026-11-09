import { afterEach, describe, expect, it } from 'vitest'
import { chatStreamWithFallback, isNetworkBlocked, raceAbort } from '../features/llm/client'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const jsonResponse = (message: unknown) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message }] }),
    text: async () => ''
  }) as unknown as Response

const collect = async (gen: AsyncGenerator<Record<string, unknown>>) => {
  const out: Record<string, unknown>[] = []
  for await (const chunk of gen) out.push(chunk)
  return out
}

const req = {
  baseUrl: 'https://opencode.ai/zen/go/v1',
  apiKey: 'sk-test',
  model: 'deepseek-v4.1-flash',
  messages: [{ role: 'user' as const, content: '你好' }]
}

describe('isNetworkBlocked', () => {
  it('认得浏览器拦截时的那几种报错', () => {
    expect(isNetworkBlocked(new TypeError('Failed to fetch'))).toBe(true)
    expect(isNetworkBlocked(new TypeError('Load failed'))).toBe(true)
    expect(isNetworkBlocked(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(true)
  })

  it('HTTP 错误、用户中断都不算', () => {
    expect(isNetworkBlocked(new Error('HTTP 401: nope'))).toBe(false)
    expect(isNetworkBlocked(new DOMException('aborted', 'AbortError'))).toBe(false)
    expect(isNetworkBlocked('随便什么')).toBe(false)
  })
})

describe('流式失败后退回一次性取完', () => {
  it('先 Failed to fetch，再整段返回：吐一个兜底标记 + 一条 delta', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls === 1) throw new TypeError('Failed to fetch')
      return jsonResponse({ role: 'assistant', content: '早上好' })
    }) as typeof fetch

    const chunks = await collect(chatStreamWithFallback(req))

    expect(calls).toBe(2)
    expect(chunks[0]).toEqual({ koyomi: 'fallback' })
    expect((chunks[1] as { choices: { delta: { content: string } }[] }).choices[0].delta.content).toBe(
      '早上好'
    )
    // 最后补一个收尾块，agent 靠 delta 为空跳过
    expect((chunks.at(-1) as { choices: { finish_reason: string }[] }).choices[0].finish_reason).toBe(
      'stop'
    )
  })

  it('整段返回里带 tool_calls 时，也拼成 delta 的形状', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls === 1) throw new TypeError('Failed to fetch')
      return jsonResponse({
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'schedule_create_event', arguments: '{"title":"开会"}' } }
        ]
      })
    }) as typeof fetch

    const chunks = await collect(chatStreamWithFallback(req))
    const delta = (chunks[1] as { choices: { delta: Record<string, unknown> }[] }).choices[0].delta
    const calls0 = delta.tool_calls as { index: number; id: string; function: { name: string } }[]

    expect(calls0[0].index).toBe(0)
    expect(calls0[0].id).toBe('call_1')
    expect(calls0[0].function.name).toBe('schedule_create_event')
  })

  it('HTTP 错误不重试，原样抛出去', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return { ok: false, status: 401, text: async () => 'unauthorized' } as unknown as Response
    }) as typeof fetch

    await expect(collect(chatStreamWithFallback(req))).rejects.toThrow('HTTP 401')
    expect(calls).toBe(1)
  })

  it('用户中断不重试', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      throw new DOMException('aborted', 'AbortError')
    }) as typeof fetch

    const controller = new AbortController()
    controller.abort()

    await expect(
      collect(chatStreamWithFallback({ ...req, signal: controller.signal }))
    ).rejects.toThrow()
    expect(calls).toBe(1)
  })
})

describe('点「停止」要真的能停', () => {
  it('没给 signal 时原样返回', async () => {
    await expect(raceAbort(Promise.resolve('ok'))).resolves.toBe('ok')
  })

  it('signal 已经中断：立刻抛 AbortError', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(raceAbort(Promise.resolve('ok'), ctrl.signal)).rejects.toThrow(/abort/i)
  })

  it('中途中断：不等原生请求跑完就抛（CapacitorHttp 那条路没有 signal）', async () => {
    const ctrl = new AbortController()
    const never = new Promise<string>(() => {})
    const task = raceAbort(never, ctrl.signal)
    setTimeout(() => ctrl.abort(), 10)
    await expect(task).rejects.toThrow(/abort/i)
  })

  it('没中断时拿到原结果', async () => {
    const ctrl = new AbortController()
    await expect(raceAbort(Promise.resolve(42), ctrl.signal)).resolves.toBe(42)
  })
})
