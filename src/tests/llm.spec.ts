import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, type LlmConfig } from '../core/db'
import { allTools } from '../core/container'
import { findTool, runTool, toOpenAITools, validateArgs } from '../features/llm/tools'
import { runAgent } from '../features/llm/agent'
import { contentChunk, scriptedProvider, toolCallChunk } from './llm-scripted'

const cfg: LlmConfig = {
  baseUrl: 'http://127.0.0.1:1/v1',
  model: 'fake',
  apiKey: 'sk-test',
  temperature: 0,
  maxHistoryTurns: 8,
  supportsVision: false
}

beforeEach(async () => {
  await db.events.clear()
  await db.tasks.clear()
  await db.taskLogs.clear()
})

describe('Tool 注册表', () => {
  it('密码库没有注册任何工具（架构隔离，不是运行时开关）', () => {
    const vaultTools = allTools.filter(tool => tool.moduleId === 'vault').map(tool => tool.name)
    expect(vaultTools).toEqual(['vault_write_diary', 'vault_search_diary'])
  })

  it('工具名符合 OpenAI 规则', () => {
    for (const tool of allTools) expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  })

  it('按模块开关过滤工具', () => {
    const onlySchedule = toOpenAITools(['schedule'])
    expect(onlySchedule.length).toBe(4)
    expect(onlySchedule.every(t => t.function.name.startsWith('schedule_'))).toBe(true)
  })

  it('发给模型的 schema 不含自家字段', () => {
    const tool = toOpenAITools(['task']).find(t => t.function.name === 'task_create_task')
    const props = (tool?.function.parameters as { properties: Record<string, Record<string, unknown>> }).properties
    expect(props.icon.enumNames).toBeUndefined()
    expect(props.icon.format).toBeUndefined()
  })
})

describe('参数强校验', () => {
  const createEvent = findTool('schedule_create_event')!

  it('缺必填项直接拒绝', () => {
    const result = validateArgs(createEvent, { title: '开会' })
    expect(result.ok).toBe(false)
  })

  it('数字字符串会被转成数字', () => {
    const tool = findTool('task_create_task')!
    const result = validateArgs(tool, { title: '喂鱼', kind: '1', intervalDays: '3' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.args.kind).toBe(1)
      expect(result.args.intervalDays).toBe(3)
    }
  })

  it('枚举越界拒绝', () => {
    const result = validateArgs(createEvent, { title: '开会', startAt: '2026-10-28 14:00', repeatKind: 9 })
    expect(result.ok).toBe(false)
  })

  it('时间格式不对拒绝', () => {
    const result = validateArgs(createEvent, { title: '开会', startAt: '下周三下午' })
    expect(result.ok).toBe(false)
  })

  it('界面传的 version 这类内部字段会透传', () => {
    const tool = findTool('schedule_update_event')!
    const result = validateArgs(tool, { id: 'ev_1', title: '改个名', version: 7 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.args.version).toBe(7)
  })
})

describe('调用循环（假 Provider）', () => {
  it('模型调 schedule_create_event 后落库，不需要确认', async () => {
    const events: string[] = []
    const provider = scriptedProvider([
      [toolCallChunk('call_1', 'schedule_create_event', { title: '开会', startAt: '2026-10-28 14:00' })],
      [contentChunk('已建好。')]
    ])

    for await (const event of runAgent({
      cfg,
      system: 'sys',
      context: 'ctx',
      history: [],
      input: '明天下午三点开会',
      tools: toOpenAITools(['schedule']),
      confirm: async () => true,
      signal: new AbortController().signal,
      stream: provider
    })) {
      events.push(event.type)
    }

    expect(events).toContain('tool-start')
    expect(events).toContain('tool-result')
    const rows = await db.events.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('开会')
    expect(rows[0].source).toBe(0)
  })

  it('只做 5 轮就停，不会无限刷 token', async () => {
    let called = 0
    async function* loopStream(): AsyncGenerator<Record<string, unknown>> {
      called++
      yield toolCallChunk('call_loop', 'task_list_tasks', { limit: 5 }) as unknown as Record<string, unknown>
    }

    for await (const event of runAgent({
      cfg,
      system: 'sys',
      context: 'ctx',
      history: [],
      input: '循环',
      tools: toOpenAITools(['task']),
      confirm: async () => true,
      signal: new AbortController().signal,
      stream: loopStream
    })) {
      void event
    }
    expect(called).toBe(5)
  })

  it('requireConfirm 的工具被取消后不会动数据', async () => {
    const now = Date.now()
    await db.events.add({
      id: 'ev_del',
      title: '别删我',
      startAt: now,
      endAt: now + 3_600_000,
      repeatKind: 0,
      weekParity: 0,
      source: 0,
      version: 1,
      createdAt: now,
      updatedAt: now
    })

    const provider = scriptedProvider([
      [toolCallChunk('call_2', 'schedule_delete_event', { id: 'ev_del' })],
      [contentChunk('好的，不删了。')]
    ])

    const confirms: string[] = []
    for await (const event of runAgent({
      cfg,
      system: 'sys',
      context: 'ctx',
      history: [],
      input: '删掉那条',
      tools: toOpenAITools(['schedule']),
      confirm: async reqs => {
        confirms.push(...reqs.map(req => req.toolName))
        return false
      },
      signal: new AbortController().signal,
      stream: provider
    })) {
      void event
    }

    expect(confirms).toEqual(['schedule_delete_event'])
    expect(await db.events.get('ev_del')).toBeTruthy()
  })

  it('一条回复里的多个写操作只问一次', async () => {
    const now = Date.now()
    const base = { repeatKind: 0 as const, weekParity: 0 as const, source: 0 as const, version: 1, createdAt: now, updatedAt: now }
    await db.events.bulkAdd([
      { ...base, id: 'ev_a', title: 'A', startAt: now, endAt: now + 3_600_000 },
      { ...base, id: 'ev_b', title: 'B', startAt: now, endAt: now + 3_600_000 }
    ])

    // 同一轮里发两个 tool_call（index 0 / 1）
    const provider = scriptedProvider([
      [
        toolCallChunk('call_a', 'schedule_delete_event', { id: 'ev_a' }, 0),
        toolCallChunk('call_b', 'schedule_delete_event', { id: 'ev_b' }, 1)
      ],
      [contentChunk('两条都删了。')]
    ])

    const batches: string[][] = []
    for await (const event of runAgent({
      cfg,
      system: 'sys',
      context: 'ctx',
      history: [],
      input: '把 A 和 B 都删了',
      tools: toOpenAITools(['schedule']),
      confirm: async reqs => {
        batches.push(reqs.map(req => req.toolName))
        return true
      },
      signal: new AbortController().signal,
      stream: provider
    })) {
      void event
    }

    // 只弹一次，两条都在这一批里
    expect(batches).toHaveLength(1)
    expect(batches[0]).toEqual(['schedule_delete_event', 'schedule_delete_event'])
    expect(await db.events.count()).toBe(0)
  })

  it('整批取消时两条都不动', async () => {
    const now = Date.now()
    const base = { repeatKind: 0 as const, weekParity: 0 as const, source: 0 as const, version: 1, createdAt: now, updatedAt: now }
    await db.events.bulkAdd([
      { ...base, id: 'ev_c', title: 'C', startAt: now, endAt: now + 3_600_000 },
      { ...base, id: 'ev_d', title: 'D', startAt: now, endAt: now + 3_600_000 }
    ])

    const provider = scriptedProvider([
      [
        toolCallChunk('call_c', 'schedule_delete_event', { id: 'ev_c' }, 0),
        toolCallChunk('call_d', 'schedule_delete_event', { id: 'ev_d' }, 1)
      ],
      [contentChunk('好的，都不删。')]
    ])

    const skipped: string[] = []
    for await (const event of runAgent({
      cfg,
      system: 'sys',
      context: 'ctx',
      history: [],
      input: '删掉 C 和 D',
      tools: toOpenAITools(['schedule']),
      confirm: async () => false,
      signal: new AbortController().signal,
      stream: provider
    })) {
      if (event.type === 'tool-skip') skipped.push(event.name)
    }

    expect(skipped).toEqual(['schedule_delete_event', 'schedule_delete_event'])
    expect(await db.events.count()).toBe(2)
  })
})

describe('工具结果截断', () => {
  it('超长结果回传给模型时会被截断', async () => {
    const tool = findTool('task_list_tasks')!
    const result = await runTool(tool, { limit: 50 }, 1)
    expect(result.forModel.length).toBeLessThan(2000)
  })
})

describe('整段返回（流式被拦住时）', () => {
  it('不弹提示，正文照常收下', async () => {
    const events: string[] = []
    let text = ''

    async function* fallbackStream(): AsyncGenerator<Record<string, unknown>> {
      yield { koyomi: 'fallback' }
      yield contentChunk('整段回复') as unknown as Record<string, unknown>
    }

    for await (const event of runAgent({
      cfg,
      system: 'sys',
      context: 'ctx',
      history: [],
      input: '你好',
      tools: [],
      confirm: async () => true,
      signal: new AbortController().signal,
      stream: fallbackStream
    })) {
      events.push(event.type)
      if (event.type === 'assistant') text = event.text
    }

    // 2026-11-01：用户要求删掉「这台设备拦住了流式请求」这句提示，静默降级
    expect(events).not.toContain('notice')
    expect(events).toContain('assistant')
    expect(text).toBe('整段回复')
  })
})
