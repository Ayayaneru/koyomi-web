<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import { Capacitor } from '@capacitor/core'
import { showToast } from 'vant'
import AppHeader from '../../ui/AppHeader.vue'
import AppIcon from '../../ui/AppIcon.vue'
import { db, getConfig } from '../../core/db'
import {
  draftToEventRow,
  recognizeTimetable,
  resolveVisionConfig,
  visionFallback,
  type DraftItem,
  type VisionConfig
} from './importVlm'

const router = useRouter()
const vision = ref<VisionConfig | null>(null)
/** 视觉模型连不上时用来兜底的聊天模型（没有就是 null） */
const fallback = ref<VisionConfig | null>(null)
/** 输出格式坏掉时，用聊天模型把文本整理一遍（纯文本，不用再传图） */
const repairCfg = ref<{ baseUrl: string; model: string; apiKey: string } | null>(null)
const busy = ref(false)
const error = ref('')
/** 这一次是用聊天模型识别的（视觉模型没连上） */
const degradedNote = ref('')
const drafts = ref<DraftItem[]>([])
const skipped = ref(0)
const fileName = ref('')
const fileSize = ref('')
const previewUrl = ref('')
const elapsed = ref(0)
const importing = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
/** 上一次选的文件：识别失败时可以直接重试，不用再去相册翻一遍 */
const lastFile = shallowRef<File | null>(null)

const visionReady = computed(() => vision.value !== null)

/** 填的是智谱官网地址、又在浏览器里：直连一定被跨域拦，先在页面上说清楚 */
const directBlocked = computed(
  () => !Capacitor.isNativePlatform() && Boolean(vision.value && /open\.bigmodel\.cn/.test(vision.value.baseUrl))
)

onMounted(async () => {
  const cfg = await getConfig()
  vision.value = resolveVisionConfig(cfg)
  fallback.value = visionFallback(cfg)
  const llm = cfg.llm
  repairCfg.value =
    llm.baseUrl && llm.model && llm.apiKey
      ? { baseUrl: llm.baseUrl, model: llm.model, apiKey: llm.apiKey }
      : null
})

function pickFile() {
  if (!vision.value) return
  fileInput.value?.click()
}

function pickArea() {
  if (!vision.value || busy.value) return
  pickFile()
}

let timer: number | undefined
let controller: AbortController | null = null

function stopTimer() {
  if (timer !== undefined) {
    window.clearInterval(timer)
    timer = undefined
  }
  elapsed.value = 0
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** 选完立刻给缩略图 —— 不给反馈的话，分不清是没选上还是模型卡住了 */
function setPreview(file: File) {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = URL.createObjectURL(file)
  fileName.value = file.name
  fileSize.value = fmtSize(file.size)
}

function cancelRecognize() {
  controller?.abort()
}

onUnmounted(() => {
  stopTimer()
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
})

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  await startRecognize(file)
}

/** 模型抽风时不用重新选图，原图再跑一次就行 */
async function retry() {
  if (busy.value || !lastFile.value) return
  await startRecognize(lastFile.value)
}

async function startRecognize(file: File) {
  if (!vision.value) return

  lastFile.value = file

  // 换图时把上一次识别掐掉，避免两条结果互相覆盖
  controller?.abort()
  const ctrl = new AbortController()
  controller = ctrl

  setPreview(file)
  busy.value = true
  error.value = ''
  degradedNote.value = ''
  drafts.value = []
  skipped.value = 0
  elapsed.value = 0
  timer = window.setInterval(() => {
    elapsed.value += 1
  }, 1000)

  try {
    const result = await recognizeTimetable({
      file,
      cfg: vision.value,
      fallback: fallback.value ?? undefined,
      repair: repairCfg.value,
      signal: ctrl.signal
    })
    if (controller !== ctrl) return
    drafts.value = result.items
    skipped.value = result.skipped
    if (result.degraded) {
      degradedNote.value = `视觉模型 ${vision.value.model} 没连上，这次是聊天模型 ${result.usedModel} 识别的`
      showToast('视觉模型不可用，已降级用聊天模型识图')
    }
    if (result.repaired === 'llm') {
      showToast('模型输出的格式有点问题，已让聊天模型整理')
    }
    if (!result.items.length) error.value = '没有认出安排，换一张更清楚的图试试'
    else if (!result.degraded) showToast(`识别到 ${result.items.length} 条`)
  } catch (e) {
    if (controller !== ctrl) return
    if (ctrl.signal.aborted) showToast('已取消')
    else error.value = e instanceof Error ? e.message : '识别失败'
  } finally {
    if (controller === ctrl) {
      busy.value = false
      stopTimer()
      controller = null
    }
  }
}

function removeDraft(index: number) {
  drafts.value.splice(index, 1)
}

async function confirmImport() {
  if (!drafts.value.length) return
  importing.value = true
  try {
    const rows = drafts.value.map(draft => draftToEventRow(draft))
    await db.events.bulkAdd(rows)
    showToast(`已导入 ${rows.length} 条`)
    void router.replace('/schedule')
  } catch (e) {
    showToast(e instanceof Error ? e.message : '导入失败')
  } finally {
    importing.value = false
  }
}

const repeats = [
  { value: 'none', label: '就这一次' },
  { value: 'weekly', label: '每周' },
  { value: 'odd', label: '单周' },
  { value: 'even', label: '双周' }
]
</script>

<template>
  <div class="page">
    <AppHeader title="导入日程" back />
    <div class="page-body">
      <div class="card">
        <div class="small">
          选一张图片（截图、照片都行），模型逐条读出里面的日期和时间，给你改完再写进日程。
          <span class="muted">图片会发给你的模型供应商。</span>
        </div>

        <!-- 没选图：整块都能点 -->
        <div v-if="!previewUrl" class="pick-empty" :class="{ disabled: !visionReady }" @click="pickArea">
          <AppIcon name="image" :size="24" />
          <span class="small">{{ visionReady ? '点这里选一张图片' : '还没配能看图的模型' }}</span>
        </div>

        <!-- 选了图：立刻给缩略图，证明选上了 -->
        <div v-else class="pick-filled">
          <img class="pick-thumb" :src="previewUrl" alt="已选图片" />
          <div class="grow" style="min-width: 0">
            <div class="small ellipsis">{{ fileName }}</div>
            <div class="tiny muted">{{ fileSize }}</div>
            <button class="btn btn-sm" style="margin-top: 10px" :disabled="busy" @click="pickFile">
              换一张
            </button>
          </div>
        </div>

        <input ref="fileInput" type="file" accept="image/*" hidden @change="onFile" />

        <div v-if="busy" class="recognizing">
          <span class="spinner" />
          <span class="grow small">正在识别{{ elapsed ? `，已用 ${elapsed} 秒` : '…' }}</span>
          <button class="btn btn-ghost btn-sm" @click="cancelRecognize">取消</button>
        </div>

        <div v-if="!visionReady" class="banner" style="margin-top: 12px">
          <div class="grow small">
            还没配能看图的模型。去「模型设置」最下面填一段视觉模型（比如智谱 glm-4v-flash），或者给当前聊天模型勾上「支持图片」。
          </div>
          <button class="btn btn-sm" @click="router.push('/llm/settings')">去设置</button>
        </div>
        <div v-else-if="vision?.source === 'llm'" class="degrade-line" style="margin-top: 12px">
          <span class="degrade-tag">已降级</span>
          <span class="grow">
            视觉模型没配好，识图会用聊天模型 <b>{{ vision.model }}</b>
          </span>
          <button class="btn btn-ghost btn-sm" @click="router.push('/llm/settings')">去配</button>
        </div>
        <div v-else class="tiny muted" style="margin-top: 10px">
          识别用：{{ vision?.model }}
          <span v-if="fallback">，连不上会退回聊天模型 {{ fallback.model }}</span>
        </div>

        <!-- 这一次实际是降级跑的：说清楚用的哪个模型 -->
        <div v-if="degradedNote" class="degrade-line" style="margin-top: 10px">
          <span class="degrade-tag">已降级</span>
          <span class="grow">{{ degradedNote }}</span>
        </div>

        <!-- 浏览器 + 智谱官网地址 = 必然被跨域拦，提前说，别等报错 -->
        <div v-if="directBlocked && !degradedNote" class="degrade-line" style="margin-top: 10px">
          <span class="degrade-tag">连不上</span>
          <span class="grow">视觉模型填的是智谱官网地址，浏览器里会被跨域拦住</span>
          <button class="btn btn-ghost btn-sm" @click="router.push('/llm/settings')">去改</button>
        </div>

        <div v-if="error" class="error-row">
          <span class="error-text grow">{{ error }}</span>
          <button v-if="lastFile && !busy" class="btn btn-sm" @click="retry">重试</button>
        </div>
        <div v-if="skipped" class="tiny muted" style="margin-top: 8px">
          有 {{ skipped }} 行信息不全已跳过。
        </div>
      </div>

      <template v-if="drafts.length">
        <div class="section-title">识别结果（可以直接改）</div>
        <div class="tiny muted" style="margin: 0 2px 10px">
          每条就是日程里的一次安排。整学期的安排，把「重复」改成每周，再填到哪天。
        </div>

        <div v-for="(draft, index) in drafts" :key="index" class="card">
          <div class="row-between">
            <input v-model="draft.title" class="input grow" placeholder="标题" />
            <button class="btn btn-ghost" @click="removeDraft(index)">
              <AppIcon name="close" :size="16" />
            </button>
          </div>

          <div class="row" style="margin-top: 8px">
            <input v-model="draft.date" class="input" type="date" style="flex: 1; min-width: 0" />
            <select v-model="draft.repeat" class="select" style="flex: 1; min-width: 0">
              <option v-for="r in repeats" :key="r.value" :value="r.value">{{ r.label }}</option>
            </select>
          </div>

          <div class="row" style="margin-top: 8px">
            <input v-model="draft.startTime" class="input" type="time" style="flex: 1; min-width: 0" />
            <span class="muted">–</span>
            <input v-model="draft.endTime" class="input" type="time" style="flex: 1; min-width: 0" />
          </div>

          <div v-if="draft.repeat !== 'none'" class="row" style="margin-top: 8px">
            <span class="tiny muted" style="flex: none">重复到</span>
            <input v-model="draft.until" class="input" type="date" style="flex: 1; min-width: 0" />
            <span class="tiny muted" style="flex: none">留空=一直</span>
          </div>

          <div style="margin-top: 8px">
            <label class="label">地点</label>
            <input v-model="draft.location" class="input" placeholder="可留空" />
          </div>
        </div>

        <button class="btn btn-primary btn-block" :disabled="importing" @click="confirmImport">
          {{ importing ? '写入中…' : `确认导入 ${drafts.length} 条` }}
        </button>
        <div class="tiny muted" style="margin-top: 8px; text-align: center">
          识别可能漏行或编错，导入前请自己过一眼。
        </div>
      </template>

      <div class="card" style="margin-top: 14px">
        <div class="row-between">
          <div>
            <div class="k">换一个思路：手动录入</div>
            <div class="tiny muted">识别不准的时候，直接在日程页新建，还能设重复规则。</div>
          </div>
          <button class="btn btn-sm" style="flex: none; white-space: nowrap" @click="router.push('/schedule')">
            去新建
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
