import { describe, expect, it } from 'vitest'
import { defaultConfig } from '../core/db'
import {
  draftToEventRow,
  normalizeDate,
  normalizeTime,
  parseCourseJson,
  parseCourseJsonDetailed,
  parseParity,
  parseWeekday,
  repairJson,
  resolveVisionConfig,
  VlmJsonError,
  visionFallback
} from '../features/schedule/importVlm'

/** 固定「今天」= 2026-10-31 周六，只给周几时才能断言具体日期 */
const NOW = new Date('2026-10-31T10:00:00').getTime()

/* 五份「模型可能返回的」响应，最后一份故意坏掉 */

const RESPONSE_PLAIN = JSON.stringify({
  items: [
    { title: '考研英语 词汇(18-1)', date: '2026-10-06', start: '20:00', end: '21:30', location: '', repeat: 'none' },
    { title: '考研政治 精讲(18-2)', date: '2026.10.7', time: '20:00-21:30', location: '线上' }
  ]
})

const RESPONSE_ARRAY = JSON.stringify([
  { name: '整理书架', day: '2026/10/08', section: '14:00-15:40', room: '家' }
])

const RESPONSE_FENCED = `好的，我逐条读出来了：
\`\`\`json
{"items":[{"title":"智能传感与检测技术2026","date":"2026-11-08","start":"14:00","end":"17:40","repeat":"weekly","until":"2026-12-27"}]}
\`\`\`
如果还有看不清的地方可以再拍一张。`

const RESPONSE_WEEKDAY_ONLY = JSON.stringify({
  items: [{ title: '体育', weekday: 2, periods: '9-10' }]
})

const RESPONSE_BROKEN = '{"items": [{"title": "高数", "date": "2026-10-06",'

describe('VLM 返回解析', () => {
  it('标准对象外形：逐条单次日程', () => {
    const list = parseCourseJson(RESPONSE_PLAIN, NOW)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({
      title: '考研英语 词汇(18-1)',
      date: '2026-10-06',
      startTime: '20:00',
      endTime: '21:30',
      repeat: 'none'
    })
    // "2026.10.7" + "20:00-21:30" 这种混写也要认
    expect(list[1]).toMatchObject({ date: '2026-10-07', startTime: '20:00', endTime: '21:30', location: '线上' })
  })

  it('裸数组外形', () => {
    const list = parseCourseJson(RESPONSE_ARRAY, NOW)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ title: '整理书架', date: '2026-10-08', startTime: '14:00', endTime: '15:40' })
  })

  it('带说明文字和代码围栏 + 每周重复', () => {
    const list = parseCourseJson(RESPONSE_FENCED, NOW)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      title: '智能传感与检测技术2026',
      date: '2026-11-08',
      repeat: 'weekly',
      until: '2026-12-27'
    })
  })

  it('只给了周几和节次：落到最近的周几 + 按作息表换算', () => {
    const list = parseCourseJson(RESPONSE_WEEKDAY_ONLY, NOW)
    expect(list[0]).toMatchObject({ date: '2026-11-03', startTime: '19:00', endTime: '20:40' })
  })

  it('坏 JSON 必须报错，不能静默返回空', () => {
    expect(() => parseCourseJson(RESPONSE_BROKEN, NOW)).toThrow()
  })

  it('缺标题或缺日期的行被跳过并计数', () => {
    const result = parseCourseJsonDetailed(
      JSON.stringify({
        items: [
          { title: '正常的', date: '2026-10-06' },
          { date: '2026-10-07' },
          { title: '', date: '2026-10-08' },
          { title: '没日期' }
        ]
      }),
      NOW
    )
    expect(result.items).toHaveLength(1)
    expect(result.skipped).toBe(3)
  })

  it('全是坏行时报错', () => {
    expect(() => parseCourseJson(JSON.stringify({ items: [{ title: '', date: '' }] }), NOW)).toThrow()
  })

  it('结果按日期时间排好', () => {
    const list = parseCourseJson(
      JSON.stringify({
        items: [
          { title: '晚的', date: '2026-10-08', start: '20:00' },
          { title: '早的', date: '2026-10-06', start: '08:00' }
        ]
      }),
      NOW
    )
    expect(list.map(i => i.title)).toEqual(['早的', '晚的'])
  })
})

describe('字段归一', () => {
  it('日期认点号、斜杠、中文', () => {
    expect(normalizeDate('2026.10.06', NOW)).toBe('2026-10-06')
    expect(normalizeDate('2026/10/6', NOW)).toBe('2026-10-06')
    expect(normalizeDate('10月6日', NOW)).toBe('2026-10-06')
    expect(normalizeDate('明天', NOW)).toBe('2026-11-01')
    expect(normalizeDate('看不清', NOW)).toBe('')
  })

  it('时间认冒号、汉字和紧凑数字', () => {
    expect(normalizeTime('20:00')).toBe('20:00')
    expect(normalizeTime('8点30')).toBe('08:30')
    expect(normalizeTime('0930')).toBe('09:30')
    expect(normalizeTime('')).toBe('')
  })

  it('星期支持中文与数字', () => {
    expect(parseWeekday('周三')).toBe(3)
    expect(parseWeekday('星期日')).toBe(7)
    expect(parseWeekday(5)).toBe(5)
    expect(Number.isNaN(parseWeekday('X'))).toBe(true)
  })

  it('单双周识别', () => {
    expect(parseParity('单')).toBe(1)
    expect(parseParity('双周')).toBe(2)
    expect(parseParity('无')).toBe(0)
    expect(parseParity(undefined)).toBe(0)
  })
})

describe('draftToEventRow', () => {
  it('单次日程：日期和时间原样落库，不重复', () => {
    const row = draftToEventRow({
      title: '考研英语 词汇',
      date: '2026-10-06',
      startTime: '20:00',
      endTime: '21:30',
      repeat: 'none'
    })
    const start = new Date(row.startAt)
    expect(start.getDate()).toBe(6)
    expect(start.getHours()).toBe(20)
    expect(new Date(row.endAt).getMinutes()).toBe(30)
    expect(row.repeatKind).toBe(0)
    expect(row.repeatUntil).toBeUndefined()
    expect(row.source).toBe(1)
  })

  it('每周：repeatKind = 2，repeatUntil 是最后一天的结束', () => {
    const row = draftToEventRow({
      title: '智能传感与检测技术2026',
      date: '2026-11-08',
      startTime: '14:00',
      endTime: '17:40',
      repeat: 'weekly',
      until: '2026-12-27'
    })
    expect(row.repeatKind).toBe(2)
    expect(row.weekParity).toBe(0)
    // dayEnd = 次日 0 点，12-27 这一天的课才算得进去
    expect(new Date(row.repeatUntil as number).getDate()).toBe(28)
    expect(new Date(row.repeatUntil as number).getHours()).toBe(0)
  })

  it('单双周映射到 weekParity', () => {
    const odd = draftToEventRow({
      title: '体育',
      date: '2026-10-06',
      startTime: '08:00',
      endTime: '09:40',
      repeat: 'odd'
    })
    expect(odd.repeatKind).toBe(2)
    expect(odd.weekParity).toBe(1)
  })

  it('结束时间早于开始时间时补 45 分钟，不产生负时长', () => {
    const row = draftToEventRow({
      title: '录错了',
      date: '2026-10-06',
      startTime: '10:00',
      endTime: '09:00',
      repeat: 'none'
    })
    expect(row.endAt - row.startAt).toBe(45 * 60_000)
  })
})

describe('视觉模型配置解析', () => {
  it('优先用 vlm 段', () => {
    const cfg = defaultConfig()
    cfg.llm.apiKey = 'sk-chat'
    cfg.llm.baseUrl = 'https://api.deepseek.com/v1'
    cfg.llm.model = 'deepseek-chat'
    cfg.vlm = { baseUrl: '/zhipu/api/paas/v4', model: 'glm-4v-flash', apiKey: 'sk-vlm' }
    expect(resolveVisionConfig(cfg)).toEqual({
      baseUrl: '/zhipu/api/paas/v4',
      model: 'glm-4v-flash',
      apiKey: 'sk-vlm',
      source: 'vlm'
    })
  })

  it('vlm 不完整时退回 llm（要求 supportsVision）', () => {
    const cfg = defaultConfig()
    cfg.llm = { ...cfg.llm, apiKey: 'sk-chat', model: 'gpt-4o-mini', supportsVision: true }
    cfg.vlm = { baseUrl: '', model: '', apiKey: '' }
    expect(resolveVisionConfig(cfg)?.model).toBe('gpt-4o-mini')
    // 降级来的配置要带上来源，界面才能提示「已降级」
    expect(resolveVisionConfig(cfg)?.source).toBe('llm')

    cfg.llm.supportsVision = false
    expect(resolveVisionConfig(cfg)).toBeNull()
  })

  it('视觉模型配好了，聊天模型也能看图时给出兜底', () => {
    const cfg = defaultConfig()
    cfg.llm = { ...cfg.llm, apiKey: 'sk-chat', baseUrl: '/zhipu/api/paas/v4', model: 'glm-4.6', supportsVision: true }
    cfg.vlm = { baseUrl: '/zhipu/api/paas/v4', model: 'glm-4v-flash', apiKey: 'sk-vlm' }

    expect(visionFallback(cfg)?.model).toBe('glm-4.6')
    expect(visionFallback(cfg)?.source).toBe('llm')
  })

  it('聊天模型不支持图片时没有兜底', () => {
    const cfg = defaultConfig()
    cfg.llm = { ...cfg.llm, apiKey: 'sk-chat', model: 'deepseek-chat', supportsVision: false }
    cfg.vlm = { baseUrl: '/zhipu/api/paas/v4', model: 'glm-4v-flash', apiKey: 'sk-vlm' }
    expect(visionFallback(cfg)).toBeNull()
  })

  it('本来就在降级（vlm 没填）时不再给自己兜底', () => {
    const cfg = defaultConfig()
    cfg.llm = { ...cfg.llm, apiKey: 'sk-chat', model: 'gpt-4o-mini', supportsVision: true }
    cfg.vlm = { baseUrl: '', model: '', apiKey: '' }
    expect(visionFallback(cfg)).toBeNull()
  })
})

describe('模型把 JSON 写坏时的兜底', () => {
  // GLM-4V 真的会这么吐：中文键名不加引号、单引号、尾逗号
  const BROKEN = `{
    日程: [
        {title: '高数', date: '2026-10-06', start: '08:00', end: '09:40',},
        {title: "英语", date: '2026-10-07', start: "10:00", end: "11:40"},
    ],
}`

  it('修好之后是合法 JSON', () => {
    expect(() => JSON.parse(BROKEN)).toThrow()
    const fixed = JSON.parse(repairJson(BROKEN)) as { 日程: unknown[] }
    expect(fixed.日程).toHaveLength(2)
    expect((fixed.日程[0] as { title: string }).title).toBe('高数')
  })

  it('中文键名也能解析成日程', () => {
    const raw = `{"安排":[{"标题":"高数","日期":"2026.10.6","时间":"14:00-15:40","地点":"三教204"}]}`
    const result = parseCourseJsonDetailed(raw, NOW)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      title: '高数',
      date: '2026-10-06',
      startTime: '14:00',
      endTime: '15:40',
      location: '三教204'
    })
  })

  it('全角冒号逗号、注释、True/None 一起修', () => {
    const raw = `{
      // 这是注释
      items: [
        {title："体育"，date："2026-10-06"，时间："19:00-20:40"，单双周：None},
      ],
    }`
    const result = parseCourseJsonDetailed(raw, NOW)
    expect(result.items[0]).toMatchObject({ title: '体育', startTime: '19:00', repeat: 'none' })
  })

  it('字符串里的逗号和冒号不会被当成键名误伤', () => {
    const raw = `{"items":[{"title":"第1,2周: 复习","date":"2026-10-06","start":"08:00","end":"09:40"}]}`
    expect(parseCourseJsonDetailed(raw, NOW).items[0].title).toBe('第1,2周: 复习')
  })

  it('彻底不是 JSON 时抛 VlmJsonError（只有这种才值得重问一次）', () => {
    expect(() => parseCourseJsonDetailed('我看了这张图，但看不清', NOW)).toThrow(VlmJsonError)
    expect(() => parseCourseJsonDetailed('{"items": [', NOW)).toThrow(VlmJsonError)
    // 内容读不懂是另一类错误，不该触发重问
    expect(() => parseCourseJsonDetailed('{"items": []}', NOW)).not.toThrow(VlmJsonError)
  })
})

describe('另外两种模型爱写的形状', () => {
  it('外层是大括号、里面直接堆对象 —— 当成数组', () => {
    const raw = `{
      {"title":"智能传感与检测技术2026","date":"2026-11-08","start":"14:00","end":"17:40"},
      {"title":"大学英语","date":"2026-11-09","start":"08:00","end":"09:40"}
    }`
    expect(() => JSON.parse(raw)).toThrow()
    const result = parseCourseJsonDetailed(raw, NOW)
    expect(result.items.map(c => c.title)).toEqual(['智能传感与检测技术2026', '大学英语'])
  })

  it('字典形状 {"0":{…},"1":{…}} 也认', () => {
    const raw = JSON.stringify({
      0: { title: '体育', date: '2026-10-06', start: '08:00', end: '09:40' },
      1: { title: '音乐', date: '2026-10-07', start: '10:00', end: '11:40' }
    })
    expect(parseCourseJsonDetailed(raw, NOW).items.map(c => c.title)).toEqual(['体育', '音乐'])
  })
})
