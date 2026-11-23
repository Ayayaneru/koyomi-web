<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import { Popup, showToast } from 'vant'
import { Capacitor } from '@capacitor/core'
import AppHeader from '../../ui/AppHeader.vue'
import AppIcon from '../../ui/AppIcon.vue'
import { iconStyle, setIconStyle, type IconStyle } from '../../ui/iconStyle'
import { getConfig, patchConfig } from '../../core/db'
import { WIDGET_DEFAULT_COUNT, WIDGET_DEFAULT_DAYS } from '../../core/widget'
import { pushWidgetSnapshot } from '../../core/widgetSync'
import { fmtDate } from '../../core/time'
import { modules } from '../../core/container'
import { DEFAULT_FESTIVALS, FESTIVAL_GROUPS, FESTIVALS, type FestivalGroup } from '../schedule/festivals'
import { getYearData, holidayVersion } from '../schedule/holidays'
import { resetHolidays, syncHolidays } from '../schedule/holidaySync'
import {
  buildPayload,
  countLocal,
  DATA_TABLES,
  downloadPayload,
  importPayload,
  planImport,
  TABLE_LABEL,
  type ImportPlan
} from './backup'

const router = useRouter()

const userName = ref('')
const enabled = ref<string[]>([])
const festivals = ref<string[]>([...DEFAULT_FESTIVALS])
/** 周表 / 月表从哪天开头：0 = 周日，1 = 周一（2026-11-15 用户要求：两个表分开设） */
const calendar = ref<{ weekStart: 0 | 1; monthStart: 0 | 1 }>({ weekStart: 0, monthStart: 0 })
/** 桌面小工具：最近几天、显示几条（2026-11-15） */
const widget = ref<{ days: number; count: number }>({
  days: WIDGET_DEFAULT_DAYS,
  count: WIDGET_DEFAULT_COUNT
})
const WIDGET_DAYS = [3, 7, 14]
const WIDGET_COUNTS = [1, 2]
const includeKey = ref(true)
const busy = ref(false)
const persistState = ref<'unknown' | 'yes' | 'no'>('unknown')
const inWechat = /MicroMessenger/i.test(navigator.userAgent)
/** 装成 APK 之后，界面上不该再出现「网页 / 浏览器 / 套壳」这些词 */
const isApp = Capacitor.isNativePlatform()
/** 小工具只做了安卓；iOS 和浏览器里这一块整段不出现 */
const isAndroid = isApp && Capacitor.getPlatform() === 'android'
/** 版本号来自 package.json（vite define 注入），别在这里手写 */
const appVersion = __APP_VERSION__
const nameVar = '{{user_name}}'

const previewOpen = ref(false)
const preview = ref<ImportPlan | null>(null)
// 必须是 shallowRef：ref 会把解析出来的对象包成 Proxy，IndexedDB 无法结构化克隆
const pendingPayload = shallowRef<unknown>(null)

onMounted(async () => {
  const cfg = await getConfig()
widget.value = {
  days: cfg.prefs.widget?.days ?? WIDGET_DEFAULT_DAYS,
  count: cfg.prefs.widget?.count ?? WIDGET_DEFAULT_COUNT
}
  userName.value = cfg.prefs.userName
  enabled.value = [...cfg.prefs.modules]
  festivals.value = [...(cfg.prefs.festivals ?? DEFAULT_FESTIVALS)]
  calendar.value = {
    weekStart: cfg.prefs.calendar?.weekStart ?? 0,
    monthStart: cfg.prefs.calendar?.monthStart ?? 0
  }
  try {
    persistState.value = (await navigator.storage?.persisted?.()) ? 'yes' : 'no'
  } catch {
    persistState.value = 'unknown'
  }
})

const moduleNames: Record<string, string> = {
  llm: '对话',
  schedule: '日程',
  task: '任务',
  // 密码库不注册任何工具，模型碰不到；这个开关只影响日记的两个工具
  vault: '日记'
}

async function saveName() {
  await patchConfig({
    prefs: { userName: userName.value.trim(), modules: enabled.value, festivals: festivals.value }
  })
}

/** 周表 / 月表的开头日：存进 prefs.calendar，日程页下次进来就按新的排 */
async function setCalendarStart(key: 'weekStart' | 'monthStart', value: 0 | 1) {
  if (calendar.value[key] === value) return
  calendar.value = { ...calendar.value, [key]: value }
  await patchConfig({ prefs: { calendar: { ...calendar.value } } })
  const day = value === 1 ? '周一' : '周日'
  showToast(`${key === 'weekStart' ? '周表' : '月表'}已改成${day}开头`)
}

/** 小工具的两组 chips：改完立刻重推快照，不用等下次打开 App */
async function setWidgetPref(key: 'days' | 'count', value: number) {
  if (widget.value[key] === value) return
  widget.value = { ...widget.value, [key]: value }
  await patchConfig({ prefs: { widget: { ...widget.value } } })
  await pushWidgetSnapshot()
  showToast(key === 'days' ? `小工具看最近 ${value} 天` : `小工具显示 ${value} 条`)
}

async function refreshWidget() {
  await pushWidgetSnapshot()
  showToast('已刷新桌面小工具')
}

function festivalsOf(group: FestivalGroup) {
  return FESTIVALS.filter(f => f.group === group)
}

/* ---------- 日历：节假日数据（原来在日程页月视图那行按钮，2026-11-01 搬过来） ---------- */

const holidayYear = new Date().getFullYear()
const yearData = computed(() => {
  holidayVersion.value // 联网更新后要重算
  return getYearData(holidayYear)
})
const holidaySource = computed(() => {
  const data = yearData.value
  if (!data) return `${holidayYear} 年的放假安排还没收录`
  if (data.source === 'builtin') return `${holidayYear} 年 · 内置数据`
  return `${holidayYear} 年 · 联网更新${data.updatedAt ? ` ${fmtDate(data.updatedAt)}` : ''}`
})
const syncing = ref(false)

async function refreshHolidays() {
  if (syncing.value) return
  syncing.value = true
  try {
    const result = await syncHolidays(holidayYear)
    showToast(result.message)
  } finally {
    syncing.value = false
  }
}

async function useBuiltinHolidays() {
  await resetHolidays(holidayYear)
  showToast('已恢复内置数据')
}

const ICON_STYLES: { key: IconStyle; label: string }[] = [
  { key: 'color', label: '彩色' },
  { key: 'line', label: '线条' }
]

const WEEK_START_OPTIONS: { value: 0 | 1; label: string }[] = [
  { value: 0, label: '周日开头' },
  { value: 1, label: '周一开头' }
]

async function switchIconStyle(next: IconStyle) {
  if (iconStyle.value === next) return
  await setIconStyle(next)
  showToast(next === 'line' ? '已换成线条图标' : '已换成彩色图标')
}

async function toggleFestival(key: string) {
  festivals.value = festivals.value.includes(key)
    ? festivals.value.filter(item => item !== key)
    : [...festivals.value, key]
  await saveName()
}

async function toggleModule(id: string) {
  enabled.value = enabled.value.includes(id)
    ? enabled.value.filter(item => item !== id)
    : [...enabled.value, id]
  await saveName()
  showToast(enabled.value.includes(id) ? '已启用，模型又能操作它了' : '已关掉，模型不再调用这个模块的工具')
}

async function persist() {
  try {
    const ok = await navigator.storage?.persist?.()
    persistState.value = ok ? 'yes' : 'no'
    showToast(ok ? '已标记为持久存储' : '浏览器没有同意，记得定期导出')
  } catch {
    showToast('这个浏览器不支持')
  }
}

async function exportFile(withData: boolean) {
  busy.value = true
  try {
    const payload = await buildPayload(withData, includeKey.value)
    await downloadPayload(payload, withData)
    showToast(withData ? '已导出配置 + 数据' : '已导出配置')
  } catch (error) {
    // 用户在「保存到」界面点了取消：什么都不提示
    const message = error instanceof Error ? error.message : '导出失败'
    if (!message.includes('取消')) showToast(message)
  } finally {
    busy.value = false
  }
}

async function onImportFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const payload = JSON.parse(await file.text())
    if ((payload as { format?: string }).format !== 'koyomi-config') {
      showToast('不是 Koyomi 的备份文件')
      return
    }
    const local = await countLocal()
    const plan = planImport(payload, local)
    pendingPayload.value = payload
    preview.value = plan
    previewOpen.value = true
  } catch (error) {
    showToast(error instanceof Error ? error.message : '读不了这个文件')
  } finally {
    ;(event.target as HTMLInputElement).value = ''
  }
}

async function doImport() {
  busy.value = true
  try {
    await importPayload(pendingPayload.value)
    previewOpen.value = false
    showToast('已导入')
  } catch (error) {
    showToast(error instanceof Error ? error.message : '导入失败')
  } finally {
    busy.value = false
  }
}

const moduleRows = computed(() =>
  modules.map(m => ({ id: m.id, name: moduleNames[m.id] ?? m.id, on: enabled.value.includes(m.id) }))
)

const totalRows = ref(0)
onMounted(async () => {
  const counts = await countLocal()
  totalRows.value = DATA_TABLES.reduce((sum, key) => sum + counts[key], 0)
})
</script>

<template>
  <div class="page">
    <AppHeader title="设置" back />
    <div class="page-body">
      <div class="section-title">称呼</div>
      <div class="card">
        <input
          v-model="userName"
          class="input"
          placeholder="模型会这么称呼你"
          @blur="saveName"
        />
        <div class="tiny muted" style="margin-top: 6px">会插进助理预设的 {{ nameVar }}。</div>
      </div>

      <div class="section-title">模型与助理预设</div>
      <div class="card">
        <div class="setting-row" @click="router.push('/llm/settings')">
          <div class="k">供应商与模型</div>
          <div class="v">地址 · 模型 · Key · 温度 ›</div>
        </div>
        <div class="setting-row" @click="router.push('/llm/prompt')">
          <div class="k">助理预设</div>
          <div class="v">对话 · 写作 · 心理 ›</div>
        </div>
        <div class="setting-row" @click="router.push('/vault/passwords')">
          <div class="k">密码库</div>
          <div class="v">独立加密 · 不注册为工具 ›</div>
        </div>
      </div>

      <div class="section-title">日历</div>
      <div class="card">
        <div class="small">一周从哪天开始</div>
        <div class="tiny muted" style="margin: 6px 0 8px">周表</div>
        <div class="chips">
          <button
            v-for="opt in WEEK_START_OPTIONS"
            :key="opt.value"
            class="chip"
            :class="{ on: calendar.weekStart === opt.value }"
            @click="setCalendarStart('weekStart', opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>
        <div class="tiny muted" style="margin: 10px 0 8px">月表</div>
        <div class="chips">
          <button
            v-for="opt in WEEK_START_OPTIONS"
            :key="opt.value"
            class="chip"
            :class="{ on: calendar.monthStart === opt.value }"
            @click="setCalendarStart('monthStart', opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>
        <div class="tiny muted" style="margin-top: 8px">
          只改表头顺序和每月第一格从哪天排；单双周和 ISO 周数固定按周一算，不跟着变。
        </div>
        <div class="hr-soft" style="margin: 14px 0 12px"></div>
        <div class="row-between">
          <div class="grow">
            <div>节假日数据</div>
            <div class="tiny muted">{{ holidaySource }}</div>
          </div>
          <button class="btn btn-sm" :disabled="syncing" @click="refreshHolidays">
            {{ syncing ? '更新中…' : '联网更新' }}
          </button>
        </div>
        <button
          v-if="yearData?.source === 'remote'"
          class="btn btn-block btn-sm"
          style="margin-top: 8px"
          @click="useBuiltinHolidays"
        >
          恢复内置数据
        </button>
        <div class="tiny muted" style="margin-top: 8px">
          每月自动更新一次；更新失败时继续用已经存下来的数据。
        </div>

        <div class="hr-soft" style="margin: 14px 0 12px"></div>

        <div class="small" style="margin-bottom: 10px">日历上显示哪些节日</div>
        <div v-for="group in FESTIVAL_GROUPS" :key="group.key" style="margin-bottom: 12px">
          <div class="tiny muted" style="margin-bottom: 6px">{{ group.name }}</div>
          <div class="chips">
            <button
              v-for="f in festivalsOf(group.key)"
              :key="f.key"
              class="chip"
              :class="{ on: festivals.includes(f.key) }"
              :title="f.hint"
              @click="toggleFestival(f.key)"
            >
              {{ f.name }}
            </button>
          </div>
        </div>
        <div class="tiny muted">
          只影响月历上的小字。法定节假日（元旦 / 春节 / 清明 / 劳动节 / 端午 / 中秋 / 国庆）一直显示，不用选。
        </div>
      </div>

      <template v-if="isAndroid">
        <div class="section-title">桌面小工具</div>
        <div class="card">
          <div class="small">看最近几天</div>
          <div class="chips" style="margin-top: 8px">
            <button
              v-for="d in WIDGET_DAYS"
              :key="d"
              class="chip"
              :class="{ on: widget.days === d }"
              @click="setWidgetPref('days', d)"
            >
              {{ d }} 天
            </button>
          </div>
          <div class="tiny muted" style="margin: 10px 0 8px">显示几条</div>
          <div class="chips">
            <button
              v-for="c in WIDGET_COUNTS"
              :key="c"
              class="chip"
              :class="{ on: widget.count === c }"
              @click="setWidgetPref('count', c)"
            >
              {{ c }} 条
            </button>
          </div>
          <div class="tiny muted" style="margin-top: 8px">
            逾期还没做的任务一直排在最前面。小工具只有一格高，最多放两行，所以只有 1 条 / 2 条可选。
          </div>
          <button class="btn btn-block btn-sm" style="margin-top: 10px" @click="refreshWidget">立即刷新小工具</button>
        </div>
      </template>

      <div class="section-title">任务图标</div>
      <div class="card">
        <div class="small">图标风格</div>
        <div class="chips" style="margin-top: 8px">
          <button
            v-for="style in ICON_STYLES"
            :key="style.key"
            class="chip"
            :class="{ on: iconStyle === style.key }"
            @click="switchIconStyle(style.key)"
          >
            {{ style.label }}
          </button>
        </div>
        <div class="tiny muted" style="margin-top: 8px">
          两种画法是同一份素材的两个版本，改完立刻生效。任务列表、完成记录、首页都跟着换，数据里的 emoji 不动。
        </div>
      </div>

      <div class="section-title">模块开关</div>
      <div class="card">
        <div v-for="row in moduleRows" :key="row.id" class="setting-row">
          <div class="k">{{ row.name }}</div>
          <button class="switch-dot" :class="{ on: row.on }" @click="toggleModule(row.id)">✓</button>
        </div>
        <div class="tiny muted" style="margin-top: 8px">
          关掉只影响模型能不能调用它的工具；界面入口保留，数据也不会动。<br />
          密码库没有注册任何工具，模型任何时候都读不到，跟这个开关无关。
        </div>
      </div>

      <div class="section-title">备份</div>
      <div class="card">
        <div class="small">本机共 {{ totalRows }} 条业务数据（日程 / 任务 / 记录 / 日记）。</div>
        <div class="setting-row">
          <div class="k">包含 API Key</div>
          <button class="switch-dot" :class="{ on: includeKey }" @click="includeKey = !includeKey">✓</button>
        </div>
        <div class="row" style="gap: 8px; margin-top: 10px">
          <button class="btn grow" :disabled="busy || inWechat" @click="exportFile(false)">
            <AppIcon name="download" :size="16" /> 只导配置
          </button>
          <button class="btn btn-primary grow" :disabled="busy || inWechat" @click="exportFile(true)">
            <AppIcon name="download" :size="16" /> 含数据
          </button>
        </div>
        <div v-if="inWechat" class="error-text">
          微信内置浏览器不让下载文件，请用系统浏览器打开后再导出。
        </div>
        <div class="divider" />
        <label class="btn btn-block" style="position: relative; overflow: hidden">
          <AppIcon name="upload" :size="16" /> 导入备份文件
          <input
            type="file"
            accept="application/json,.json"
            style="position: absolute; inset: 0; opacity: 0"
            @change="onImportFile"
          />
        </label>
        <div class="tiny muted" style="margin-top: 8px">
          只导配置的文件不含 data 段，导入时四张表一个字都不动。密码库两个文件都不碰。
        </div>
      </div>

      <div class="section-title">存储</div>
      <div class="card">
        <!-- 浏览器才有「持久化」这回事；APK 的数据在应用私有目录里，不需要申请 -->
        <template v-if="!isApp">
          <div class="setting-row">
            <div class="k">持久存储</div>
            <div class="v">
              {{ persistState === 'yes' ? '已开启' : persistState === 'no' ? '未开启，可能被清理' : '不确定' }}
            </div>
          </div>
          <button class="btn btn-block" style="margin-top: 10px" @click="persist">申请持久化</button>
        </template>
        <div class="tiny muted" style="margin-top: 8px">
          {{
            isApp
              ? '这条数据在本机的应用存储里，卸载 App 会一起删掉。换机前用「含数据」导出一次。'
              : '浏览器里这份数据比 APK 里脆弱得多。真实数据别长期放在浏览器，套壳前用「含数据」导出一次。'
          }}
        </div>
      </div>

      <div class="section-title">关于</div>
      <div class="card small muted">
        Koyomi（历）· 版本 {{ appVersion }}<br />
        本地优先的个人助手：日程、周期任务、日记、密码，外加一个能直接操作这些数据的 LLM。<br />
        {{ isApp ? '数据只在这台设备上，不需要服务器、域名或证书。' : '数据只在这个浏览器里；装成 APK 后只在那台设备上。' }}<br />
        界面图标来自 Feather Icons（MIT）；任务图标是自绘插画与线条；日记心情是自绘线条。
      </div>
    </div>

    <Popup v-model:show="previewOpen" position="bottom" round>
      <div style="padding: 16px; padding-bottom: calc(20px + env(safe-area-inset-bottom))">
        <div class="row-between" style="margin-bottom: 12px">
          <div style="font-size: 16px; font-weight: 600">确认导入</div>
        </div>

        <template v-if="preview">
          <div class="banner danger" style="margin-top: 0">
            <div class="grow small">导入会覆盖本机这几张表，无法撤销。</div>
          </div>
          <div class="card" style="margin-top: 10px">
            <div class="row-between tiny muted" style="margin-bottom: 6px">
              <span>表</span>
              <span>本机 → 文件</span>
            </div>
            <div v-for="key in preview.tables" :key="key" class="row-between" style="padding: 4px 0">
              <span class="small">{{ TABLE_LABEL[key] }}</span>
              <span class="small">{{ preview.counts[key] }} 条 → {{ preview.fileCounts[key] }} 条</span>
            </div>
          </div>
        </template>
        <template v-else>
          <div class="banner">
            <div class="grow small">这个文件没有 data 段，只导入配置，四张表不动。</div>
          </div>
        </template>

        <!-- 底部按钮和全局确认框一样：左边取消、右边确认 -->
        <div class="row" style="gap: 8px; margin-top: 14px">
          <button class="btn grow" @click="previewOpen = false">取消</button>
          <button class="btn btn-primary grow" :disabled="busy" @click="doImport">
            {{ busy ? '写入中…' : '确认导入' }}
          </button>
        </div>
      </div>
    </Popup>
  </div>
</template>
