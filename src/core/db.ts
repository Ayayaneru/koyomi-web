import Dexie, { type Table } from 'dexie'

/* ============ 数据模型（字段只增不改） ============ */

export interface EventRow {
  id: string
  title: string
  location?: string
  note?: string
  startAt: number
  endAt: number
  repeatKind: 0 | 1 | 2 | 3
  repeatEveryN?: number
  weekParity: 0 | 1 | 2
  repeatUntil?: number
  source: 0 | 1
  version: number
  extJson?: string | null
  createdAt: number
  updatedAt: number
}

export interface TaskRow {
  id: string
  title: string
  icon?: string
  note?: string
  /** 0 一次性 / 1 周期 / 2 限次（做够次数就结束） */
  kind: 0 | 1 | 2
  intervalDays?: number
  /** kind = 2 时：一共要做几次 */
  limitCount?: number
  /** 手动「完成任务」的时间：设了就算结束（周期任务也能一键收起来） */
  closedAt?: number
  dueAt?: number
  lastDoneAt?: number
  anchorTimeOfDay?: string
  enabled: boolean
  version: number
  extJson?: string | null
  createdAt: number
  updatedAt: number
}

export interface TaskLogRow {
  id: string
  taskId: string
  taskTitle: string
  taskIcon?: string
  doneAt: number
  /** 完成前这条任务的 dueAt，用来「撤销」时原样退回去（老记录没有这个字段） */
  prevDueAt?: number
  note?: string
  source: 0 | 1 | 2
  extJson?: string | null
}

export interface DiaryRow {
  id: string
  date: number
  title: string
  content: string
  tags?: string
  /** 心情 emoji（😀🙂😐😔😡），界面选，模型不写 */
  mood?: string
  /** 置顶 */
  pinned?: boolean
  extJson?: string | null
  createdAt: number
  updatedAt: number
}

/** 对话历史：一次会话一行，消息直接存在行里（没有工具调用细节，只留问答正文） */
export interface ChatSessionRow {
  id: string
  title: string
  /** 这段对话是哪个预设聊的（切预设后历史列表按它过滤） */
  presetId?: string
  /** tool 是工具调用记录（只给界面回放用，不会再发给模型） */
  messages: { role: 'user' | 'assistant' | 'tool'; content: string; ok?: boolean }[]
  createdAt: number
  updatedAt: number
}

/** 联网拉到的节假日数据缓存（每年一行，派生数据，不进备份） */
export interface HolidayCacheRow {
  year: number
  days: Record<string, { kind: 'off' | 'work'; name?: string }>
  sourceUrl: string
  updatedAt: number
}

export interface VaultEntry {
  id: string
  /**
   * 明文名称。2026-11-02 起不再写入（新条目留空），只有老数据还留着；
   * 解锁时会由 `migrateSiteNames()` 加密搬进 siteEnc，搬完这里就清掉。
   */
  site: string
  /** 名称的密文。有它就优先用它，没有就回落到 site（迁移前的老条目） */
  siteEnc?: string
  /** 以下三项是 base64 密文 */
  account: string
  secret: string
  note: string
  iv: string
  updatedAt: number
}

/* ============ 配置 ============ */

export interface LlmConfig {
  baseUrl: string
  model: string
  apiKey: string
  temperature?: number
  maxHistoryTurns: number
  supportsVision: boolean
}

export interface PromptConfig {
  persona: string
  modulePrompts: Record<string, string>
  contextTemplate: string
}

/**
 * 图片识别单独一套配置（2026-10-27 加）：
 * 聊天模型和视觉模型往往不是同一个 —— 比如聊天用 DeepSeek（不支持图片），
 * 识图（导入日程）用智谱 GLM-4V。留空则退回 llm 段（配合 supportsVision）。
 * 只加新字段，不改任何已有字段含义。
 */
export interface VlmConfig {
  baseUrl: string
  model: string
  apiKey: string
}

/** 日记标签：名字 + 颜色。颜色是 6 位 hex，界面按 12% 透明度铺底 */
/**
 * 预设（Preset）：一套「人格 + 能用的模块 + 记忆」，切换就是换一套助理。
 * 2026-11-01：用户在 [对话][写作][心理] 之间切，人格/规则/上下文三样一起换。
 */
export interface Preset {
  id: string
  name: string
  /** 人格：说话风格，拼在 system 最前面 */
  persona: string
  /** 这个预设下能调用哪些模块的工具（模块自带的行为规则也跟着拼） */
  modules: string[]
  /** 上下文模板：这个预设的「记忆」，支持 {{today}} 这类变量 */
  context: string
  /** 让模型用日记工具（2026-11-01：从全局开关搬进预设，每个助理自己决定） */
  allowDiary?: boolean
  /** 让模型改人格 */
  allowEditPersona?: boolean
  /** 让模型改「能用哪些模块」 */
  allowEditModules?: boolean
  /** 让模型改记忆（上下文模板） */
  allowEditMemory?: boolean
  /** 旧字段：0.1 版只有这一档，读到就换算成上面三个开关 */
  selfEdit?: 'none' | 'memory' | 'all'
}

/** 把老数据里的 selfEdit 换算成三个开关（新数据不用这个） */
export function normalizePreset(preset: Preset): Preset {
  if (!preset.selfEdit) return preset
  return {
    ...preset,
    allowEditMemory: preset.allowEditMemory ?? preset.selfEdit !== 'none',
    allowEditPersona: preset.allowEditPersona ?? preset.selfEdit === 'all',
    allowEditModules: preset.allowEditModules ?? false
  }
}

export const DEFAULT_PERSONA = `你是 Koyomi，用户私人的日程与习惯助手。说话简短、具体，不说客套话，不复述用户已经知道的事。
要改数据时直接调用工具，不要先描述你打算怎么做。工具失败就说清原因，绝不编造成功。
不确定的地方一次只问一句，不要连着追问。
没有工具能做的事（比如密码库）直接说做不到，不要猜，也不要编造。`

export const DEFAULT_CONTEXT = `今天是 {{today}}（{{weekday}}），现在是 {{now}}。称呼用户为 {{user_name}}。
未来 7 天的日程：
{{upcoming_events}}
当前待办：
{{tasks_due}}
最近写过的日记：{{diary_titles}}`

export const PRESET_WRITE_PERSONA = `你是用户的写作搭子。他给一个念头，你把它写成一段话；他给一版草稿，你只修不通顺的地方，不改他的语气和用词习惯。
不要夸他写得好，不要总结，不要列一二三。写完就停。
要把聊天内容写进日记时，先给一版让他确认，别直接写进去。`

export const PRESET_WRITE_CONTEXT = `这是你长期记下的、关于这个人的写作资料：他的偏好、正在写的东西、反复出现的主题。
只用来贴近他的习惯，不要主动复述，也不要在闲聊里提起。

（还没有记录）

今天是 {{today}}。`

export const PRESET_MIND_PERSONA = `你是用户的老朋友，也懂一点心理学。
多数时候只是听，偶尔问一句。不急着给建议，不贴标签，不说「你应该」。
他要的是被听见，不一定要被解决；真想要办法时他会说。
语气平和，不端着，也不用「抱抱」「宝子」这类词。`

export const PRESET_MIND_CONTEXT = `关于他的近况，你知道这些（都是他自己说过的）：
不要一次全倒出来，也不要在他没提的时候主动提。

（还没有记录）

今天是 {{today}}。`

export const DEFAULT_PRESETS: Preset[] = [
  {
    id: 'chat',
    name: '对话',
    // 2026-11-02：以前留空靠全局人格回落，设置页里就是一片空白，看不到 Koyomi 那段。
    // 现在直接把默认人格 / 上下文填进预设，原样能看到、也能改。
    persona: DEFAULT_PERSONA,
    modules: ['schedule', 'task'],
    context: DEFAULT_CONTEXT,
    allowDiary: false,
    allowEditPersona: false,
    allowEditModules: false,
    allowEditMemory: false
  },
  {
    id: 'write',
    name: '写作',
    persona: PRESET_WRITE_PERSONA,
    modules: [],
    context: PRESET_WRITE_CONTEXT,
    allowDiary: true,
    allowEditPersona: false,
    allowEditModules: false,
    allowEditMemory: true
  },
  {
    id: 'mind',
    name: '心理',
    persona: PRESET_MIND_PERSONA,
    modules: [],
    context: PRESET_MIND_CONTEXT,
    allowDiary: true,
    allowEditPersona: true,
    allowEditModules: false,
    allowEditMemory: true
  }
]

/**
 * 内置预设的人格 / 上下文被清空时补回出厂文本。
 * 老配置里「对话」这两项存的是空串（当年靠全局回落），不补的话设置页永远是空白。
 */
function fillBuiltin(preset: Preset): Preset {
  const fresh = DEFAULT_PRESETS.find(item => item.id === preset.id)
  if (!fresh) return preset
  const persona = preset.persona?.trim() ? preset.persona : fresh.persona
  const context = preset.context?.trim() ? preset.context : fresh.context
  return persona === preset.persona && context === preset.context
    ? preset
    : { ...preset, persona, context }
}

/** 读预设表（不填就用内置那三个），顺手把老数据的 selfEdit 换算掉 */
export function presetListOf(cfg: ConfigRow): Preset[] {
  const list = cfg.prefs.presets
  return (list && list.length ? list : DEFAULT_PRESETS).map(normalizePreset).map(fillBuiltin)
}

export function activePresetOf(cfg: ConfigRow): Preset {
  const list = presetListOf(cfg)
  return list.find(item => item.id === cfg.prefs.activePreset) ?? list[0]
}

export interface DiaryTag {
  name: string
  color: string
}

/** 默认标签（都是示例，用户可以在日记编辑器里改名/改色/删掉） */
export const DEFAULT_DIARY_TAGS: DiaryTag[] = [
  { name: '工作', color: '#3f5f4f' },
  { name: '生活', color: '#9a6a12' },
  { name: '读书', color: '#4a5f7a' },
  { name: '健康', color: '#6b7f4a' },
  { name: '灵感', color: '#7a5a7f' },
  { name: '旅行', color: '#2f6f7a' },
  { name: '重要', color: '#a8322d' },
  { name: '杂事', color: '#6b6862' }
]

/** 日历显示：周表 / 月表各自的周起始日（0 = 周日，1 = 周一） */
export interface CalendarPrefs {
  weekStart?: 0 | 1
  monthStart?: 0 | 1
}

/** 桌面小工具：看最近几天、显示几条（不填 = 7 天 / 2 条） */
export interface WidgetPrefs {
  days?: number
  count?: number
}

export interface ConfigRow {
  id: 'app'
  llm: LlmConfig
  vlm?: VlmConfig
  prompt: PromptConfig
  prefs: {
    userName: string
    modules: string[]
    /** 月历上额外显示哪些节日（festivals.ts 的 key）；不填=用默认那几项，空数组=都不显示 */
    festivals?: string[]
    /** 是否允许模型读写日记；不填=false（默认不给） */
    shareDiary?: boolean
    /** 任务图标画法：color = 彩色，line = 黑色描边；不填=color */
    taskIconStyle?: 'color' | 'line'
    /** 日记标签表；不填=用 DEFAULT_DIARY_TAGS，空数组=一个标签都没有 */
    diaryTags?: DiaryTag[]
    /** 助理预设；不填=用 DEFAULT_PRESETS */
    presets?: Preset[]
    /** 当前用哪个预设；不填=chat */
    activePreset?: string
    /** 周表 / 月表从周几开头；不填=都从周日开始（保持旧行为） */
    calendar?: CalendarPrefs
    /** 桌面小工具显示范围；不填=最近 7 天里的 2 条 */
    widget?: WidgetPrefs
  }
  vaultSalt: string
  updatedAt: number
}

/* ============ 默认值 ============ */


export function defaultConfig(): ConfigRow {
  return {
    id: 'app',
    llm: {
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: '',
      temperature: 0.7,
      maxHistoryTurns: 8,
      supportsVision: false
    },
    prompt: {
      persona: DEFAULT_PERSONA,
      modulePrompts: {},
      contextTemplate: DEFAULT_CONTEXT
    },
    vlm: {
      baseUrl: '',
      model: '',
      apiKey: ''
    },
    prefs: {
      userName: '',
      modules: ['llm', 'schedule', 'task', 'vault'],
      // 2026-11-15：默认仍是周日开头（用户要求保持现状），要周一开始去设置里改
      calendar: { weekStart: 0, monthStart: 0 }
    },
    vaultSalt: '',
    updatedAt: Date.now()
  }
}

/* ============ 库与迁移 ============ */

class KoyomiDB extends Dexie {
  events!: Table<EventRow, string>
  tasks!: Table<TaskRow, string>
  taskLogs!: Table<TaskLogRow, string>
  diary!: Table<DiaryRow, string>
  config!: Table<ConfigRow, string>
  vaultEntries!: Table<VaultEntry, string>
  holidayCache!: Table<HolidayCacheRow, number>
  chatSessions!: Table<ChatSessionRow, string>

  constructor() {
    super('koyomi')
    this.version(1).stores({
      events: 'id, startAt, repeatUntil',
      tasks: 'id, dueAt, enabled',
      taskLogs: 'id, taskId, doneAt',
      diary: 'id, date',
      config: 'id',
      vaultEntries: 'id'
    })

    // v2：只加表，不动旧表（删表会连数据一起丢）
    this.version(2).stores({
      holidayCache: 'year'
    })

    // v3：对话历史
    this.version(3).stores({
      chatSessions: 'id, updatedAt'
    })
  }
}

export const db = new KoyomiDB()

export class ConflictError extends Error {
  constructor(message = '这条记录已被修改') {
    super(message)
    this.name = 'ConflictError'
  }
}

/** 乐观锁更新：版本对不上就抛 ConflictError */
export async function updateVersioned<T extends { version: number; updatedAt: number }>(
  table: Table<T, string>,
  id: string,
  expectedVersion: number,
  patch: Partial<T>
): Promise<void> {
  const affected = await table
    .where('id')
    .equals(id)
    .and(row => row.version === expectedVersion)
    .modify(row => {
      Object.assign(row, patch)
      row.version++
      row.updatedAt = Date.now()
    })
  if (affected === 0) throw new ConflictError()
}

export async function getConfig(): Promise<ConfigRow> {
  const row = await db.config.get('app')
  if (row) return row
  const fresh = defaultConfig()
  await db.config.put(fresh)
  return fresh
}

/** 去掉 Vue 的响应式代理：IndexedDB 的结构化克隆不认 Proxy */
function toPlain<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    return value
  }
}

/** 配置补丁：四段都可以只给一部分字段 */
export type ConfigPatch = Partial<Omit<ConfigRow, 'llm' | 'vlm' | 'prompt' | 'prefs'>> & {
  llm?: Partial<LlmConfig>
  vlm?: Partial<VlmConfig>
  prompt?: Partial<PromptConfig>
  prefs?: Partial<ConfigRow['prefs']>
}

/**
 * 只改要改的那几段。llm / vlm / prompt / prefs 都是一层合并，
 * 否则「只存昵称」会顺手把 festivals、modules 这些同段字段清空。
 * 数组（modules、festivals）是整体替换，不合并。
 */
export async function patchConfig(patch: ConfigPatch): Promise<void> {
  const cfg = await getConfig()
  const next: ConfigRow = {
    ...cfg,
    ...patch,
    llm: patch.llm ? { ...cfg.llm, ...patch.llm } : cfg.llm,
    vlm: patch.vlm ? { ...(cfg.vlm ?? { baseUrl: '', model: '', apiKey: '' }), ...patch.vlm } : cfg.vlm,
    prompt: patch.prompt ? { ...cfg.prompt, ...patch.prompt } : cfg.prompt,
    prefs: patch.prefs ? { ...cfg.prefs, ...patch.prefs } : cfg.prefs,
    id: 'app',
    updatedAt: Date.now()
  }
  // 调用方常把 ref/reactive 里的数组直接传进来，必须先转成普通对象
  await db.config.put(toPlain(next))
}

let initialized = false

export async function initDb(): Promise<void> {
  if (initialized) return
  await db.open()
  await getConfig()
  initialized = true
  try {
    if (navigator.storage?.persist) await navigator.storage.persist()
  } catch {
    /* 拿不到就算了，只是多一层保险 */
  }
}
