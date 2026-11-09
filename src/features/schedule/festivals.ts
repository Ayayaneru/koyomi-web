import { addDays } from '../../core/time'
import { lunarOf } from '../../core/lunar'

/**
 * 法定节假日之外「可以自己选」的节日（月历上显示名字）。
 * 分三组：传统 / 国外 / 纪念日。默认只开传统里最常见的几个，别的去设置里勾。
 * 只收录规则明确、每年都能算准的：农历固定日、公历固定日、某月第 N 个星期几。
 */

export type FestivalGroup = 'traditional' | 'foreign' | 'other'

export interface FestivalGroupDef {
  key: FestivalGroup
  name: string
}

export const FESTIVAL_GROUPS: FestivalGroupDef[] = [
  { key: 'traditional', name: '传统节日' },
  { key: 'foreign', name: '国外节日' },
  { key: 'other', name: '纪念日' }
]

export type FestivalRule =
  | { kind: 'lunar'; month: string; day: number }
  | { kind: 'solar'; month: number; day: number }
  | { kind: 'nth-weekday'; month: number; weekday: number; nth: number }
  | { kind: 'lunar-eve' }

export interface FestivalDef {
  key: string
  name: string
  group: FestivalGroup
  rule: FestivalRule
  hint: string
}

export const FESTIVALS: FestivalDef[] = [
  /* 传统 */
  { key: 'chuxi', name: '除夕', group: 'traditional', rule: { kind: 'lunar-eve' }, hint: '正月初一前一天' },
  { key: 'yuanxiao', name: '元宵', group: 'traditional', rule: { kind: 'lunar', month: '正月', day: 15 }, hint: '正月十五' },
  { key: 'longtaitou', name: '龙抬头', group: 'traditional', rule: { kind: 'lunar', month: '二月', day: 2 }, hint: '二月初二' },
  { key: 'qixi', name: '七夕', group: 'traditional', rule: { kind: 'lunar', month: '七月', day: 7 }, hint: '七月初七' },
  { key: 'zhongyuan', name: '中元', group: 'traditional', rule: { kind: 'lunar', month: '七月', day: 15 }, hint: '七月十五' },
  { key: 'chongyang', name: '重阳', group: 'traditional', rule: { kind: 'lunar', month: '九月', day: 9 }, hint: '九月初九' },
  { key: 'laba', name: '腊八', group: 'traditional', rule: { kind: 'lunar', month: '腊月', day: 8 }, hint: '腊月初八' },
  {
    key: 'xiaonian',
    name: '小年',
    group: 'traditional',
    rule: { kind: 'lunar', month: '腊月', day: 23 },
    hint: '腊月廿三（北方小年）'
  },

  /* 国外 */
  { key: 'valentine', name: '情人节', group: 'foreign', rule: { kind: 'solar', month: 2, day: 14 }, hint: '2 月 14 日' },
  { key: 'aprilfool', name: '愚人节', group: 'foreign', rule: { kind: 'solar', month: 4, day: 1 }, hint: '4 月 1 日' },
  {
    key: 'mother',
    name: '母亲节',
    group: 'foreign',
    rule: { kind: 'nth-weekday', month: 5, weekday: 0, nth: 2 },
    hint: '5 月第 2 个周日'
  },
  {
    key: 'father',
    name: '父亲节',
    group: 'foreign',
    rule: { kind: 'nth-weekday', month: 6, weekday: 0, nth: 3 },
    hint: '6 月第 3 个周日'
  },
  { key: 'halloween', name: '万圣夜', group: 'foreign', rule: { kind: 'solar', month: 10, day: 31 }, hint: '10 月 31 日' },
  {
    key: 'thanksgiving',
    name: '感恩节',
    group: 'foreign',
    rule: { kind: 'nth-weekday', month: 11, weekday: 4, nth: 4 },
    hint: '11 月第 4 个周四'
  },
  {
    key: 'christmaseve',
    name: '平安夜',
    group: 'foreign',
    rule: { kind: 'solar', month: 12, day: 24 },
    hint: '12 月 24 日'
  },
  { key: 'christmas', name: '圣诞节', group: 'foreign', rule: { kind: 'solar', month: 12, day: 25 }, hint: '12 月 25 日' },

  /* 纪念日 */
  { key: 'womensday', name: '妇女节', group: 'other', rule: { kind: 'solar', month: 3, day: 8 }, hint: '3 月 8 日' },
  { key: 'childrensday', name: '儿童节', group: 'other', rule: { kind: 'solar', month: 6, day: 1 }, hint: '6 月 1 日' },
  { key: 'teachersday', name: '教师节', group: 'other', rule: { kind: 'solar', month: 9, day: 10 }, hint: '9 月 10 日' }
]

/** 默认只开传统里最常见的五个；其他组要自己去设置里勾 */
export const DEFAULT_FESTIVALS = ['chuxi', 'yuanxiao', 'qixi', 'chongyang', 'laba']

function matches(rule: FestivalRule, ts: number, date: Date, month: string, day: number): boolean {
  switch (rule.kind) {
    case 'lunar':
      return month === rule.month && day === rule.day
    case 'solar':
      return date.getMonth() + 1 === rule.month && date.getDate() === rule.day
    case 'nth-weekday':
      return (
        date.getMonth() + 1 === rule.month &&
        date.getDay() === rule.weekday &&
        Math.ceil(date.getDate() / 7) === rule.nth
      )
    case 'lunar-eve': {
      const next = lunarOf(addDays(ts, 1))
      return next?.month === '正月' && next.day === 1
    }
    default:
      return false
  }
}

/** 这一天是哪个（已启用的）节日；没有就返回空串 */
export function festivalOf(ts: number, enabled: Iterable<string>): string {
  const keys = new Set(enabled)
  if (!keys.size) return ''

  const info = lunarOf(ts)
  const date = new Date(ts)
  for (const def of FESTIVALS) {
    if (!keys.has(def.key)) continue
    if (matches(def.rule, ts, date, info?.month ?? '', info?.day ?? 0)) return def.name
  }
  return ''
}
