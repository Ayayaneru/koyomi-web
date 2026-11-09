export interface ParsedEntry {
  site: string
  account: string
  secret: string
  note: string
}

export interface ParseResult {
  entries: ParsedEntry[]
  /** 字段不够、没有密码之类被丢掉的非空行 */
  skipped: number
}

/** 表头里认得的列名（小写比较） */
const ALIASES = {
  site: ['name', 'title', 'site', '名称', '标题', '站点', '网站', 'app'],
  url: ['url', 'login_uri', 'uri', 'origin', '地址', '网址', '链接'],
  account: ['username', 'user', 'login', 'login_username', 'account', 'email', '账号', '用户名', '邮箱'],
  secret: ['password', 'pass', 'login_password', 'secret', '密码'],
  note: ['note', 'notes', 'memo', 'remark', '备注', '说明']
}

/** 支持 "a,b" 这种带引号的 CSV；非 CSV 模式直接按分隔符切 */
function splitLine(line: string, delim: string): string[] {
  if (delim === ' ') return line.split(/\s+/).filter(Boolean)

  const out: string[] = []
  let current = ''
  let quoted = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        current += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === delim) {
      out.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  out.push(current)
  return out.map(item => item.trim())
}

function detectDelimiter(line: string): string {
  if (line.includes('\t')) return '\t'
  if (line.includes(',')) return ','
  return ' '
}

function pickIndex(cells: string[], names: string[]): number {
  return cells.findIndex(cell => names.includes(cell.trim().toLowerCase()))
}

/** 从 URL 里抠个能当名字的：https://mail.qq.com/login → mail.qq.com */
function hostOf(url: string): string {
  if (!url) return ''
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).host
  } catch {
    return url
  }
}

/**
 * 批量粘贴解析。认三种写法：
 * 1. 浏览器导出的 CSV（有表头，name,url,username,password,note 这种，列顺序可以乱）
 * 2. Tab / 逗号分隔的三四列，没有表头：站点, 账号, 密码, 备注
 * 3. 空格分隔：站点 账号 密码（密码里不能有空格）
 */
export function parseVaultText(raw: string): ParseResult {
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (!lines.length) return { entries: [], skipped: 0 }

  const delim = detectDelimiter(lines[0])
  const rows = lines.map(line => splitLine(line, delim))
  const first = rows[0].map(cell => cell.toLowerCase())

  const hasHeader =
    (pickIndex(first, ALIASES.secret) >= 0 && pickIndex(first, ALIASES.account) >= 0) ||
    [ALIASES.site, ALIASES.account, ALIASES.secret].filter(list => pickIndex(first, list) >= 0).length >= 2

  const siteIdx = hasHeader ? pickIndex(first, ALIASES.site) : 0
  const urlIdx = hasHeader ? pickIndex(first, ALIASES.url) : -1
  const accountIdx = hasHeader ? pickIndex(first, ALIASES.account) : 1
  const secretIdx = hasHeader ? pickIndex(first, ALIASES.secret) : 2
  const noteIdx = hasHeader ? pickIndex(first, ALIASES.note) : 3

  const cell = (row: string[], index: number): string => (index >= 0 ? (row[index] ?? '') : '')

  const entries: ParsedEntry[] = []
  let skipped = 0

  for (const row of rows.slice(hasHeader ? 1 : 0)) {
    const url = cell(row, urlIdx)
    // 没有表头又只给了两列时，按「站点 密码」理解
    const twoCol = !hasHeader && row.length === 2

    const rawSite = cell(row, siteIdx) || hostOf(url)
    const account = twoCol ? '' : cell(row, accountIdx)
    const password = twoCol ? (row[1] ?? '') : cell(row, secretIdx)

    if (!rawSite || !password) {
      skipped++
      continue
    }

    const site = rawSite.length > 60 ? rawSite.slice(0, 60) : rawSite
    const note = cell(row, noteIdx) || (url && url !== site ? url : '')
    entries.push({ site, account, secret: password, note })
  }

  return { entries, skipped }
}
