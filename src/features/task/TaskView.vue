<script setup lang="ts">
import { computed, ref } from 'vue'
import { Popup, showToast } from 'vant'
import { vAutoAnimate } from '@formkit/auto-animate'
import AppHeader from '../../ui/AppHeader.vue'
import AppIcon from '../../ui/AppIcon.vue'
import TaskIcon from '../../ui/TaskIcon.vue'
import SchemaForm from '../../ui/SchemaForm.vue'
import { useLive } from '../../ui/useLive'
import type { JsonSchema } from '../../core/contracts'
import { db, type TaskLogRow, type TaskRow } from '../../core/db'
import { dayStart, fmtTime } from '../../core/time'
import { dueChip, isFinished, type DueChip } from './due'
import {
  closeTask,
  completeTask,
  createTask,
  deleteTask,
  reopenTask,
  setTaskEnabled,
  taskCreateTask,
  undoTaskLog
} from './tool'

const now = Date.now()

const tasks = useLive(() => db.tasks.toArray())
const allLogs = useLive(() => db.taskLogs.orderBy('doneAt').reverse().toArray())

const logs = computed(() => allLogs.value ?? [])
const recentLogs = computed(() => logs.value.slice(0, 3))

/** 每个任务做过几次（限次任务要靠它算进度） */
const counts = computed(() => {
  const map = new Map<string, number>()
  for (const log of logs.value) map.set(log.taskId, (map.get(log.taskId) ?? 0) + 1)
  return map
})
const doneCount = (task: TaskRow) => counts.value.get(task.id) ?? 0
const finished = (task: TaskRow) => isFinished(task, doneCount(task))

/** 要做的：没做完的，按到期时间排 */
const active = computed(() =>
  (tasks.value ?? [])
    .filter(task => !finished(task))
    .sort((a, b) => (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER))
)

/** 已完成：做够次数的、一次性做完的，最近完成的在前 */
const doneTasks = computed(() =>
  (tasks.value ?? [])
    .filter(finished)
    .sort(
      (a, b) =>
        (b.closedAt ?? b.lastDoneAt ?? b.updatedAt) - (a.closedAt ?? a.lastDoneAt ?? a.updatedAt)
    )
)
const recentDone = computed(() => doneTasks.value.slice(0, 3))

const TPL = [
  { title: '喂鱼', icon: '🐟', days: 3 },
  { title: '浇花', icon: '🌱', days: 7 },
  { title: '换滤芯', icon: '💧', days: 90 }
]

/* ---------- 新建 ---------- */

const editorOpen = ref(false)
const formValues = ref<Record<string, unknown>>({})

/** 按选中的类型只露该填的字段：一次性不用「每几天」，周期不用「做几次」 */
const createSchema = computed<JsonSchema>(() => {
  const base = taskCreateTask.parameters
  const properties = { ...base.properties }
  const kind = Number(formValues.value.kind ?? 1)
  if (kind === 0) {
    delete properties.intervalDays
    delete properties.limitCount
  } else if (kind === 1) {
    delete properties.limitCount
  }
  return { ...base, properties }
})
const formRef = ref<InstanceType<typeof SchemaForm> | null>(null)
const saving = ref(false)

function blankValues(): Record<string, unknown> {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  return {
    title: '',
    kind: 1,
    intervalDays: 3,
    limitCount: undefined,
    dueAt: `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(
      tomorrow.getDate()
    ).padStart(2, '0')} 09:00`
  }
}

function openCreate(template?: (typeof TPL)[number]) {
  const base = blankValues()
  if (template) {
    base.title = template.title
    base.icon = template.icon
    base.intervalDays = template.days
  }
  formValues.value = base
  editorOpen.value = true
}

async function save() {
  if (!formRef.value?.validate()) return
  saving.value = true
  try {
    const result = await createTask(formValues.value)
    if (!result.ok) {
      showToast(result.message ?? '保存失败')
      return
    }
    // 工具返回的文案带具体日期（给模型看的），界面上只说建好了，到期看右边标签
    showToast(`已创建「${String(formValues.value.title ?? '').trim()}」`)
    editorOpen.value = false
  } finally {
    saving.value = false
  }
}

/* ---------- 单条操作 ---------- */

const sheetId = ref<string | null>(null)
const sheetOpen = computed({
  get: () => sheetId.value !== null,
  set: (value: boolean) => {
    if (!value) sheetId.value = null
  }
})
const picked = computed(() => (tasks.value ?? []).find(task => task.id === sheetId.value) ?? null)
const pickedDone = computed(() => (picked.value ? finished(picked.value) : false))

/** 全部列表（完成记录 / 已完成的任务） */
const listMode = ref<'logs' | 'done' | null>(null)
const listOpen = computed({
  get: () => listMode.value !== null,
  set: (value: boolean) => {
    if (!value) listMode.value = null
  }
})

async function done(task: TaskRow) {
  const result = await completeTask({ taskId: task.id })
  if (!result.ok) {
    showToast(result.message ?? '完成失败')
    return
  }

  if (task.kind === 2) {
    const data = result.data as { doneCount?: number; nextDueAt?: number } | undefined
    const limit = Math.max(1, task.limitCount ?? 1)
    const count = data?.doneCount ?? limit
    if (!data?.nextDueAt) {
      showToast(`第 ${count}/${limit} 次，这个任务结束了`)
      return
    }
    const chip = dueChip({ kind: 2, enabled: true, dueAt: data.nextDueAt }, Date.now())
    showToast(`第 ${count}/${limit} 次，${chip.text}`)
    return
  }

  showToast(`已完成「${task.title}」`)
}

async function undo(log: TaskLogRow) {
  await undoTaskLog(log)
  showToast('已撤销这次完成')
}

async function remove(task: TaskRow) {
  const result = await deleteTask({ taskId: task.id })
  showToast(result.message ?? '已删除')
}

async function sheetDone() {
  const task = picked.value
  sheetId.value = null
  if (task) await done(task)
}

async function sheetToggle() {
  const task = picked.value
  sheetId.value = null
  if (!task) return
  await setTaskEnabled(task.id, !task.enabled)
  showToast(task.enabled ? '已关闭提醒' : '已打开提醒')
}

/** 「完成任务」：一次性等于记一笔 + 归档；周期/限次是直接结束，不记一次 */
async function sheetFinish() {
  const task = picked.value
  sheetId.value = null
  if (!task) return
  if (task.kind === 0) {
    await done(task)
    return
  }
  await closeTask(task.id)
  showToast(`「${task.title}」已结束`)
}

async function sheetReopen() {
  const task = picked.value
  sheetId.value = null
  if (!task) return
  await reopenTask(task.id)
  showToast('已回到「要做的」')
}

async function sheetRemove() {
  const task = picked.value
  sheetId.value = null
  if (task) await remove(task)
}

/** 从“全部”列表里点任务：收掉列表，开操作面板 */
function openFromList(task: TaskRow) {
  listMode.value = null
  sheetId.value = task.id
}

/* ---------- 文案 ---------- */

function intervalText(task: TaskRow): string {
  if (task.kind === 0) return '一次性'
  const base = `每 ${task.intervalDays ?? 1} 天`
  // 已经归档的任务不用再说「提醒已关」，那是给待办里的任务看的
  const off = !task.enabled && !finished(task) ? ' · 提醒已关' : ''
  if (task.kind === 2) {
    const limit = Math.max(1, task.limitCount ?? 1)
    return `${base} · ${Math.min(doneCount(task), limit)}/${limit} 次${off}`
  }
  return `${base}${off}`
}

/** 右边的标签：做完了统一写「已完成」，其余说到期还有几天 */
function chipOf(task: TaskRow): DueChip {
  if (finished(task)) return { text: '已完成', tone: 'done' }
  return dueChip(task, now)
}

function firstChar(text: string): string {
  return Array.from(text)[0] ?? '·'
}

/** 完成记录里的时间：近几天说「今天/昨天」，再早才写月日 */
function logTime(ts: number): string {
  const days = Math.round((dayStart(ts) - dayStart(now)) / 86_400_000)
  if (days === 0) return `今天 ${fmtTime(ts)}`
  if (days === -1) return `昨天 ${fmtTime(ts)}`
  if (days === -2) return `前天 ${fmtTime(ts)}`
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${fmtTime(ts)}`
}

const sourceText = (source: number) => (source === 1 ? '模型' : source === 2 ? '自动' : '手动')
</script>

<template>
  <div class="page">
    <AppHeader title="任务" back>
      <template #right>
        <button class="icon-btn" aria-label="新建任务" @click="openCreate()">
          <AppIcon name="plus" :size="20" />
        </button>
      </template>
    </AppHeader>

    <div class="page-body">
      <div class="section-title">要做的</div>
      <ul v-auto-animate="{ duration: 180 }" class="task-list">
        <li v-if="!active.length" class="task-empty">
          没有待办了。下面有几个预填好的例子，点一下就能加。
        </li>
        <li v-for="task in active" :key="task.id" class="task-row" @click="sheetId = task.id">
          <button class="task-check" :aria-label="`完成 ${task.title}`" @click.stop="done(task)">
            <AppIcon name="check" :size="14" />
          </button>
          <span class="task-icon"><TaskIcon :icon="task.icon" :fallback="firstChar(task.title)" :size="26" /></span>
          <div class="task-main">
            <div class="task-title">{{ task.title }}</div>
            <div class="task-sub">{{ intervalText(task) }}</div>
          </div>
          <span class="due-chip" :class="chipOf(task).tone">{{ chipOf(task).text }}</span>
        </li>
      </ul>
      <div v-if="active.length" class="task-hint">点圆圈直接完成，点这一行还能关提醒或删除。</div>

      <template v-if="doneTasks.length">
        <div class="section-title">已完成</div>
        <ul class="task-list indent">
          <li
            v-for="task in recentDone"
            :key="task.id"
            class="task-row"
            @click="sheetId = task.id"
          >
            <span class="task-icon"><TaskIcon :icon="task.icon" :fallback="firstChar(task.title)" :size="26" /></span>
            <div class="task-main">
              <div class="task-title off">{{ task.title }}</div>
              <div class="task-sub">{{ intervalText(task) }}</div>
            </div>
            <span class="due-chip done">已完成</span>
          </li>
        </ul>
        <button v-if="doneTasks.length > 3" class="more-link" @click="listMode = 'done'">
          查看全部 {{ doneTasks.length }} 个已完成
        </button>
      </template>

      <div class="section-title">最近做完的</div>
      <ul class="list card log-list">
        <li v-if="!logs.length" class="empty" style="padding: 16px 0">还没有完成记录</li>
        <li v-for="log in recentLogs" :key="log.id" class="list-item">
          <button class="task-check undo" aria-label="撤销这次完成" @click="undo(log)">
            <AppIcon name="close" :size="13" />
          </button>
          <span class="task-icon"><TaskIcon :icon="log.taskIcon" :fallback="firstChar(log.taskTitle)" :size="26" /></span>
          <div class="grow">
            <div class="ellipsis">{{ log.taskTitle }}</div>
            <div class="tiny muted">
              {{ logTime(log.doneAt) }}
              <span v-if="log.source !== 0"> · {{ sourceText(log.source) }}</span>
              <span v-if="log.note"> · {{ log.note }}</span>
            </div>
          </div>
        </li>
      </ul>
      <button v-if="logs.length > 3" class="more-link" @click="listMode = 'logs'">
        查看全部 {{ logs.length }} 条记录
      </button>

      <div class="section-title">从模板开始</div>
      <div class="chips">
        <button v-for="t in TPL" :key="t.title" class="chip chip-icon" @click="openCreate(t)">
          <TaskIcon :icon="t.icon" :size="17" />
          {{ t.title }} · {{ t.days }} 天
        </button>
        <button class="chip" @click="openCreate()">空白</button>
      </div>
    </div>

    <!-- 点任务行弹出的操作面板 -->
    <Popup v-model:show="sheetOpen" position="bottom" round>
      <div v-if="picked" class="sheet">
        <div class="sheet-head">
          <span class="task-icon"><TaskIcon :icon="picked.icon" :fallback="firstChar(picked.title)" /></span>
          <div class="grow">
            <div class="sheet-title">{{ picked.title }}</div>
            <div class="task-sub">{{ intervalText(picked) }} · {{ chipOf(picked).text }}</div>
          </div>
        </div>
        <button v-if="!pickedDone" class="sheet-item" @click="sheetDone">完成一次</button>
        <button v-if="!pickedDone" class="sheet-item" @click="sheetFinish">完成任务</button>
        <button v-if="!pickedDone" class="sheet-item" @click="sheetToggle">
          {{ picked.enabled ? '关闭提醒' : '打开提醒' }}
        </button>
        <button v-if="pickedDone && picked.closedAt" class="sheet-item" @click="sheetReopen">
          恢复任务
        </button>
        <button class="sheet-item danger" @click="sheetRemove">删除任务</button>
        <button class="sheet-item cancel" @click="sheetId = null">取消</button>
      </div>
    </Popup>

    <!-- 全部完成记录 / 全部已完成的任务 -->
    <Popup v-model:show="listOpen" position="bottom" round :style="{ maxHeight: '82%' }">
      <div class="list-sheet">
        <div class="sheet-head">
          <div class="grow">
            <div class="sheet-title">{{ listMode === 'logs' ? '完成记录' : '已完成的任务' }}</div>
            <div class="task-sub">
              {{ listMode === 'logs' ? `${logs.length} 条` : `${doneTasks.length} 个` }}
            </div>
          </div>
          <button class="icon-btn" aria-label="关闭" @click="listMode = null">
            <AppIcon name="close" :size="18" />
          </button>
        </div>

        <div class="list-sheet-body">
          <ul v-if="listMode === 'logs'" class="list log-list">
            <li v-for="log in logs" :key="log.id" class="list-item">
              <button class="task-check undo" aria-label="撤销这次完成" @click="undo(log)">
                <AppIcon name="close" :size="13" />
              </button>
              <span class="task-icon"><TaskIcon :icon="log.taskIcon" :fallback="firstChar(log.taskTitle)" :size="26" /></span>
              <div class="grow">
                <div class="ellipsis">{{ log.taskTitle }}</div>
                <div class="tiny muted">
                  {{ logTime(log.doneAt) }}
                  <span v-if="log.source !== 0"> · {{ sourceText(log.source) }}</span>
                  <span v-if="log.note"> · {{ log.note }}</span>
                </div>
              </div>
            </li>
          </ul>

          <ul v-else class="task-list bare">
            <li
              v-for="task in doneTasks"
              :key="task.id"
              class="task-row"
              @click="openFromList(task)"
            >
              <span class="task-icon sm"><TaskIcon :icon="task.icon" :fallback="firstChar(task.title)" :size="23" /></span>
              <div class="task-main">
                <div class="task-title off">{{ task.title }}</div>
                <div class="task-sub">{{ intervalText(task) }}</div>
              </div>
              <span class="due-chip done">已完成</span>
            </li>
          </ul>
        </div>
      </div>
    </Popup>

    <Popup v-model:show="editorOpen" position="bottom" round :style="{ maxHeight: '86%' }">
      <div style="padding: 16px 16px 24px; overflow-y: auto; max-height: 86vh">
        <div class="row-between" style="margin-bottom: 14px">
          <div style="font-size: 16px; font-weight: 600">新建任务</div>
          <!-- 2026-11-01：保存从底部搬到右上角（和日程 / 日记一致），原来的「关闭」删掉 -->
          <button class="btn btn-primary btn-sm btn-act" :disabled="saving" @click="save">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>

        <SchemaForm ref="formRef" :schema="createSchema" v-model="formValues" />

        <div class="tiny muted" style="margin-top: 14px">
          「一次性」要填到期时间；「周期」一直重复；「限次」每 N 天一次、做够次数就结束。图标不选就显示标题首字。
        </div>
      </div>
    </Popup>
  </div>
</template>
