import { describe, expect, it } from 'vitest'
import { renameTagInText, splitTags } from '../features/vault/diaryTags'

describe('日记标签文本', () => {
  it('拆得开中英文逗号、空格和 # 前缀', () => {
    expect(splitTags('工作, #生活 读书')).toEqual(['工作', '生活', '读书'])
    expect(splitTags('')).toEqual([])
    expect(splitTags(undefined)).toEqual([])
  })

  it('改名时只替换整词', () => {
    expect(renameTagInText('工作,生活', '工作', '工作事项')).toBe('工作事项,生活')
    // '工作事项' 里虽然有「工作」两个字，但它不是这个词
    expect(renameTagInText('工作事项,生活', '工作', '杂事')).toBeNull()
  })

  it('改完和同一条里的标签重名就去重', () => {
    expect(renameTagInText('工作,生活', '工作', '生活')).toBe('生活')
  })

  it('不含旧名字时返回 null，调用方据此跳过', () => {
    expect(renameTagInText('生活', '工作', '杂事')).toBeNull()
    expect(renameTagInText('', '工作', '杂事')).toBeNull()
  })

  it('输出统一成英文逗号，界面存的还是老格式', () => {
    expect(renameTagInText('工作，生活', '生活', '读书')).toBe('工作,读书')
  })
})
