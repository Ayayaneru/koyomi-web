import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { reactive, ref } from 'vue'
import { ConflictError, db, defaultConfig, getConfig, patchConfig, updateVersioned, type EventRow } from '../core/db'
import { mergeConfig } from '../features/settings/backup'

function row(): EventRow {
  const now = Date.now()
  return {
    id: 'ev_lock',
    title: '原始标题',
    startAt: now,
    endAt: now + 3_600_000,
    repeatKind: 0,
    weekParity: 0,
    source: 0,
    version: 1,
    createdAt: now,
    updatedAt: now
  }
}

beforeEach(async () => {
  await db.events.clear()
  await db.config.clear()
})

describe('乐观锁 updateVersioned', () => {
  it('版本对得上才能改，改完版本 +1', async () => {
    await db.events.add(row())
    await updateVersioned(db.events, 'ev_lock', 1, { title: '第一次改' })
    const after = await db.events.get('ev_lock')
    expect(after?.title).toBe('第一次改')
    expect(after?.version).toBe(2)
  })

  it('同一个版本改两次，第二次抛冲突且不覆盖数据', async () => {
    await db.events.add(row())
    await updateVersioned(db.events, 'ev_lock', 1, { title: '我的修改' })
    await expect(updateVersioned(db.events, 'ev_lock', 1, { title: '模型的修改' })).rejects.toBeInstanceOf(
      ConflictError
    )
    const after = await db.events.get('ev_lock')
    expect(after?.title).toBe('我的修改')
    expect(after?.version).toBe(2)
  })
})

describe('备份 config 合并', () => {
  it('文件里 apiKey 为空时保留库里原有的 Key', () => {
    const current = defaultConfig()
    current.llm.apiKey = 'sk-local'
    const merged = mergeConfig({ llm: { baseUrl: 'https://x/v1', model: 'm', apiKey: '' } }, current)
    expect(merged.llm.apiKey).toBe('sk-local')
    expect(merged.llm.baseUrl).toBe('https://x/v1')
  })

  it('文件里带了 Key 就覆盖', () => {
    const current = defaultConfig()
    current.llm.apiKey = 'sk-local'
    const merged = mergeConfig({ llm: { apiKey: 'sk-file' } }, current)
    expect(merged.llm.apiKey).toBe('sk-file')
  })

  it('视觉模型：文件里没带 Key 就沿用库里原有的', () => {
    const current = defaultConfig()
    current.vlm = { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-flash', apiKey: 'sk-local' }
    const merged = mergeConfig({ vlm: { baseUrl: '/zhipu/api/paas/v4', model: 'glm-4v-flash', apiKey: '' } }, current)
    expect(merged.vlm?.apiKey).toBe('sk-local')
    expect(merged.vlm?.baseUrl).toBe('/zhipu/api/paas/v4')
  })

  it('旧备份没有 vlm 段时不动已有配置', () => {
    const current = defaultConfig()
    current.vlm = { baseUrl: 'https://x/v4', model: 'm', apiKey: 'sk-keep' }
    const merged = mergeConfig({ prefs: { userName: '阿' } }, current)
    expect(merged.vlm?.apiKey).toBe('sk-keep')
  })

  it('导入不碰 vaultSalt', () => {
    const current = defaultConfig()
    current.vaultSalt = 'salt-keep'
    const merged = mergeConfig({ prefs: { userName: '新名字' } }, current)
    expect(merged.vaultSalt).toBe('salt-keep')
    expect(merged.prefs.userName).toBe('新名字')
  })
})


describe('patchConfig 按段合并', () => {
  it('只改 prefs 里的一项，不会把同段其他字段清空', async () => {
    const cfg = await getConfig()
    await patchConfig({ prefs: { ...cfg.prefs, festivals: ['qixi'] } })
    // 模拟「只改昵称」的调用（旧代码会把 modules/festivals 抹掉）
    await patchConfig({ prefs: { userName: '阿' } as unknown as typeof cfg.prefs })

    const after = await getConfig()
    expect(after.prefs.userName).toBe('阿')
    expect(after.prefs.festivals).toEqual(['qixi'])
    expect(after.prefs.modules).toEqual(cfg.prefs.modules)
  })

  it('传进来的响应式数组也能存（Vue 代理不能被结构化克隆）', async () => {
    const festivals = ref(['chuxi', 'qixi'])
    await patchConfig({ prefs: { userName: '响应式', modules: ['llm'], festivals: festivals.value } })

    const after = await getConfig()
    expect(after.prefs.festivals).toEqual(['chuxi', 'qixi'])
  })

  it('嵌套的 reactive 对象也能存', async () => {
    const patch = reactive({ prompt: { persona: '简短', modulePrompts: { schedule: 'x' }, contextTemplate: 'y' } })
    await patchConfig({ prompt: patch.prompt })
    const after = await getConfig()
    expect(after.prompt.modulePrompts.schedule).toBe('x')
  })

  it('只改 llm 的 key，不影响 prompt 和 vlm', async () => {
    const cfg = await getConfig()
    await patchConfig({ vlm: { baseUrl: '/zhipu/api/paas/v4', model: 'glm-4v-flash', apiKey: 'sk-v' } })
    await patchConfig({ llm: { ...cfg.llm, apiKey: 'sk-new' } })
    await patchConfig({ prompt: { ...cfg.prompt, persona: '简短点' } })

    const after = await getConfig()
    expect(after.llm.apiKey).toBe('sk-new')
    expect(after.prompt.persona).toBe('简短点')
    expect(after.vlm?.model).toBe('glm-4v-flash')
  })
})
