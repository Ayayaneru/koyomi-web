import type { ConfigRow, EventRow } from '../../core/db'
import { newId } from '../../core/crypto'
import { addDays, dayEnd, dayStart, fmtDate, parseLocal } from '../../core/time'
import { chatComplete, type ContentPart } from '../llm/client'
import { PERIODS, periodTime } from './periods'

/* ============ 图片 → 日程 JSON ============ */

/**
 * 一条识别结果 = 日程里的一次安排。
 * 2026-10-31 改：原来是「节次 + 周次 + 学期第一周」，只有按学期排的整表才填得出来；
 * 现在直接读日期和时间，一堆互不相干的单次日程（学习记录、考试安排）也能量。
 * 每周重复的课仍然支持：repeat = weekly + until。
 */
export interface DraftItem {
  title: string
  location?: string
  /** 哪一天，"YYYY-MM-DD" */
  date: string
  /** "HH:mm" */
  startTime: string
  endTime: string
  /** none = 就这一次；weekly = 每周；odd / even = 单双周 */
  repeat: 'none' | 'weekly' | 'odd' | 'even'
  /** 每周重复到哪天（含），"YYYY-MM-DD"；留空 = 一直重复 */
  until?: string
}

export interface ParseResult {
  items: DraftItem[]
  skipped: number
}

const CN_WEEKDAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }

const pad2 = (value: number | string) => String(value).padStart(2, '0')

export function toInt(value: unknown, fallback = NaN): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value)
  const m = String(value ?? '').match(/-?\d+/)
  return m ? Number(m[0]) : fallback
}

function range(input: unknown): [number, number] {
  if (Array.isArray(input)) return [toInt(input[0], 1), toInt(input[1] ?? input[0], 1)]
  const text = String(input ?? '')
  const m = text.match(/(\d+)\s*[-–~至]\s*(\d+)/)
  if (m) return [Number(m[1]), Number(m[2])]
  const single = toInt(text, 1)
  return [single, single]
}

/** "2026-10-06" / "2026/10/6" / "2026.10.6" / "10月6日" / "10-06" → "YYYY-MM-DD" */
export function normalizeDate(input: unknown, now = Date.now()): string {
  const text = String(input ?? '').trim()
  if (!text) return ''
  let m = text.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/)
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`
  m = text.match(/(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/)
  if (m) return `${new Date(now).getFullYear()}-${pad2(m[1])}-${pad2(m[2])}`
  if (/今天|今日/.test(text)) return fmtDate(now)
  if (/明天|明日/.test(text)) return fmtDate(addDays(now, 1))
  if (/后天/.test(text)) return fmtDate(addDays(now, 2))
  return ''
}

/** "20:00" / "20：00" / "8点30" / "2000" → "HH:mm"；认不出返回空串 */
export function normalizeTime(input: unknown): string {
  const text = String(input ?? '').trim()
  if (!text) return ''
  let m = text.match(/(\d{1,2})\s*[:：时点]\s*(\d{1,2})?/)
  if (m) {
    const h = Math.min(23, Number(m[1]))
    const mi = m[2] ? Math.min(59, Number(m[2])) : 0
    return `${pad2(h)}:${pad2(mi)}`
  }
  m = text.match(/^(\d{3,4})$/)
  if (m) {
    const digits = m[1].padStart(4, '0')
    const h = Math.min(23, Number(digits.slice(0, 2)))
    const mi = Math.min(59, Number(digits.slice(2)))
    return `${pad2(h)}:${pad2(mi)}`
  }
  return ''
}

/** "14:00-17:40" / "14:00~17:40" / "14:00 到 17:40" → ['14:00','17:40'] */
export function splitTimeRange(input: unknown): [string, string] {
  const text = String(input ?? '').trim()
  const parts = text.split(/\s*(?:-|–|—|~|～|至|到)\s*/).filter(Boolean)
  if (parts.length >= 2) return [normalizeTime(parts[0]), normalizeTime(parts[1])]
  return ['', '']
}

export function parseWeekday(input: unknown): number {
  if (typeof input === 'number') return input >= 1 && input <= 7 ? Math.round(input) : NaN
  const text = String(input ?? '')
  const n = text.match(/[1-7]/)
  if (n && !/周|星期/.test(text)) return Number(n[0])
  const cn = text.match(/[周星期]\s*([一二三四五六日天])/)
  if (cn) return CN_WEEKDAY[cn[1]] ?? NaN
  return NaN
}

export function parseParity(input: unknown): 0 | 1 | 2 {
  const text = String(input ?? '').toLowerCase()
  if (/单|odd/.test(text)) return 1
  if (/双|even/.test(text)) return 2
  return 0
}

/** 只给了「周几」没给日期时，取今天之后最近的那个周几（今天算） */
export function nextWeekdayDate(weekday: number, now = Date.now()): string {
  const today = dayStart(now)
  const delta = ((weekday % 7) - new Date(today).getDay() + 7) % 7
  return fmtDate(addDays(today, delta))
}

export function stripFence(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim()
}

/** 从一段可能带说明文字的输出里抠出第一个完整的 JSON 值 */
export function extractJson(raw: string): string {
  const text = stripFence(raw)
  const start = text.search(/[[{]/)
  if (start < 0) throw new Error('模型输出里找不到 JSON')
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  throw new Error('模型输出的 JSON 不完整')
}

/** 模型返回的压根不是 JSON（区别于「JSON 合法但内容不全」）——只有这种值得再问一次 */
export class VlmJsonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VlmJsonError'
  }
}

function snippet(text: string, limit = 90): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine
}

/**
 * 视觉模型偶尔会吐 JavaScript 对象字面量而不是严格 JSON：
 * 键名不加引号（中文键尤其常见）、单引号、尾逗号、注释、全角冒号逗号。
 * 这里按字符扫一遍修掉，字符串内部的内容原样保留，不会被正则误伤。
 */
export function repairJson(raw: string): string {
  let text = raw
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/，/g, ',')
    .replace(/：/g, ':')
    .replace(/\u00a0/g, ' ')

  // 模型有时把数组写成 { {…}, {…} }（外层大括号但里面没有键名）——直接换成方括号
  const head = text.trimStart()
  if (head.startsWith('{')) {
    const rest = head.slice(1).trimStart()
    if (rest.startsWith('{') || rest.startsWith('[')) {
      const start = text.indexOf('{')
      const end = text.lastIndexOf('}')
      if (start >= 0 && end > start) {
        text = `${text.slice(0, start)}[${text.slice(start + 1, end)}]${text.slice(end + 1)}`
      }
    }
  }

  let out = ''
  let i = 0
  let inString = false
  let quote = '"'
  let escaped = false
  /** 上一个非空白字符，用来判断「这里应该是键名」 */
  let last = ''

  while (i < text.length) {
    const ch = text[i]

    if (inString) {
      if (escaped) {
        out += ch
        escaped = false
      } else if (ch === '\\') {
        out += ch
        escaped = true
      } else if (ch === quote) {
        out += '"'
        inString = false
        last = '"'
      } else if (ch === '"') {
        // 单引号字符串里出现的双引号要转义
        out += '\\"'
      } else {
        out += ch
      }
      i++
      continue
    }

    if (ch === '"' || ch === "'") {
      inString = true
      quote = ch
      out += '"'
      i++
      continue
    }

    // 注释
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      i = nl < 0 ? text.length : nl
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
      continue
    }

    // 键名没引号：{ 或 , 之后到 : 之前
    if ((last === '{' || last === ',') && /[A-Za-z_\u4e00-\u9fa5]/.test(ch)) {
      let j = i
      while (j < text.length && /[A-Za-z0-9_\u4e00-\u9fa5]/.test(text[j])) j++
      let k = j
      while (k < text.length && /\s/.test(text[k])) k++
      if (text[k] === ':') {
        out += `"${text.slice(i, j)}"`
        last = '"'
        i = j
        continue
      }
    }

    // Python 风格的 True / False / None
    if (/[A-Za-z]/.test(ch)) {
      const word = /^[A-Za-z]+/.exec(text.slice(i, i + 8))?.[0] ?? ''
      const lower = word.toLowerCase()
      if (lower === 'true' || lower === 'false' || lower === 'null' || lower === 'none') {
        out += lower === 'none' ? 'null' : lower
        last = 'a'
        i += word.length
        continue
      }
    }

    out += ch
    if (!/\s/.test(ch)) last = ch
    i++
  }

  // 尾逗号
  return out.replace(/,\s*([}\]])/g, '$1')
}

/**
 * 一条模型结果 → 一条草稿。键名认英文和中文两套：模型偶尔会把键也翻译掉。
 * 顺序很重要：先看单独的起止时间，再看 "14:00-17:40" 这种合并写法，
 * 最后才按「第 3-4 节」换算 —— 不然 range('14:00-17:40') 会被当成第 14 到 17 节。
 */
function normalizeItem(raw: Record<string, unknown>, now: number): DraftItem | null {
  const title = String(
    raw.title ??
      raw.name ??
      raw.course ??
      raw.event ??
      raw['课程'] ??
      raw['课程名'] ??
      raw['标题'] ??
      raw['名称'] ??
      raw['安排'] ??
      ''
  ).trim()
  if (!title) return null

  let start = normalizeTime(
    raw.start ?? raw.startTime ?? raw.begin ?? raw['开始'] ?? raw['起'] ?? raw['开始时间']
  )
  let end = normalizeTime(raw.end ?? raw.endTime ?? raw['结束'] ?? raw['止'] ?? raw['结束时间'])
  if (!start || !end) {
    const [s, e] = splitTimeRange(
      raw.time ??
        raw.range ??
        raw.section ??
        raw['时间'] ??
        raw['时段'] ??
        raw['periods'] ??
        raw['节次'] ??
        raw['节']
    )
    start = start || s
    end = end || e
  }
  if (!start) {
    // 「第 3-4 节」：按内置作息表折算成时间（1-12 之外的数字不是节次，别硬套）
    const [ps, pe] = range(raw.periods ?? raw.sections ?? raw['节次'] ?? raw['节'])
    if (Number.isFinite(ps) && ps >= 1 && ps <= 12) {
      const clamp = (n: number) => Math.min(12, Math.max(1, Math.round(n)))
      start = periodTime(clamp(ps)).start
      end = periodTime(clamp(Number.isFinite(pe) ? pe : ps)).end
    }
  }

  const weekday = parseWeekday(raw.weekday ?? raw.day ?? raw['星期'] ?? raw['周几'])
  const date =
    normalizeDate(raw.date ?? raw.day ?? raw['日期'] ?? raw['天'], now) ||
    (weekday >= 1 && weekday <= 7 ? nextWeekdayDate(weekday, now) : '')
  if (!date) return null

  if (!start) start = '09:00'
  if (!end) {
    // 只给了开始时间：默认一个半小时，够一课
    const [h, m] = start.split(':').map(Number)
    const total = h * 60 + m + 90
    end = `${pad2(Math.floor(total / 60) % 24)}:${pad2(total % 60)}`
  }

  const parityText = `${raw.parity ?? ''} ${raw['单双周'] ?? ''}`
  const repeatText = `${raw.repeat ?? ''} ${raw['重复'] ?? ''} ${raw.weeks ?? ''} ${raw['周次'] ?? ''}`
  let repeat: DraftItem['repeat'] = 'none'
  if (parseParity(parityText) === 1) repeat = 'odd'
  else if (parseParity(parityText) === 2) repeat = 'even'
  else if (/每周|每星期|重复|weekly|odd|even/i.test(repeatText)) repeat = 'weekly'

  let until = normalizeDate(raw.until ?? raw.to ?? raw['到'] ?? raw['结束日期'] ?? raw['截止'], now)

  // 老格式「周次 1-16」：没有具体结束日期时，按 7 天一周折成 until
  if (repeat === 'none') {
    const [ws, we] = range(raw.weeks ?? raw.weekRange ?? raw['周次'])
    if (Number.isFinite(we) && we >= 2) {
      const first = parseLocal(date)
      repeat = 'weekly'
      until = until || fmtDate(addDays(first, Math.max(1, we - (Number.isFinite(ws) ? ws : 1)) * 7))
    }
  }

  return {
    title,
    location: String(raw.location ?? raw.room ?? raw.place ?? raw['地点'] ?? raw['教室'] ?? '').trim() || undefined,
    date,
    startTime: start,
    endTime: end,
    repeat,
    until: repeat === 'none' ? undefined : until || undefined
  }
}


/** JSON 顶层可能是数组、{courses:[]}、{data:[...]}，甚至 {课程表:[]} —— 都认 */
function pickCourseList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data
  if (!data || typeof data !== 'object') return []
  const obj = data as Record<string, unknown>
  for (const key of ['items', 'courses', 'data', 'list', 'events', '课程', '课程表', '安排', '日程', '时间表']) {
    const value = obj[key]
    if (Array.isArray(value)) return value
    if (value && typeof value === 'object') {
      const nested = pickCourseList(value)
      if (nested.length) return nested
    }
  }
  // 兜底：随便哪个数组字段，只要里面是对象
  for (const value of Object.values(obj)) {
    if (Array.isArray(value) && value.some(item => item && typeof item === 'object')) return value
  }
  // 再兜底：整张表就是个字典（{"0": {…}, "1": {…}}）
  const values = Object.values(obj)
  if (values.length && values.every(item => item && typeof item === 'object' && !Array.isArray(item))) {
    return values
  }
  return []
}

/** 容错解析：允许 {items:[]} / [] / {data:{items:[]}} 三种外形，坏行跳过，全坏才报错 */
export function parseCourseJsonDetailed(raw: string, now = Date.now()): ParseResult {
  let json: string
  try {
    json = extractJson(raw)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    // 这两句原文太技术，界面上要能直接看懂 + 知道可以点重试
    const friendly = detail.includes('不完整')
      ? '模型返回的 JSON 被截断了，可以点「重试」'
      : detail.includes('找不到')
        ? '模型这次没按 JSON 格式回答，可以点「重试」'
        : detail
    throw new VlmJsonError(friendly)
  }

  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    // 模型把键名写成不带引号的中文、用了单引号或尾逗号：先修一遍再解析
    try {
      data = JSON.parse(repairJson(json))
    } catch {
      throw new VlmJsonError(`模型返回的不是合法 JSON（开头：${snippet(json)}）`)
    }
  }

  const list = pickCourseList(data)

  if (!list.length) throw new Error('没有识别到任何安排')

  const items: DraftItem[] = []
  let skipped = 0
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      skipped++
      continue
    }
    const normalized = normalizeItem(item as Record<string, unknown>, now)
    if (normalized) items.push(normalized)
    else skipped++
  }
  if (!items.length) throw new Error('识别到的安排都不完整（缺少标题或日期）')
  // 按时间排一下：一堆单次日程时，顺序跟图上一致，核对起来快
  items.sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`))
  return { items, skipped }
}

export function parseCourseJson(raw: string, now = Date.now()): DraftItem[] {
  return parseCourseJsonDetailed(raw, now).items
}

/** 草稿 → EventRow：日期 + 起止时间直接落库，不再经过节次/周次换算 */
export function draftToEventRow(draft: DraftItem): EventRow {
  const startAt = parseLocal(`${draft.date} ${draft.startTime || '09:00'}`)
  let endAt = parseLocal(`${draft.date} ${draft.endTime || draft.startTime || '10:00'}`)
  if (endAt <= startAt) endAt = startAt + 45 * 60_000

  const weekly = draft.repeat !== 'none'
  const until = weekly && draft.until ? dayEnd(parseLocal(draft.until)) : undefined

  const now = Date.now()
  return {
    id: newId('ev'),
    title: draft.title,
    location: draft.location || undefined,
    startAt,
    endAt,
    repeatKind: weekly ? 2 : 0,
    weekParity: draft.repeat === 'odd' ? 1 : draft.repeat === 'even' ? 2 : 0,
    repeatUntil: until,
    source: 1,
    version: 1,
    extJson: null,
    createdAt: now,
    updatedAt: now
  }
}

/* ============ 图片压缩与请求 ============ */

export async function compressImage(file: File, maxEdge = 1568): Promise<string> {
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bmp.width * scale))
  canvas.height = Math.max(1, Math.round(bmp.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持 canvas 压缩')
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('压缩失败'))), 'image/jpeg', 0.85)
  )
  return await blobToBase64(blob)
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.onload = () => {
      const result = String(reader.result ?? '')
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(blob)
  })
}

/** 节次 → 时间的对照，写进提示词，模型图上写「第 3-4 节」时自己换算 */
function periodsHint(): string {
  return PERIODS.map(p => `${p.index}=${p.start}-${p.end}`).join('，')
}

/**
 * 识图提示词（2026-10-31 重写）：以前要求模型输出「节次 + 周次」，
 * 只有按学期排的整表才填得出来；现在逐条读日期和时间，图上是节次的让它自己换算。
 * 今天是哪天要写进去 —— 图上只写「周日」的，模型才能落成一个具体日期。
 */
export function vlmPrompt(now = Date.now()): string {
  return `请把这张图里的每一条时间安排逐条读出来，一条一行，只输出 JSON，不要解释。
格式：
{"items":[{"title":"考研英语 词汇(18-1)","date":"2026-10-06","start":"20:00","end":"21:30","location":"","repeat":"none"}]}
规则：
- 图上每行就是一条，不要合并、不要漏行；同一天有多条就写多条
- 今天是 ${fmtDate(now)}（星期${'日一二三四五六'[new Date(now).getDay()]}）。date 用 YYYY-MM-DD；图上只写「10.6」「10月6日」的按今年补全；只写周几没写日期的，date 填今天之后最近的那个周几
- start / end 用 24 小时制 HH:mm；只给了时长没给结束时间的，end = start + 时长
- 图上写「每周X 某时间，从 A 到 B」的：repeat 填 "weekly"，date 填 A，until 填 B；一次性的事件 repeat 填 "none"
- 图上写「第 3-4 节」这种节次的，按这张作息表换算成时间：${periodsHint()}
- 看不清的一行直接跳过，不要编造标题`
}

export interface VisionConfig {
  baseUrl: string
  model: string
  apiKey: string
  /** vlm = 单独配的视觉模型；llm = 聊天模型兼着看图（降级） */
  source: 'vlm' | 'llm'
}

/** 聊天模型能不能顶上识图（要勾「支持图片」并填全） */
function llmVisionConfig(cfg: ConfigRow): VisionConfig | null {
  const llm = cfg.llm
  if (!llm.supportsVision || !llm.baseUrl || !llm.model || !llm.apiKey) return null
  return { baseUrl: llm.baseUrl, model: llm.model, apiKey: llm.apiKey, source: 'llm' }
}

/**
 * 图片识别用哪套配置：优先 vlm 段，没有就退回 llm 段（要求 supportsVision）。
 * 返回 null 表示「当前没配能看图的模型」，导入页会置灰。
 * source 会带到界面上 —— 降级用聊天模型时要明确告诉用户，别悄悄换掉。
 */
export function resolveVisionConfig(cfg: ConfigRow): VisionConfig | null {
  const vlm = cfg.vlm
  if (vlm && vlm.baseUrl.trim() && vlm.model.trim() && vlm.apiKey.trim()) {
    return {
      baseUrl: vlm.baseUrl.trim(),
      model: vlm.model.trim(),
      apiKey: vlm.apiKey.trim(),
      source: 'vlm'
    }
  }
  return llmVisionConfig(cfg)
}

/** 视觉模型配了但连不上时，拿谁来兜底；没配视觉模型（本来就是降级）时返回 null */
export function visionFallback(cfg: ConfigRow): VisionConfig | null {
  if (resolveVisionConfig(cfg)?.source !== 'vlm') return null
  return llmVisionConfig(cfg)
}

type RepairConfig = { baseUrl: string; model: string; apiKey: string }

const REPAIR_PROMPT = `下面这段文字原本应该是「日程列表」的 JSON，但格式坏了（键名没引号、被截断、少了括号等）。
请把它整理成严格的 JSON，只输出 JSON，不要解释。
格式：{"items":[{"title":"考研英语 词汇(18-1)","date":"2026-10-06","start":"20:00","end":"21:30","location":"","repeat":"none"}]}
规则：
- date 用 YYYY-MM-DD；start / end 用 HH:mm
- repeat 只能是 "none" / "weekly" / "odd" / "even"，每周重复的再给 until
- 只整理已有内容，不要新增或编造条目；缺的字段留空
- 一行都还原不出来就原样返回空数组 {"items":[]}`

/**
 * 让聊天模型把坏掉的文本重新整理成 JSON。
 * 不带图片：比再跑一遍视觉模型便宜得多，而且纯文本整理通常更稳。
 */
async function tidyWithLlm(cfg: RepairConfig, broken: string, signal?: AbortSignal): Promise<string> {
  const message = await chatComplete({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    temperature: 0,
    messages: [
      { role: 'system', content: '你是一个数据整理器，只输出 JSON。' },
      { role: 'user', content: `${REPAIR_PROMPT}\n\n原始内容：\n${broken.slice(0, 6000)}` }
    ],
    responseFormat: 'json',
    signal
  })
  const text = typeof message.content === 'string' ? message.content : ''
  if (!text) throw new Error('整理模型没有返回内容')
  return text
}

export interface RecognizeOptions {
  file: File
  cfg: VisionConfig
  /** 主配置失败时的兜底（一般是聊天模型）；用户自己取消时不重试 */
  fallback?: VisionConfig
  /** 输出格式坏掉时，用聊天模型把文本重新整理一遍 */
  repair?: RepairConfig | null
  signal?: AbortSignal
}

export interface RecognizeOutcome extends ParseResult {
  /** 实际用的模型 */
  usedModel: string
  /** true = 视觉模型没连上，这条是聊天模型识别的 */
  degraded: boolean
  /** 输出格式坏过，谁帮忙整理的：llm = 聊天模型，vlm = 视觉模型重答 */
  repaired?: 'llm' | 'vlm'
}

export async function recognizeTimetable({
  file,
  cfg,
  fallback,
  repair,
  signal
}: RecognizeOptions): Promise<RecognizeOutcome> {
  const base64 = await compressImage(file)

  const run = async (target: VisionConfig): Promise<{ result: ParseResult; repaired?: 'llm' | 'vlm' }> => {
    const ask = async (hint = ''): Promise<string> => {
      const parts: ContentPart[] = [
        { type: 'text', text: vlmPrompt() + hint },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }
      ]
      const message = await chatComplete({
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        model: target.model,
        temperature: 0,
        messages: [{ role: 'user', content: parts }],
        responseFormat: 'json',
        signal
      })
      const text = typeof message.content === 'string' ? message.content : ''
      if (!text) throw new Error('模型没有返回内容')
      return text
    }

    const text = await ask()
    try {
      return { result: parseCourseJsonDetailed(text) }
    } catch (error) {
      // 只有「根本不是 JSON」才值得救；读不懂内容（没认出东西）救也没用
      if (!(error instanceof VlmJsonError) || signal?.aborted) throw error

      // 先让聊天模型在本地把这段文本整理成 JSON：不带图片、便宜，通常也比视觉模型会写格式
      if (repair) {
        try {
          return {
            result: parseCourseJsonDetailed(await tidyWithLlm(repair, text, signal)),
            repaired: 'llm'
          }
        } catch (e) {
          if (signal?.aborted) throw e
        }
      }

      // 还不行，再带着图让视觉模型重答一次
      return {
        result: parseCourseJsonDetailed(
          await ask(
            '\n\n上一次的输出不是合法 JSON。请只输出一个 JSON 对象：所有键名和字符串都用英文双引号，不要注释、不要尾逗号、不要解释。'
          )
        ),
        repaired: 'vlm'
      }
    }
  }

  try {
    const { result, repaired } = await run(cfg)
    return { ...result, usedModel: cfg.model, degraded: false, repaired }
  } catch (error) {
    if (!fallback || signal?.aborted) throw error
    // 视觉模型没连上（跨域 / Key / 模型名错）：改用聊天模型再试一次，并让界面说明清楚
    const { result, repaired } = await run(fallback)
    return { ...result, usedModel: fallback.model, degraded: true, repaired }
  }
}
