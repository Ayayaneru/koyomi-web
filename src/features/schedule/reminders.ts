import { db, type EventRow } from '../../core/db'
import {
  cancelReminders,
  ensureNotificationPermission,
  hasNotificationPermission,
  isNative,
  scheduleReminders
} from '../../core/notify'
import { fmtTime } from '../../core/time'
import { eventOccurrences } from './expand'

/**
 * 日程提醒（2026-11-03）：每条日程在**开始前 5 分钟**响一次，只响一次。
 *
 * 不挂在新建/编辑的调用点上，而是挂在 `events` 表的写钩子上重排：
 * 界面新建、模型调工具、日程表导入、备份恢复，全都走同一套，不会漏。
 * 重复日程按未来 30 天展开，每次打开 App（或回到前台）再重排一次。
 */

/** 提前几分钟 */
export const LEAD_MINUTES = 5
/** 往后排多少天。太长会撞上系统「单应用待发通知 500 条」的上限 */
const HORIZON_DAYS = 30
/** 留点余量的上限 */
const MAX_PENDING = 400

const STORE_KEY = 'koyomi.notify.events'
const ASKED_KEY = 'koyomi.notify.asked'
const LEGACY_KEY = 'koyomi.notify.legacy-cleared'

export interface PlannedReminder {
  key: string
  /** 该响的时刻 = 开始时间 - LEAD_MINUTES */
  at: number
  /** 日程开始时刻，用来去重（同一条日程的多次重复靠它区分） */
  start: number
  title: string
  body: string
}

/**
 * 纯函数：算出「现在起 30 天内、还没到提醒时刻」的所有提醒。
 * 已开始/已过提醒时刻的直接丢掉——打开 App 时补一条迟到的提醒没有意义。
 */
export function planEventReminders(events: EventRow[], now: number): PlannedReminder[] {
  const lead = LEAD_MINUTES * 60_000
  const to = now + HORIZON_DAYS * 86_400_000
  const out = new Map<string, PlannedReminder>()

  for (const ev of events) {
    for (const start of eventOccurrences(ev, now, to)) {
      const at = start - lead
      if (at <= now) continue
      const key = `ev:${ev.id}:${start}`
      if (out.has(key)) continue
      out.set(key, {
        key,
        at,
        start,
        title: ev.title,
        body: `${LEAD_MINUTES} 分钟后开始 · ${fmtTime(start)}${ev.location ? ` · ${ev.location}` : ''}`
      })
    }
  }

  return [...out.values()].sort((a, b) => a.at - b.at).slice(0, MAX_PENDING)
}

function readStore(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, number>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeStore(map: Record<string, number>): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(map))
  } catch {
    /* 存不下就算了，下次全量重排 */
  }
}

let running = false
let queued = false
let timer: number | undefined

/** 延迟重排：写钩子里不能 await 系统 API，等事务结束再跑 */
export function scheduleEventReminderSync(delay = 800): void {
  if (!isNative()) return
  window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    void syncEventReminders()
  }, delay)
}

export async function syncEventReminders(): Promise<void> {
  if (!isNative()) return
  if (running) {
    queued = true
    return
  }
  running = true
  try {
    const rows = await db.events.toArray()
    const now = Date.now()
    const planned = planEventReminders(rows, now)
    const previous = readStore()
    const desired = new Map(planned.map(item => [item.key, item.at]))

    // 1) 撤掉上次排过、这次不需要的：日程删了、时间改了、或者已经过期
    const stale = Object.keys(previous).filter(key => desired.get(key) !== previous[key])
    if (stale.length) await cancelReminders(stale)

    // 2) 老版本（2026-11-02 之前）按「事件 id」排的提醒，时间点是开始那一刻，只清一次
    try {
      if (!localStorage.getItem(LEGACY_KEY)) {
        await cancelReminders(rows.map(row => `ev:${row.id}`))
        localStorage.setItem(LEGACY_KEY, '1')
      }
    } catch {
      /* 清不掉也不影响新提醒 */
    }

    // 3) 权限：第一次真的有东西要提醒时问一遍，之后不再打扰
    let granted = await hasNotificationPermission()
    if (!granted && planned.length) {
      let asked = false
      try {
        asked = Boolean(localStorage.getItem(ASKED_KEY))
      } catch {
        /* ignore */
      }
      if (!asked) {
        granted = await ensureNotificationPermission()
        try {
          localStorage.setItem(ASKED_KEY, '1')
        } catch {
          /* ignore */
        }
      }
    }

    if (!granted) {
      // 没权限就别记成「已排」，否则用户之后给了权限也不会补
      writeStore({})
      return
    }

    // 4) 只排新增或改过时间的，没变的留着
    const fresh = planned.filter(item => previous[item.key] !== item.at)
    if (fresh.length) await scheduleReminders(fresh)

    writeStore(Object.fromEntries(planned.map(item => [item.key, item.at])))
  } catch (error) {
    console.warn('[notify] 重排日程提醒失败', error)
  } finally {
    running = false
    if (queued) {
      queued = false
      scheduleEventReminderSync(300)
    }
  }
}

/** 启动时装一次：写钩子 + 首次重排 + 回到前台再重排 */
export function installEventReminders(): void {
  if (!isNative()) return
  const bump = () => scheduleEventReminderSync()
  db.events.hook('creating', () => bump())
  db.events.hook('updating', () => bump())
  db.events.hook('deleting', () => bump())
  scheduleEventReminderSync(1200)
  // 手机关机、系统清理、改了时间之后，回到前台补排一次
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleEventReminderSync(600)
  })
}
