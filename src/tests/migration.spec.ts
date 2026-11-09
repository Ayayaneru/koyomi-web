import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * v1 → v2 的迁移只加表，不能碰旧数据。
 * 用和 core/db.ts 相同的 stores 声明跑一遍：v1 写入 → 用 v2 打开 → 数据还在。
 */

const NAME = 'koyomi-migration-test'

const V1_STORES = {
  events: 'id, startAt, repeatUntil',
  tasks: 'id, dueAt, enabled',
  taskLogs: 'id, taskId, doneAt',
  diary: 'id, date',
  config: 'id',
  vaultEntries: 'id'
}

afterAll(async () => {
  await Dexie.delete(NAME)
})

describe('Dexie 迁移', () => {
  it('v2 加表之后，v1 的数据还在', async () => {
    const v1 = new Dexie(NAME)
    v1.version(1).stores(V1_STORES)
    await v1.table('events').add({ id: 'ev_1', title: '老数据', startAt: 1, endAt: 2 })
    await v1.table('config').put({ id: 'app', llm: { apiKey: 'sk-old' } })
    v1.close()

    const v2 = new Dexie(NAME)
    v2.version(1).stores(V1_STORES)
    v2.version(2).stores({ holidayCache: 'year' })
    await v2.open()

    expect(await v2.table('events').count()).toBe(1)
    expect((await v2.table('events').get('ev_1'))?.title).toBe('老数据')
    expect((await v2.table('config').get('app'))?.llm.apiKey).toBe('sk-old')
    expect(await v2.table('holidayCache').count()).toBe(0)

    await v2.table('holidayCache').put({ year: 2026, days: {}, sourceUrl: 'x', updatedAt: 1 })
    expect((await v2.table('holidayCache').get(2026))?.year).toBe(2026)
    v2.close()
  })
})
