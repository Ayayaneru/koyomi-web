import { shallowRef } from 'vue'
import { db, getConfig, patchConfig, type VaultEntry } from '../../core/db'
import { b64, decryptText, deriveKey, ITERATIONS, newId, randomBytes, tryDecrypt, unb64 } from '../../core/crypto'
import { saveTextFile } from '../../core/saveFile'
import { stamp } from '../../core/time'

/**
 * 密码库。这个文件不导出任何 AppTool，模型在代码层面就拿不到它。
 * 密钥只活在内存里：刷新页面、点锁定都会清空。
 */

export const vaultKey = shallowRef<CryptoKey | null>(null)

export async function hasMasterPassword(): Promise<boolean> {
  const cfg = await getConfig()
  return Boolean(cfg.vaultSalt)
}

export async function setupMasterPassword(password: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  await patchConfig({ vaultSalt: b64(salt) })
  vaultKey.value = await deriveKey(password, salt)
}

export async function unlockVault(password: string): Promise<boolean> {
  const cfg = await getConfig()
  if (!cfg.vaultSalt) return false
  const key = await deriveKey(password, unb64(cfg.vaultSalt))
  const first = await db.vaultEntries.toCollection().first()
  if (!first) {
    vaultKey.value = key
    return true
  }
  try {
    await decryptText(key, fieldIv(first.iv, 1), first.account || first.secret)
    vaultKey.value = key
    return true
  } catch {
    return false
  }
}

export function lockVault(): void {
  vaultKey.value = null
}

/**
 * 一条记录只存一个 iv，但几个字段不能共用同一个 IV —— GCM 下复用 IV
 * 会直接破坏安全性。做法是拿记录 IV 派生出几个子 IV（只改最后一个字节），
 * 这样仍然只存一个 iv 字段，每个字段的 IV 又各不相同。
 * 1 = 账号、2 = 密码、3 = 备注、4 = 名称（2026-11-02 加的）
 */
export function fieldIv(ivB64: string, tag: 1 | 2 | 3 | 4): string {
  const iv = unb64(ivB64)
  iv[iv.length - 1] ^= tag
  return b64(iv)
}

export interface EntryInput {
  site: string
  account: string
  secret: string
  note: string
}

/** 读出来的一条；broken = 账号/密码解不开（通常是这个库不是当前主密码加密的） */
export interface EntryRead extends EntryInput {
  broken: boolean
}

async function encryptWith(key: CryptoKey, ivB64: string, text: string): Promise<string> {
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: unb64(ivB64) },
    key,
    new TextEncoder().encode(text)
  )
  return b64(new Uint8Array(cipher))
}

export async function readEntry(entry: VaultEntry): Promise<EntryRead> {
  const key = vaultKey.value
  if (!key) throw new Error('密码库未解锁')
  // 名称有密文就用密文；解不开（比如中途换过主密码）就回落到明文列，
  // 不让一个字段把整条记录带崩（2026-11-02）
  const site = entry.siteEnc
    ? ((await tryDecrypt(key, fieldIv(entry.iv, 4), entry.siteEnc)) ?? entry.site)
    : entry.site
  const account = await tryDecrypt(key, fieldIv(entry.iv, 1), entry.account)
  const secret = await tryDecrypt(key, fieldIv(entry.iv, 2), entry.secret)
  const note = entry.note ? await tryDecrypt(key, fieldIv(entry.iv, 3), entry.note) : ''
  return {
    site,
    account: account ?? '',
    secret: secret ?? '',
    note: note ?? '',
    broken: account === null || secret === null
  }
}

/**
 * 当前内存里的密钥能不能解开这个库：拿第一条有内容的记录试一次，只读不写。
 * 主密码中途换过（salt 变了）时会是 false —— 这时候任何写操作都可能毁掉还能看懂的数据。
 */
export async function vaultKeyMatches(rows: VaultEntry[]): Promise<boolean> {
  const key = vaultKey.value
  if (!key) return false
  const probe = rows.find(row => row.account || row.secret)
  if (!probe) return true // 空库，没什么可验的
  try {
    await decryptText(key, fieldIv(probe.iv, 1), probe.account || probe.secret)
    return true
  } catch {
    return false
  }
}

/** 每次保存都换一个新的记录 IV，三个字段再各自派生子 IV */
export async function saveEntry(input: EntryInput, id?: string): Promise<void> {
  const key = vaultKey.value
  if (!key) throw new Error('密码库未解锁')
  if (!input.site.trim()) throw new Error('名称不能为空')
  const ivB64 = b64(randomBytes(12))

  const row: VaultEntry = {
    id: id ?? newId('vt'),
    // 名称也加密：库里不再明文留「你有哪些站点」
    site: '',
    siteEnc: await encryptWith(key, fieldIv(ivB64, 4), input.site.trim()),
    account: await encryptWith(key, fieldIv(ivB64, 1), input.account),
    secret: await encryptWith(key, fieldIv(ivB64, 2), input.secret),
    note: await encryptWith(key, fieldIv(ivB64, 3), input.note),
    iv: ivB64,
    updatedAt: Date.now()
  }
  await db.vaultEntries.put(row)
}

/**
 * 把老条目的明文名称搬进 siteEnc（2026-11-02）。
 *
 * 只在解锁后跑得动（要密钥）。逐条「先写密文、再清明文」，中途失败最多是某几条还没搬，
 * 读的时候会回落到 site，不会出现「名称变空白」。
 * 返回搬了几条，0 表示没什么可搬的。
 */
export async function migrateSiteNames(): Promise<number> {
  const key = vaultKey.value
  if (!key) return 0
  const rows = await db.vaultEntries.toArray()
  // 密钥对不上就一条都不动：名称留在明文列，人至少还看得懂自己在哪存过什么。
  // （2026-11-02 修：原来不管密钥对不对都照搬，结果把明文名称洗成了读不出来的密文）
  if (!(await vaultKeyMatches(rows))) return 0
  let moved = 0
  for (const row of rows) {
    if (row.siteEnc || !row.site) continue
    const siteEnc = await encryptWith(key, fieldIv(row.iv, 4), row.site)
    await db.vaultEntries.put({ ...row, site: '', siteEnc })
    moved++
  }
  return moved
}

export async function deleteEntry(id: string): Promise<void> {
  await db.vaultEntries.delete(id)
}

/* ============ 加密库导出与导入 ============ */

export interface VaultFile {
  format: 'koyomi-vault'
  exportedAt: string
  salt: string
  iterations: number
  entries: VaultEntry[]
}

export async function buildVaultFile(): Promise<VaultFile> {
  const cfg = await getConfig()
  if (!cfg.vaultSalt) throw new Error('还没设置主密码')
  return {
    format: 'koyomi-vault',
    exportedAt: new Date().toISOString(),
    salt: cfg.vaultSalt,
    iterations: ITERATIONS,
    entries: await db.vaultEntries.toArray()
  }
}

/** 导出加密库：浏览器下载 / APK 走系统分享（见 core/saveFile.ts） */
export async function downloadVault(file: VaultFile): Promise<void> {
  await saveTextFile(`koyomi-vault-${stamp()}.json`, JSON.stringify(file, null, 2))
}

export interface VaultImportResult {
  count: number
}

/** 先试解密第一条，成功才整体导入 */
export async function importVaultFile(payload: unknown, password: string): Promise<VaultImportResult> {
  const file = payload as Partial<VaultFile>
  if (file?.format !== 'koyomi-vault') throw new Error('不是 Koyomi 的密码库文件')
  const entries = Array.isArray(file.entries) ? file.entries : []
  if (!file.salt) throw new Error('文件缺少 salt，无法解密')
  const iterations = Number(file.iterations) || ITERATIONS
  const key = await deriveKey(password, unb64(file.salt), iterations)

  if (entries.length) {
    const first = entries[0]
    try {
      await decryptText(key, fieldIv(first.iv, 1), first.account || first.secret)
    } catch {
      throw new Error('主密码不对或文件损坏')
    }
  }

  await db.transaction('rw', db.vaultEntries, db.config, async () => {
    await db.vaultEntries.clear()
    if (entries.length) await db.vaultEntries.bulkAdd(entries as VaultEntry[])
    await patchConfig({ vaultSalt: file.salt })
  })
  vaultKey.value = key
  return { count: entries.length }
}
