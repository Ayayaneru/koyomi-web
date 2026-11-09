import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../core/db'
import {
  buildVaultFile,
  fieldIv,
  importVaultFile,
  lockVault,
  migrateSiteNames,
  readEntry,
  saveEntry,
  setupMasterPassword,
  unlockVault,
  vaultKey
} from '../features/vault/vaultFile'

const PASSWORD = 'Test123456'

beforeEach(async () => {
  await db.vaultEntries.clear()
  await db.config.clear()
  lockVault()
})

describe('密码库加解密', () => {
  it('保存后能读回来，库里存的是密文', async () => {
    await setupMasterPassword(PASSWORD)
    await saveEntry({ site: '某某银行', account: 'demo@example.com', secret: 's3cret', note: '柜台电话 123' })

    const row = await db.vaultEntries.toCollection().first()
    expect(row).toBeTruthy()
    // 名称也加密了（2026-11-02）：库里不再出现「某某银行」这串字
    expect(row?.site).toBe('')
    expect(row?.siteEnc).toBeTruthy()
    expect(JSON.stringify(row)).not.toContain('某某银行')
    expect(row?.account).not.toContain('demo@example.com')
    expect(row?.secret).not.toContain('s3cret')

    const detail = await readEntry(row!)
    expect(detail).toEqual({
      site: '某某银行',
      account: 'demo@example.com',
      secret: 's3cret',
      note: '柜台电话 123',
      broken: false
    })
  })

  it('四个字段的 IV 各不相同（不能复用）', () => {
    const base = 'AAAAAAAAAAAAAAAA' // 12 字节 base64
    const list = [fieldIv(base, 1), fieldIv(base, 2), fieldIv(base, 3), fieldIv(base, 4)]
    expect(new Set(list).size).toBe(4)
  })

  it('锁定后读不到明文', async () => {
    await setupMasterPassword(PASSWORD)
    await saveEntry({ site: 'x', account: 'a', secret: 'b', note: '' })
    const row = await db.vaultEntries.toCollection().first()
    lockVault()
    expect(vaultKey.value).toBeNull()
    await expect(readEntry(row!)).rejects.toThrow()
  })

  it('老条目的明文名称：解锁后搬进密文，读出来还是原名', async () => {
    await setupMasterPassword(PASSWORD)
    await saveEntry({ site: '某某银行', account: 'demo@example.com', secret: 's3cret', note: '' })
    const saved = await db.vaultEntries.toCollection().first()
    // 造一条 2026-11-02 之前的老数据：名称在 site、没有 siteEnc
    await db.vaultEntries.put({ ...saved!, site: '老名字银行', siteEnc: undefined })

    expect(await migrateSiteNames()).toBe(1)
    const row = await db.vaultEntries.toCollection().first()
    expect(row?.site).toBe('')
    expect(row?.siteEnc).toBeTruthy()
    expect(JSON.stringify(row)).not.toContain('老名字银行')

    const detail = await readEntry(row!)
    expect(detail.site).toBe('老名字银行')
    expect(detail.account).toBe('demo@example.com')

    // 再跑一次没什么可搬的
    expect(await migrateSiteNames()).toBe(0)
  })

  it('迁移没跑（锁着）时，老条目照样能按原字段读名称', async () => {
    await setupMasterPassword(PASSWORD)
    await saveEntry({ site: '某某银行', account: 'demo@example.com', secret: 's3cret', note: '' })
    const saved = await db.vaultEntries.toCollection().first()
    await db.vaultEntries.put({ ...saved!, site: '老名字银行', siteEnc: undefined })
    // 重新解锁，但不调用迁移
    lockVault()
    expect(await unlockVault(PASSWORD)).toBe(true)
    const row = await db.vaultEntries.toCollection().first()
    expect((await readEntry(row!)).site).toBe('老名字银行')
  })

  it('主密码换过以后：一条都不搬，明文名称留着，读的时候标成 broken', async () => {
    await setupMasterPassword('old-pass')
    await saveEntry({ site: '老名字银行', account: 'demo@example.com', secret: 's3cret', note: '' })
    const saved = await db.vaultEntries.toCollection().first()
    // 老格式 + 换过一次主密码：库里的密文是旧密钥的，salt 已经变了
    await db.vaultEntries.put({ ...saved!, site: '老名字银行', siteEnc: undefined })
    await setupMasterPassword('new-pass')

    expect(await migrateSiteNames()).toBe(0)
    const row = await db.vaultEntries.toCollection().first()
    expect(row?.site).toBe('老名字银行') // 没被洗掉
    expect(row?.siteEnc).toBeUndefined()

    const detail = await readEntry(row!)
    expect(detail.broken).toBe(true)
    expect(detail.site).toBe('老名字银行') // 名称还能看懂
    expect(detail.account).toBe('')
  })

  it('密码不对解不开，密码对了能解开', async () => {
    await setupMasterPassword(PASSWORD)
    await saveEntry({ site: 'x', account: 'a', secret: 'b', note: '' })
    lockVault()

    expect(await unlockVault('wrong-password')).toBe(false)
    expect(vaultKey.value).toBeNull()
    expect(await unlockVault(PASSWORD)).toBe(true)
  })
})

describe('加密库导出与导入', () => {
  it('导出的文件里没有明文，导入后能读', async () => {
    await setupMasterPassword(PASSWORD)
    await saveEntry({ site: '邮箱', account: 'me@example.com', secret: 'p@ss', note: '' })
    const file = await buildVaultFile()

    expect(file.format).toBe('koyomi-vault')
    expect(file.salt).toBeTruthy()
    expect(file.iterations).toBeGreaterThan(0)
    expect(JSON.stringify(file)).not.toContain('me@example.com')
    expect(JSON.stringify(file)).not.toContain('邮箱')

    // 模拟换设备：本机库清空
    await db.vaultEntries.clear()
    await db.config.clear()
    lockVault()

    const result = await importVaultFile(file, PASSWORD)
    expect(result.count).toBe(1)
    const row = await db.vaultEntries.toCollection().first()
    expect((await readEntry(row!)).secret).toBe('p@ss')
  })

  it('密码不对时整体拒绝，不写半份数据', async () => {
    await setupMasterPassword(PASSWORD)
    await saveEntry({ site: '邮箱', account: 'me@example.com', secret: 'p@ss', note: '' })
    const file = await buildVaultFile()

    await db.vaultEntries.clear()
    await db.config.clear()
    lockVault()

    await expect(importVaultFile(file, 'wrong-password')).rejects.toThrow()
    expect(await db.vaultEntries.count()).toBe(0)
  })
})
