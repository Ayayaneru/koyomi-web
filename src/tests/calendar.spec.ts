import { afterEach, describe, expect, it } from 'vitest'
import { clearLunarCache, lunarLabel, lunarOf } from '../core/lunar'
import { addDays, dayStart, fmtDate, monthCells, sundayOf } from '../core/time'
import { solarTermOf } from '../core/solarTerms'
import {
  applyRemoteYear,
  dropRemoteYear,
  getYearData,
  holidayLabel,
  holidayOf,
  parseHolidayCn
} from '../features/schedule/holidays'

const at = (text: string) => dayStart(new Date(`${text}T12:00:00`).getTime())

describe('农历（Intl 中国历）', () => {
  it('春节、中秋、普通日子', () => {
    clearLunarCache()
    expect(lunarOf(at('2026-02-17'))).toMatchObject({ month: '正月', day: 1, label: '正月', isFirstDay: true })
    expect(lunarOf(at('2026-09-25'))).toMatchObject({ month: '八月', day: 15, label: '十五' })
    expect(lunarOf(at('2026-10-27'))).toMatchObject({ month: '九月', day: 18, label: '十八' })
  })

  it('月底是廿三、三十这类写法', () => {
    expect(lunarLabel(at('2026-12-31'))).toBe('廿三')
    expect(lunarLabel(at('2027-02-06'))).toBe('三十')
  })

  it('同一天取两次结果一致（按天缓存）', () => {
    const ts = at('2026-10-27')
    expect(lunarOf(ts)).toEqual(lunarOf(ts))
  })

  it('端午那天确实是五月初五', () => {
    expect(lunarOf(at('2026-06-19'))).toMatchObject({ month: '五月', day: 5 })
  })
})

describe('节假日与调休（2026 国办通知）', () => {
  it('元旦、春节、国庆是放假', () => {
    expect(holidayOf(at('2026-01-01'))).toEqual({ kind: 'off', name: '元旦' })
    // 节日名统一标在放假段第一天（春节假期从 2/15 开始）
    expect(holidayOf(at('2026-02-15'))).toEqual({ kind: 'off', name: '春节' })
    expect(holidayOf(at('2026-02-17'))).toEqual({ kind: 'off', name: undefined })
    expect(holidayOf(at('2026-10-01'))).toEqual({ kind: 'off', name: '国庆节' })
  })

  it('放假区间里非节日当天只有休、不重复节日名', () => {
    expect(holidayOf(at('2026-02-16'))).toEqual({ kind: 'off', name: undefined })
    expect(holidayLabel(at('2026-02-16'))).toBe('休')
  })

  it('调休上班日标成 work', () => {
    expect(holidayOf(at('2026-01-04'))).toEqual({ kind: 'work' })
    expect(holidayLabel(at('2026-02-14'))).toBe('班')
    expect(holidayLabel(at('2026-10-10'))).toBe('班')
  })

  it('普通日子没有标记', () => {
    expect(holidayOf(at('2026-10-08'))).toBeUndefined()
    expect(holidayLabel(at('2026-10-08'))).toBe('')
  })

  it('没有数据的年份不猜', () => {
    expect(holidayOf(at('2025-10-01'))).toBeUndefined()
    expect(holidayOf(at('2027-10-01'))).toBeUndefined()
  })

  it('全年放假 33 天、调休上班 6 天（按国办 2026 通知核对）', () => {
    let off = 0
    let work = 0
    let day = at('2026-01-01')
    const end = at('2027-01-01')
    while (day < end) {
      const info = holidayOf(day)
      if (info?.kind === 'off') off++
      if (info?.kind === 'work') work++
      day = addDays(day, 1)
    }
    expect({ off, work }).toEqual({ off: 33, work: 6 })
  })

  it('每个节日名都落在对应的日子上', () => {
    const names = new Map<string, string>()
    for (const date of ['2026-01-01', '2026-02-15', '2026-04-04', '2026-05-01', '2026-06-19', '2026-09-25', '2026-10-01']) {
      names.set(fmtDate(at(date)), holidayOf(at(date))?.name ?? '')
    }
    expect([...names.values()]).toEqual(['元旦', '春节', '清明', '劳动节', '端午节', '中秋节', '国庆节'])
  })
})


describe('联网数据解析（holiday-cn）', () => {
  const raw = {
    year: 2027,
    papers: ['https://www.gov.cn/x.htm'],
    days: [
      { name: '元旦', date: '2027-01-01', isOffDay: true },
      { name: '元旦', date: '2027-01-02', isOffDay: true },
      { name: '元旦', date: '2027-01-03', isOffDay: true },
      { name: '元旦', date: '2027-01-09', isOffDay: false },
      { name: '春节', date: '2027-02-05', isOffDay: true },
      { name: '春节', date: '2027-02-06', isOffDay: true }
    ]
  }

  afterEach(() => {
    dropRemoteYear(2027)
    dropRemoteYear(2026)
  })

  it('解析成 map，节日名只在每段第一天', () => {
    const data = parseHolidayCn(raw)
    expect(data.year).toBe(2027)
    expect(data.source).toBe('remote')
    expect(Object.keys(data.days)).toHaveLength(6)
    expect(data.days['2027-01-01']).toEqual({ kind: 'off', name: '元旦' })
    expect(data.days['2027-01-02']).toEqual({ kind: 'off' })
    expect(data.days['2027-01-09']).toEqual({ kind: 'work' })
    expect(data.days['2027-02-05']).toEqual({ kind: 'off', name: '春节' })
    expect(data.days['2027-02-06']).toEqual({ kind: 'off' })
  })

  it('应用后覆盖内置；删掉后回到内置', () => {
    const data = parseHolidayCn({
      year: 2026,
      days: [{ name: '国庆节', date: '2026-10-01', isOffDay: false }]
    })
    applyRemoteYear(data)
    expect(holidayOf(at('2026-10-01'))).toEqual({ kind: 'work' })
    expect(getYearData(2026)?.source).toBe('remote')

    dropRemoteYear(2026)
    expect(holidayOf(at('2026-10-01'))?.kind).toBe('off')
    expect(getYearData(2026)?.source).toBe('builtin')
  })

  it('空 days 不报错（代表今年还没公布）', () => {
    const data = parseHolidayCn({ year: 2027, days: [] })
    expect(Object.keys(data.days)).toHaveLength(0)
  })

  it('结构不对就抛错', () => {
    expect(() => parseHolidayCn({ days: [] })).toThrow()
    expect(() => parseHolidayCn({ year: 2027, days: 'x' })).toThrow()
    expect(() => parseHolidayCn({ year: 2027, days: [{ date: 'x' }] })).toThrow()
  })
})


describe('周日开头（2026-11-01 改）', () => {
  it('sundayOf 把任意一天归到当周周日', () => {
    // 2026-11-05 是周四
    expect(new Date(sundayOf(new Date('2026-11-05T12:00:00').getTime())).getDate()).toBe(1)
    // 周日自己还是自己
    expect(new Date(sundayOf(new Date('2026-11-01T08:00:00').getTime())).getDate()).toBe(1)
  })

  it('月历第一格是周日', () => {
    const cells = monthCells(new Date('2026-11-15T00:00:00').getTime())
    expect(new Date(cells[0].ts).getDay()).toBe(0)
    expect(cells).toHaveLength(42)
  })
})


describe('二十四节气', () => {
  it('2026 年的几个已知日子', () => {
    expect(solarTermOf(new Date('2026-02-04T12:00:00').getTime())).toBe('立春')
    expect(solarTermOf(new Date('2026-11-22T12:00:00').getTime())).toBe('小雪')
    expect(solarTermOf(new Date('2026-12-22T12:00:00').getTime())).toBe('冬至')
  })

  it('不是节气返回 null', () => {
    expect(solarTermOf(new Date('2026-11-21T12:00:00').getTime())).toBeNull()
  })
})
