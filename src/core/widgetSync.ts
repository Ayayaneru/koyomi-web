import { Capacitor, registerPlugin } from '@capacitor/core'
import { liveQuery } from 'dexie'
import type { Router } from 'vue-router'
import { db } from './db'
import { buildWidgetSnapshot } from './widget'

/**
 * 桌面小工具的原生桥（2026-11-15）。
 *
 * 原生那边只有两件事：把快照存进 SharedPreferences 再刷新所有小工具；
 * 以及「用户点了小工具里的哪一条」——点击时把路径记下来，页面起来后取一次就清掉。
 * 没装成 App（浏览器里跑）时所有函数都是空操作。
 */

interface KoyomiWidgetBridge {
  save(options: { snapshot: string }): Promise<void>
  consumeOpen(): Promise<{ path?: string }>
}

const KoyomiWidget = registerPlugin<KoyomiWidgetBridge>('KoyomiWidget')

export function isAndroidApp(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

/** 重新算一份快照推给原生；失败（没装插件 / 老版本 APK）就安静跳过 */
export async function pushWidgetSnapshot(): Promise<void> {
  if (!isAndroidApp()) return
  try {
    const snapshot = await buildWidgetSnapshot()
    await KoyomiWidget.save({ snapshot: JSON.stringify(snapshot) })
  } catch (error) {
    console.warn('[widget] 快照推送失败', error)
  }
}

/**
 * 挂三件事：
 * 1. 数据变了（日程 / 任务 / 设置）就重推一份，1.2 秒防抖；
 * 2. 点小工具进来（冷启动靠 consumeOpen，热启动靠原生推的 koyomiOpen 事件）跳到对应页面；
 * 3. 每次回到前台再推一次，顺便把「今天 / 明天」这类相对日期刷新掉。
 */
export function installWidgetSync(router: Router): void {
  if (!isAndroidApp()) return

  let timer = 0
  const schedule = (): void => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => void pushWidgetSnapshot(), 1200)
  }

  liveQuery(async () => {
    const [cfg, events, tasks] = await Promise.all([
      db.config.get('app'),
      db.events.count(),
      db.tasks.count()
    ])
    return `${cfg?.updatedAt ?? 0}:${events}:${tasks}`
  }).subscribe({ next: () => schedule(), error: error => console.warn('[widget]', error) })

  async function consumeOpen(): Promise<void> {
    try {
      const result = await KoyomiWidget.consumeOpen()
      if (result?.path) await router.push(result.path)
    } catch (error) {
      console.warn('[widget] 打不开那一条', error)
    }
  }

  window.addEventListener('koyomiOpen', () => void consumeOpen())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    void consumeOpen()
    void pushWidgetSnapshot()
  })

  void pushWidgetSnapshot()
  void consumeOpen()
}
