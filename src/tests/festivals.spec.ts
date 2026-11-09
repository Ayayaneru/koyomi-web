import { describe, expect, it } from 'vitest'
import { dayStart } from '../core/time'
import { DEFAULT_FESTIVALS, FESTIVALS, festivalOf } from '../features/schedule/festivals'

const at = (text: string) => dayStart(new Date(`${text}T12:00:00`).getTime())

const ALL = FESTIVALS.map(f => f.key)

describe('可选节日', () => {
  it('2026 年各节日的公历日期', () => {
    expect(festivalOf(at('2026-02-16'), ALL)).toBe('除夕')
    expect(festivalOf(at('2026-03-03'), ALL)).toBe('元宵')
    expect(festivalOf(at('2026-08-19'), ALL)).toBe('七夕')
    expect(festivalOf(at('2026-10-18'), ALL)).toBe('重阳')
    expect(festivalOf(at('2026-01-26'), ALL)).toBe('腊八')
  })

  it('公历节日与「第 N 个周日」', () => {
    expect(festivalOf(at('2026-02-14'), ALL)).toBe('情人节')
    expect(festivalOf(at('2026-05-10'), ALL)).toBe('母亲节')
    expect(festivalOf(at('2026-06-21'), ALL)).toBe('父亲节')
    // 不是第 2 个周日的 5 月周日不算母亲节
    expect(festivalOf(at('2026-05-17'), ALL)).toBe('')
  })

  it('只返回启用中的节日', () => {
    const onlyQixi = ['qixi']
    expect(festivalOf(at('2026-08-19'), onlyQixi)).toBe('七夕')
    expect(festivalOf(at('2026-03-03'), onlyQixi)).toBe('')
    expect(festivalOf(at('2026-02-16'), [])).toBe('')
  })

  it('默认只开传统五个，情人节/母亲节/父亲节要手动开', () => {
    expect(DEFAULT_FESTIVALS).toEqual(['chuxi', 'yuanxiao', 'qixi', 'chongyang', 'laba'])
    expect(festivalOf(at('2026-02-14'), DEFAULT_FESTIVALS)).toBe('')
    expect(festivalOf(at('2026-02-16'), DEFAULT_FESTIVALS)).toBe('除夕')
  })

  it('跨年也对：2027 除夕是 2/6', () => {
    expect(festivalOf(at('2027-02-06'), ALL)).toBe('除夕')
    expect(festivalOf(at('2027-02-07'), ALL)).toBe('')
  })
})
