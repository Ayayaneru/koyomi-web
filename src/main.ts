import { createApp } from 'vue'
import { Capacitor } from '@capacitor/core'
import { App as CapApp } from '@capacitor/app'
import App from './App.vue'
import router from './router'
import { assertModules } from './core/container'
import { initDb } from './core/db'
import { loadIconStyle } from './ui/iconStyle'
import { autoSyncHolidaysIfStale, loadCachedHolidays } from './features/schedule/holidaySync'
import { installEventReminders } from './features/schedule/reminders'
/* 顺序不能反：theme.css 要在 vant 之后，否则 .van-dialog 这类覆盖会被 Vant 的默认样式压住 */
import './ui/vant'
import './ui/theme.css'

async function bootstrap() {
  try {
    await initDb()
    // 任务图标的画法跟着配置走，读不到就先用彩色
    await loadIconStyle()
    // 节假日缓存是派生数据，读不到也不影响启动
    await loadCachedHolidays()
  } catch (error) {
    console.error('[koyomi] 数据库打不开', error)
  }
  assertModules()
  // 日程提醒：挂 events 表钩子，界面/模型/导入改过的都会重排（提前 5 分钟）
  installEventReminders()
  createApp(App).use(router).mount('#app')

  // 节假日每月自动更新一次：后台跑，失败了也不影响启动
  void autoSyncHolidaysIfStale()

  // 安卓返回键 / 左滑返回：先关弹层，再退一页，回到首页才真的退出
  if (Capacitor.isNativePlatform()) {
    void CapApp.addListener('backButton', () => {
      const visible = (el: Element | null): el is HTMLElement =>
        Boolean(el) && (el as HTMLElement).offsetWidth > 0 && (el as HTMLElement).offsetHeight > 0

      // 确认框没有「点遮罩关闭」，得点它的取消键
      const dialog = Array.from(document.querySelectorAll<HTMLElement>('.van-dialog')).filter(visible).pop()
      if (dialog) {
        const cancel = dialog.querySelector<HTMLElement>('.van-dialog__cancel')
        if (cancel) {
          cancel.click()
          return
        }
      }

      // 弹出层：点一下遮罩就关了（注意要判断真的显示着，关掉后 Vant 会留一个隐藏节点）。
      // 叠着两层时（日记编辑器 + 标签管理）要关最上面那层，所以取最后一个可见的遮罩，不是第一个。
      const overlay = Array.from(document.querySelectorAll<HTMLElement>('.van-overlay')).filter(visible).pop()
      if (overlay) {
        overlay.click()
        return
      }

      const state = window.history.state as { back?: string | null } | null
      if (state?.back) router.back()
      else void CapApp.exitApp()
    })
  }
}

void bootstrap()
