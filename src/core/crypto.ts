/* 主密码派生与加解密 */

/** OWASP 对 PBKDF2-SHA256 的下限建议；真机实测后再决定是否下调 */
export const ITERATIONS = 600_000

export type Bytes = Uint8Array<ArrayBuffer>

export function randomBytes(n: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(n))
}

export function b64(bytes: Uint8Array): string {
  let s = ''
  for (const byte of bytes) s += String.fromCharCode(byte)
  return btoa(s)
}

export function unb64(text: string): Bytes {
  const raw = atob(text)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${b64(randomBytes(6)).replace(/[+/=]/g, '').slice(0, 4)}`
}

export async function deriveKey(password: string, salt: Bytes, iterations = ITERATIONS): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveKey'
  ])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false, // 不可导出：JS 拿不到原始字节
    ['encrypt', 'decrypt']
  )
}

/** 每条独立 IV（AES-GCM 硬要求） */
export async function encryptText(key: CryptoKey, text: string): Promise<{ iv: string; data: string }> {
  const iv = randomBytes(12)
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text))
  return { iv: b64(iv), data: b64(new Uint8Array(cipher)) }
}

export async function decryptText(key: CryptoKey, iv: string, data: string): Promise<string> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(data))
  return new TextDecoder().decode(plain)
}

/** 解锁失败与文件损坏都会走到这里，界面上统一提示「主密码不对或文件损坏」 */
export async function tryDecrypt(key: CryptoKey, iv: string, data: string): Promise<string | null> {
  try {
    return await decryptText(key, iv, data)
  } catch {
    return null
  }
}
