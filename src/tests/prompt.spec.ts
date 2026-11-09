import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, defaultConfig, DEFAULT_PRESETS } from '../core/db'
import {
  activePreset,
  buildPrompt,
  memoryAwareModules,
  presetList,
  toolModuleIds
} from '../features/llm/prompt'
import { accessUpdateTool, memoryUpdateTool, updateAccess, updateMemory } from '../features/llm/memoryTool'

beforeEach(async () => {
  await db.events.clear()
  await db.tasks.clear()
  await db.diary.clear()
  await db.config.clear()
})

const chat = DEFAULT_PRESETS[0]
const write = DEFAULT_PRESETS[1]
const mind = DEFAULT_PRESETS[2]

describe('预设：人格 / 模块 / 记忆', () => {
  it('默认三个：对话、写作、心理', () => {
    const cfg = defaultConfig()
    expect(presetList(cfg).map(p => p.name)).toEqual(['对话', '写作', '心理'])
    expect(activePreset(cfg).id).toBe('chat')
  })

  it('对话预设：人格回落到全局，日常规则在、日记默认不给', async () => {
    const cfg = defaultConfig()
    const built = await buildPrompt('chat', cfg)

    expect(built.system).toContain('你是 Koyomi')
    expect(built.system).toContain('改或删已有日程前')
    expect(built.system).toContain('完成记录没有删除工具')
    // 日记默认关着，那段规则和工具都不该出现
    expect(built.system).not.toContain('不要主动引用日记正文')
  })

  it('写作预设：人格换成写作搭子，规则只有日记那段', async () => {
    const cfg = defaultConfig()
    const built = await buildPrompt('write', cfg)

    expect(built.system).toContain('写作搭子')
    expect(built.system).toContain('不要主动引用日记正文')
    expect(built.system).not.toContain('改或删已有日程前')
    expect(built.system).not.toContain('完成记录没有删除工具')
  })

  it('心理预设：人格是「老朋友」，记忆走 context', async () => {
    const cfg = defaultConfig()
    const built = await buildPrompt('mind', cfg)

    expect(built.system).toContain('老朋友')
    expect(built.context).toContain('不要一次全倒出来')
    expect(built.system).not.toContain('改或删已有日程前')
  })

  it('切换 activePreset 之后，同一个函数拼出来是另一套', async () => {
    const cfg = defaultConfig()
    cfg.prefs.activePreset = 'write'
    expect(activePreset(cfg).id).toBe('write')
    const built = await buildPrompt(activePreset(cfg), cfg)
    expect(built.system).toContain('写作搭子')
  })

  it('全局把某个模块关了，预设也拿不到', () => {
    const cfg = defaultConfig()
    cfg.prefs.modules = ['llm', 'schedule']
    expect(toolModuleIds(cfg, write)).toEqual([]) // 写作要日记，日记被全局关了
  })
})

describe('工具范围：日记是单独的开关', () => {
  it('对话预设默认不给日记，只给日程和任务', () => {
    const cfg = defaultConfig()
    expect(toolModuleIds(cfg, chat)).toEqual(['schedule', 'task'])
  })

  it('对话预设把「用日记」打开，三个模块都在', () => {
    const cfg = defaultConfig()
    const preset = { ...chat, allowDiary: true }
    expect(toolModuleIds(cfg, preset)).toEqual(['schedule', 'task', 'vault'])
  })

  it('写作 / 心理只给日记', () => {
    const cfg = defaultConfig()
    expect(toolModuleIds(cfg, write)).toEqual(['vault'])
    expect(toolModuleIds(cfg, mind)).toEqual(['vault'])
  })

  it('「用日记」开着，但全局把日记模块关了，还是不给', () => {
    const cfg = defaultConfig()
    cfg.prefs.modules = ['llm', 'schedule', 'task']
    expect(toolModuleIds(cfg, write)).toEqual([])
  })

  it('有任意一个「能改」的开关，才挂记忆工具', () => {
    const cfg = defaultConfig()
    expect(memoryAwareModules(cfg, chat)).not.toContain('llm')
    expect(memoryAwareModules(cfg, write)).toContain('llm') // 能改记忆
    expect(memoryAwareModules(cfg, mind)).toContain('llm')
  })

  it('三个开关全关的预设拿不到记忆工具', () => {
    const cfg = defaultConfig()
    const bare = { ...mind, allowEditPersona: false, allowEditMemory: false, allowEditModules: false }
    expect(memoryAwareModules(cfg, bare)).not.toContain('llm')
  })
})

describe('模型自己维护人格 / 记忆 / 工具范围', () => {
  it('对话预设：什么都不能改', async () => {
    await db.config.put(defaultConfig())
    expect((await updateMemory({ target: 'context', content: 'x' })).ok).toBe(false)
    expect((await updateMemory({ target: 'persona', content: 'x' })).ok).toBe(false)
    expect((await updateAccess({ modules: 'schedule' })).ok).toBe(false)
  })

  it('写作预设：能改记忆，改不了人格和工具', async () => {
    const cfg = defaultConfig()
    cfg.prefs.activePreset = 'write'
    await db.config.put(cfg)

    expect((await updateMemory({ target: 'context', content: '他喜欢短句。' })).ok).toBe(true)
    expect((await updateMemory({ target: 'persona', content: '换个说法' })).ok).toBe(false)
    expect((await updateAccess({ modules: 'schedule' })).ok).toBe(false)
  })

  it('心理预设：人格和记忆都能改，改完真的进了库', async () => {
    const cfg = defaultConfig()
    cfg.prefs.activePreset = 'mind'
    await db.config.put(cfg)

    expect((await updateMemory({ target: 'persona', content: '你是他认识十年的朋友。' })).ok).toBe(true)
    expect((await updateMemory({ target: 'context', content: '他最近在换工作，睡不好。' })).ok).toBe(true)

    const saved = await db.config.get('app')
    const preset = (saved?.prefs.presets ?? []).find(p => p.id === 'mind')
    expect(preset?.persona).toBe('你是他认识十年的朋友。')
    expect(preset?.context).toBe('他最近在换工作，睡不好。')
  })

  it('工具范围：只能从用户开着的模块里挑', async () => {
    const cfg = defaultConfig()
    cfg.prefs.activePreset = 'mind'
    cfg.prefs.modules = ['llm', 'schedule', 'task', 'vault']
    await db.config.put(cfg)

    const editable = { ...mind, allowEditModules: true }
    await db.config.put({ ...cfg, prefs: { ...cfg.prefs, presets: [chat, write, editable] } })

    const result = await updateAccess({ modules: 'schedule, vault, 不存在的东西' })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('日程')
    expect(result.message).toContain('日记')
    expect(result.message).toContain('不存在的东西')
  })

  it('太长的不收', async () => {
    const cfg = defaultConfig()
    cfg.prefs.activePreset = 'mind'
    await db.config.put(cfg)
    const result = await updateMemory({ target: 'persona', content: 'x'.repeat(2100) })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('太长')
  })
})

describe('确认框里的「改前 → 改后」', () => {
  it('记忆：原样和新样都给出来', async () => {
    const cfg = defaultConfig()
    cfg.prefs.activePreset = 'write'
    await db.config.put(cfg)
    const text = await memoryUpdateTool.preview!({ target: 'context', content: '只记关键的事。' })
    expect(text).toContain('改「写作」的记忆')
    expect(text).toContain('原：')
    expect(text).toContain('新：只记关键的事。')
  })

  it('工具范围：原来的和新的都列出来', async () => {
    const cfg = defaultConfig()
    cfg.prefs.activePreset = 'mind'
    await db.config.put(cfg)
    const text = await accessUpdateTool.preview!({ modules: 'schedule,task' })
    expect(text).toContain('原：（没有）')
    expect(text).toContain('新：日程、任务')
  })
})
