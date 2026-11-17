import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, DEFAULT_PRESETS, patchConfig, type Preset } from '../core/db'
import { deleteDiary, readDiary, updateDiary } from '../features/vault/diaryTool'
import { vaultWriteDiary } from '../features/vault/diaryTool'

/** 日记默认不开放：测试里先把「对话」预设的 allowDiary 打开、全局模块也带上 vault */
async function allowDiary(on = true): Promise<void> {
  const presets: Preset[] = DEFAULT_PRESETS.map(preset =>
    preset.id === 'chat' ? { ...preset, allowDiary: on } : preset
  )
  await patchConfig({
    prefs: {
      modules: on ? ['llm', 'schedule', 'task', 'vault'] : ['llm', 'schedule', 'task'],
      presets,
      activePreset: 'chat'
    }
  })
}

beforeEach(async () => {
  await db.diary.clear()
  await db.config.clear()
  await allowDiary()
})

describe('模型操作日记：读全文 / 改 / 删（2026-11-15）', () => {
  it('写 → 读全文 → 改 → 删，一路都能走通', async () => {
    const written = await vaultWriteDiary.execute({ title: '周六', content: '上午跑步，下午读书。', tags: '生活' }, { source: 1 })
    expect(written.ok).toBe(true)
    const id = (written.data as { id: string }).id

    const read = await readDiary({ id })
    expect(read.ok).toBe(true)
    expect((read.data as { content: string }).content).toBe('上午跑步，下午读书。')

    const updated = await updateDiary({ id, title: '周六补记', content: '上午跑步。' })
    expect(updated.ok).toBe(true)
    const row = await db.diary.get(id)
    expect(row?.title).toBe('周六补记')
    expect(row?.content).toBe('上午跑步。')

    const removed = await deleteDiary({ id })
    expect(removed.ok).toBe(true)
    expect(await db.diary.get(id)).toBeUndefined()
  })

  it('改 / 删必须带 id 或日期，不会顺手动最近那篇', async () => {
    await vaultWriteDiary.execute({ title: 'A', content: 'aaa' }, { source: 1 })
    await vaultWriteDiary.execute({ title: 'B', content: 'bbb' }, { source: 1 })
    expect((await updateDiary({ title: 'C' })).ok).toBe(false)
    expect((await deleteDiary({})).ok).toBe(false)
    expect(await db.diary.count()).toBe(2)
  })

  it('正文不能改成空；要删就用 delete', async () => {
    const written = await vaultWriteDiary.execute({ title: 'A', content: 'aaa' }, { source: 1 })
    const id = (written.data as { id: string }).id
    expect((await updateDiary({ id, content: '   ' })).ok).toBe(false)
    expect((await db.diary.get(id))?.content).toBe('aaa')
  })

  it('日记关着时读 / 改 / 删都拒绝', async () => {
    await allowDiary(false)
    expect((await readDiary({ id: 'x' })).ok).toBe(false)
    expect((await updateDiary({ id: 'x', title: 't' })).ok).toBe(false)
    expect((await deleteDiary({ id: 'x' })).ok).toBe(false)
  })
})
