import { db, defaultConfig, getConfig, type ConfigRow, type VlmConfig } from '../../core/db'
import { saveTextFile } from '../../core/saveFile'
import { stamp } from '../../core/time'

/**
 * 备份与导出。
 * format 恒为 koyomi-config，两档靠有没有 data 段区分；文件里不写 version 字段。
 */

export type TableKey = 'events' | 'tasks' | 'taskLogs' | 'diary'
export const DATA_TABLES: TableKey[] = ['events', 'tasks', 'taskLogs', 'diary']

export const TABLE_LABEL: Record<TableKey, string> = {
  events: '日程',
  tasks: '任务',
  taskLogs: '记录',
  diary: '日记'
}

function pick<T extends object, K extends keyof T>(source: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>
  for (const key of keys) out[key] = source[key]
  return out
}

export async function buildPayload(withData: boolean, includeKey = true): Promise<Record<string, unknown>> {
  const cfg = await getConfig()
  const payload: Record<string, unknown> = {
    format: 'koyomi-config',
    exportedAt: new Date().toISOString(),
    llm: {
      ...pick(cfg.llm, ['baseUrl', 'model', 'temperature', 'maxHistoryTurns', 'supportsVision']),
      apiKey: includeKey ? cfg.llm.apiKey : ''
    },
    prompt: pick(cfg.prompt, ['persona', 'modulePrompts', 'contextTemplate']),
    prefs: pick(cfg.prefs, [
      'userName',
      'modules',
      'festivals',
      'shareDiary',
      'taskIconStyle',
      'diaryTags',
      'presets',
      'activePreset'
    ])
  }
  if (cfg.vlm && cfg.vlm.baseUrl && cfg.vlm.model) {
    payload.vlm = {
      baseUrl: cfg.vlm.baseUrl,
      model: cfg.vlm.model,
      apiKey: includeKey ? cfg.vlm.apiKey : ''
    }
  }
  if (withData) {
    payload.data = {
      events: await db.events.toArray(),
      tasks: await db.tasks.toArray(),
      taskLogs: await db.taskLogs.toArray(),
      diary: await db.diary.toArray()
    }
  }
  return payload
}

/** 导出成文件：浏览器下载 / APK 走系统分享（见 core/saveFile.ts） */
export async function downloadPayload(payload: Record<string, unknown>, withData: boolean): Promise<void> {
  const name = `${withData ? 'koyomi-backup' : 'koyomi-config'}-${stamp()}.json`
  await saveTextFile(name, JSON.stringify(payload, null, 2))
}

export async function countLocal(): Promise<Record<TableKey, number>> {
  const [events, tasks, taskLogs, diary] = await Promise.all([
    db.events.count(),
    db.tasks.count(),
    db.taskLogs.count(),
    db.diary.count()
  ])
  return { events, tasks, taskLogs, diary }
}

export function mergeConfig(payload: Record<string, unknown>, current: ConfigRow): ConfigRow {
  const base = defaultConfig()
  const llmIn = (payload.llm ?? {}) as Partial<ConfigRow['llm']>
  const promptIn = (payload.prompt ?? {}) as Partial<ConfigRow['prompt']>
  const prefsIn = (payload.prefs ?? {}) as Partial<ConfigRow['prefs']>
  const vlmIn = payload.vlm as Partial<VlmConfig> | undefined

  return {
    id: 'app',
    llm: {
      ...base.llm,
      ...current.llm,
      ...llmIn,
      // 导出时没带 Key，导入就该沿用库里原有的，而不是清空
      apiKey: llmIn.apiKey ? String(llmIn.apiKey) : current.llm.apiKey
    },
    prompt: {
      persona: promptIn.persona ?? current.prompt.persona,
      modulePrompts: promptIn.modulePrompts ?? current.prompt.modulePrompts,
      contextTemplate: promptIn.contextTemplate ?? current.prompt.contextTemplate
    },
    vlm: vlmIn
      ? {
          baseUrl: vlmIn.baseUrl ?? current.vlm?.baseUrl ?? '',
          model: vlmIn.model ?? current.vlm?.model ?? '',
          // 同 llm.apiKey：文件里没带 Key 就沿用库里原有的
          apiKey: vlmIn.apiKey ? String(vlmIn.apiKey) : (current.vlm?.apiKey ?? '')
        }
      : current.vlm,
    prefs: {
      userName: prefsIn.userName ?? current.prefs.userName,
      modules: prefsIn.modules ?? current.prefs.modules,
      festivals: prefsIn.festivals ?? current.prefs.festivals,
      shareDiary: prefsIn.shareDiary ?? current.prefs.shareDiary,
      // 2026-11-01 新增：老备份文件里没有这两个字段，就沿用库里现有的
      taskIconStyle: prefsIn.taskIconStyle ?? current.prefs.taskIconStyle,
      diaryTags: prefsIn.diaryTags ?? current.prefs.diaryTags,
      // 2026-11-01：预设里存着人格和记忆（心理那条是长期积累的），换机必须带走
      presets: prefsIn.presets ?? current.prefs.presets,
      activePreset: prefsIn.activePreset ?? current.prefs.activePreset
    },
    vaultSalt: current.vaultSalt,
    updatedAt: Date.now()
  }
}

export interface ImportPlan {
  tables: TableKey[]
  counts: Record<TableKey, number>
  fileCounts: Record<TableKey, number>
}

export function planImport(payload: unknown, local: Record<TableKey, number>): ImportPlan | null {
  const data = (payload as { data?: Record<string, unknown> })?.data
  if (!data) return null
  const tables = DATA_TABLES.filter(key => Array.isArray(data[key]))
  const fileCounts = { events: 0, tasks: 0, taskLogs: 0, diary: 0 }
  for (const key of tables) fileCounts[key] = (data[key] as unknown[]).length
  return { tables, counts: local, fileCounts }
}

export function countsText(plan: ImportPlan): string {
  const lines = plan.tables.map(key => {
    const label = TABLE_LABEL[key]
    const from = String(plan.counts[key]).padStart(4, ' ')
    const to = String(plan.fileCounts[key]).padStart(4, ' ')
    return `${label}   ${from} 条  →  ${to} 条`
  })
  return `导入将覆盖本机数据，无法撤销：\n本机 → 文件\n${lines.join('\n')}`
}

export async function importPayload(payload: unknown): Promise<void> {
  if (!payload || typeof payload !== 'object') throw new Error('文件内容不是 JSON 对象')
  const file = payload as Record<string, unknown>
  if (file.format !== 'koyomi-config') throw new Error('不是 Koyomi 的备份文件')

  const data = file.data as Record<string, unknown> | undefined
  const tables = data ? DATA_TABLES.filter(key => Array.isArray(data[key])) : []
  const current = await getConfig()

  await db.transaction('rw', db.config, db.events, db.tasks, db.taskLogs, db.diary, async () => {
    await db.config.put(mergeConfig(file, current))
    for (const key of tables) {
      // 表名是变量，这里绕不过类型断言
      const table = db[key] as unknown as {
        clear(): Promise<void>
        bulkAdd(rows: unknown[]): Promise<unknown>
      }
      await table.clear()
      await table.bulkAdd((data as Record<string, unknown[]>)[key])
    }
  })
}
