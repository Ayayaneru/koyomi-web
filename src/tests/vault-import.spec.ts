import { describe, expect, it } from 'vitest'
import { parseVaultText } from '../features/vault/vaultImport'

describe('批量粘贴解析', () => {
  it('浏览器导出的 CSV（有表头，带引号）', () => {
    const csv = [
      'name,url,username,password,note',
      'GitHub,https://github.com/login,me@example.com,"pa,ss""1",工作',
      '邮箱,https://mail.qq.com,me@qq.com,qq123456,'
    ].join('\r\n')

    const { entries, skipped } = parseVaultText(csv)
    expect(skipped).toBe(0)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({
      site: 'GitHub',
      account: 'me@example.com',
      secret: 'pa,ss"1',
      note: '工作'
    })
    // 备注空的时候把网址记下来，方便回头找
    expect(entries[1].note).toBe('https://mail.qq.com')
  })

  it('中文表头也认', () => {
    const { entries } = parseVaultText('名称,账号,密码\n淘宝,me@example.com,tb123\n')
    expect(entries[0]).toEqual({ site: '淘宝', account: 'me@example.com', secret: 'tb123', note: '' })
  })

  it('没有表头：Tab 分隔的三列', () => {
    const { entries } = parseVaultText('微博\tme@example.com\twb888\n知乎\tme@example.com\tzh999')
    expect(entries.map(e => e.site)).toEqual(['微博', '知乎'])
    expect(entries[0].secret).toBe('wb888')
  })

  it('没有表头：空格分隔', () => {
    const { entries } = parseVaultText('B站 me@example.com pass123')
    expect(entries[0]).toMatchObject({ site: 'B站', account: 'me@example.com', secret: 'pass123' })
  })

  it('只有两列时按「站点 密码」理解', () => {
    const { entries } = parseVaultText('路由器,admin888')
    expect(entries[0]).toEqual({ site: '路由器', account: '', secret: 'admin888', note: '' })
  })

  it('只有网址没有名字时，拿域名当名字', () => {
    const { entries } = parseVaultText('url,username,password\nhttps://mail.qq.com/login,me@qq.com,abc')
    expect(entries[0].site).toBe('mail.qq.com')
  })

  it('少密码、空行、只有一列的行都跳过并计数', () => {
    const { entries, skipped } = parseVaultText('站点\t账号\t密码\n只有一列\n微博\tme\t\n\n淘宝\tme\ttb1')
    expect(entries).toHaveLength(1)
    expect(skipped).toBe(2)
  })

  it('空文本返回空', () => {
    expect(parseVaultText('   \n\n ')).toEqual({ entries: [], skipped: 0 })
  })
})
