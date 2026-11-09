<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Skeleton } from 'vant'
import AppHeader from './ui/AppHeader.vue'
import AppIcon from './ui/AppIcon.vue'
import TaskIcon from './ui/TaskIcon.vue'
import { useLiveOn } from './ui/useLiveOn'
import { modules } from './core/container'
import { db, type TaskRow } from './core/db'
import { dueChip } from './features/task/due'
import { useDayTimeline } from './core/timeline'
import { dayEnd, dayStart, fmtDate, fmtTime, weekdayName } from './core/time'

const router = useRouter()
const userName = ref('')
const loading = ref(true)
const nowRef = ref(Date.now())

const range = ref({ start: dayStart(nowRef.value), end: dayEnd(nowRef.value) })
const items = useDayTimeline(range)

/**
 * 待办：今天到期的 + 之前没做完的。
 * 首页原来那条黄色提醒条删掉了，逾期的任务没有别的入口，就一起并到这里。
 */
const pendingTasks = useLiveOn(range, async r => {
  const rows = await db.tasks.toArray()
  return rows
    .filter(task => task.enabled && task.dueAt != null && task.dueAt < r.end)
    .sort((a, b) => (a.dueAt as number) - (b.dueAt as number))
})

const pendingItems = computed(() =>
  (pendingTasks.value ?? []).map(task => ({ task, chip: dueChip(task, nowRef.value) }))
)

const events = computed(() => (items.value ?? []).filter(item => item.kind === 'event'))
const logs = computed(() => (items.value ?? []).filter(item => item.kind === 'log'))

/** 日程最多 4 条、已完成最多 3 条，多的点「还有 N 条」去各自的页面 */
const eventItems = computed(() => events.value.slice(0, 4))
const logItems = computed(() => logs.value.slice(0, 3))

const hasToday = computed(
  () => pendingItems.value.length + events.value.length + logs.value.length > 0
)

/** 首页右上角那一小块：今天有多少事，固定一行，条数再多也不换行不撑高 */
const todaySummary = computed(() => {
  if (!ready.value) return '…'
  const parts: string[] = []
  if (pendingItems.value.length) parts.push(`待办 ${pendingItems.value.length}`)
  if (events.value.length) parts.push(`日程 ${events.value.length}`)
  if (logs.value.length) parts.push(`完成 ${logs.value.length}`)
  return parts.join(' · ') || '还没有安排'
})

/** 配置读完了、待办也查回来了才渲染，免得先闪一下「今天还没有安排」 */
const ready = computed(() => !loading.value && pendingTasks.value !== undefined)

const hints: Record<string, string> = {
  llm: '一句话把事办了',
  schedule: '日程与安排',
  task: '每 N 天做一次',
  vault: '按日期写'
}

const greeting = computed(() => {
  const hour = new Date(nowRef.value).getHours()
  const word = hour < 6 ? '还在忙' : hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 19 ? '下午好' : '晚上好'
  return userName.value ? `${word}，${userName.value}` : word
})

const todayLabel = computed(() => `${fmtDate(nowRef.value)} ${weekdayName(nowRef.value)}`)

async function refresh() {
  const cfg = await db.config.get('app')
  userName.value = cfg?.prefs.userName ?? ''
  loading.value = false
}

function onVisible() {
  if (document.visibilityState !== 'visible') return
  nowRef.value = Date.now()
  const start = dayStart(nowRef.value)
  const end = dayEnd(nowRef.value)
  if (start !== range.value.start) range.value = { start, end }
  void refresh()
}

onMounted(() => {
  void refresh()
  document.addEventListener('visibilitychange', onVisible)
})
onUnmounted(() => document.removeEventListener('visibilitychange', onVisible))

function go(path: string) {
  void router.push(path)
}

/** 日程点进去停在它自己的时间段（日程页认 ?at=），不是「现在」 */
function openEvent(at: number) {
  void router.push({ path: '/schedule', query: { at: String(at) } })
}

function firstChar(title: string): string {
  return Array.from(title)[0] ?? '·'
}

function taskHint(task: TaskRow): string {
  if (task.kind === 0) return '一次性'
  const base = `每 ${task.intervalDays ?? 1} 天`
  if (task.kind === 2) return `${base} · 共 ${Math.max(1, task.limitCount ?? 1)} 次`
  return base
}
</script>

<template>
  <div class="page">
    <AppHeader brand>
      <template #right>
        <button class="icon-btn" aria-label="密码库" @click="go('/vault/passwords')">
          <AppIcon name="lock" :size="19" />
        </button>
        <button class="icon-btn" aria-label="设置" @click="go('/settings')">
          <AppIcon name="settings" :size="19" />
        </button>
      </template>
    </AppHeader>

    <div class="page-body">
      <div class="home-hero">
        <div class="grow">
          <div class="greet">{{ greeting }}</div>
          <div class="date">{{ todayLabel }}</div>
        </div>
        <div class="hero-today" :class="{ empty: !hasToday }">
          <span class="ht-k">今天</span>
          <span class="ht-v">{{ todaySummary }}</span>
        </div>
      </div>

      <div class="home-grid">
        <button v-for="m in modules" :key="m.id" class="home-card" @click="go(m.homeEntry.to)">
          <AppIcon :name="m.homeEntry.icon" :size="24" />
          <div class="label">{{ m.homeEntry.title }}</div>
          <div class="hint">{{ hints[m.id] ?? '' }}</div>
        </button>
      </div>

      <template v-if="!ready || hasToday">
      <div class="section-title">今天</div>
      <div class="card">
        <Skeleton v-if="!ready" :row="3" />

        <template v-else>
          <!-- 待办在最上面：这是要你动手的部分 -->
          <div v-if="pendingItems.length" class="today-group">
            <div class="today-group-label">待办</div>
            <ul class="list">
              <li
                v-for="row in pendingItems"
                :key="row.task.id"
                class="list-item tap"
                @click="go('/task')"
              >
                <span class="avatar"><TaskIcon :icon="row.task.icon" :fallback="firstChar(row.task.title)" :size="22" /></span>
                <div class="grow">
                  <div class="ellipsis">{{ row.task.title }}</div>
                  <div class="tiny muted">{{ taskHint(row.task) }}</div>
                </div>
                <span class="due-chip" :class="row.chip.tone">{{ row.chip.text }}</span>
                <AppIcon name="chevron" :size="14" class="row-arrow" />
              </li>
            </ul>
          </div>

          <div v-if="eventItems.length" class="today-group">
            <div class="today-group-label">日程</div>
            <ul class="list">
              <li
                v-for="item in eventItems"
                :key="item.id"
                class="list-item tap"
                @click="openEvent(item.at)"
              >
                <span class="avatar"><TaskIcon :icon="item.icon || '📅'" :size="22" /></span>
                <div class="grow">
                  <div class="ellipsis">{{ item.title }}</div>
                  <div class="tiny muted">
                    {{ fmtTime(item.at) }}<span v-if="item.endAt">–{{ fmtTime(item.endAt) }}</span>
                  </div>
                </div>
                <AppIcon name="chevron" :size="14" class="row-arrow" />
              </li>
            </ul>
            <button
              v-if="events.length > eventItems.length"
              class="today-more"
              @click="go('/schedule')"
            >
              还有 {{ events.length - eventItems.length }} 条日程
            </button>
          </div>

          <div v-if="logItems.length" class="today-group">
            <div class="today-group-label">已完成</div>
            <ul class="list">
              <li v-for="item in logItems" :key="item.id" class="list-item">
                <span class="avatar done"><TaskIcon :icon="item.icon" fallback="✓" :size="22" /></span>
                <div class="grow">
                  <div class="ellipsis muted">{{ item.title }}</div>
                  <div class="tiny muted">{{ fmtTime(item.at) }}</div>
                </div>
              </li>
            </ul>
            <button v-if="logs.length > logItems.length" class="today-more" @click="go('/task')">
              还有 {{ logs.length - logItems.length }} 条记录
            </button>
          </div>
        </template>
      </div>
      </template>
    </div>
  </div>
</template>
