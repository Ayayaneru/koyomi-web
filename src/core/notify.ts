import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'

/**
 * 通知收在一个文件里。业务代码只调这里，不判断平台。
 * 浏览器下是空函数 —— 那里只能靠打开 App 时的逾期检查。
 */

export function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

/** 通知 id 必须能从业务 key 稳定算出来，否则撤不掉 */
export function notifyId(key: string): number {
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0
  return Math.abs(hash) % 2_000_000_000
}

export async function ensureNotificationPermission(): Promise<boolean> {
  if (!isNative()) return false
  try {
    const status = await LocalNotifications.checkPermissions()
    if (status.display === 'granted') return true
    const asked = await LocalNotifications.requestPermissions()
    return asked.display === 'granted'
  } catch {
    return false
  }
}

/** 只看当前状态，不弹系统框（已经在用的时候不要每次启动都问一遍） */
export async function hasNotificationPermission(): Promise<boolean> {
  if (!isNative()) return false
  try {
    return (await LocalNotifications.checkPermissions()).display === 'granted'
  } catch {
    return false
  }
}

export interface Reminder {
  /** 业务侧稳定 key，通知 id 由它算出来 */
  key: string
  at: number
  title: string
  body: string
}

/** 一次排一批：重复日程会一次排很多条，逐条调 schedule 太慢 */
export async function scheduleReminders(list: Reminder[]): Promise<void> {
  if (!isNative() || !list.length) return
  try {
    await LocalNotifications.schedule({
      notifications: list.map(item => ({
        id: notifyId(item.key),
        title: item.title,
        body: item.body,
        schedule: { at: new Date(item.at), allowWhileIdle: true }
      }))
    })
  } catch (error) {
    console.warn('[notify] 排通知失败', error)
  }
}

/** 一次撤一批（撤不存在的 id 不会报错） */
export async function cancelReminders(keys: string[]): Promise<void> {
  if (!isNative() || !keys.length) return
  try {
    await LocalNotifications.cancel({ notifications: keys.map(key => ({ id: notifyId(key) })) })
  } catch (error) {
    console.warn('[notify] 撤通知失败', error)
  }
}

export async function remindAt(at: number, title: string, body: string, key: string): Promise<void> {
  if (!isNative()) return
  if (at <= Date.now()) return
  try {
    await cancelRemind(key)
    await LocalNotifications.schedule({
      notifications: [
        {
          id: notifyId(key),
          title,
          body,
          schedule: { at: new Date(at), allowWhileIdle: true }
        }
      ]
    })
  } catch (error) {
    console.warn('[notify] 排通知失败', error)
  }
}

export async function cancelRemind(key: string): Promise<void> {
  if (!isNative()) return
  try {
    await LocalNotifications.cancel({ notifications: [{ id: notifyId(key) }] })
  } catch (error) {
    console.warn('[notify] 撤通知失败', error)
  }
}
