<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { Popup, showConfirmDialog, showToast } from 'vant'
import { vAutoAnimate } from '@formkit/auto-animate'
import AppHeader from '../../ui/AppHeader.vue'
import AppIcon from '../../ui/AppIcon.vue'
import MoodIcon from '../../ui/MoodIcon.vue'
import { useLive } from '../../ui/useLive'
import { db, DEFAULT_DIARY_TAGS, patchConfig, type DiaryRow, type DiaryTag } from '../../core/db'
import { dayStart, fmtDate, fromInputDate, parseLocal, weekdayName } from '../../core/time'
import { newId } from '../../core/crypto'
import { renameTagInText, splitTags } from './diaryTags'

const entries = useLive(() => db.diary.orderBy('date').reverse().toArray())

const MOODS = [
  { value: '😀', label: '开心' },
  { value: '🙂', label: '还行' },
  { value: '😐', label: '平静' },
  { value: '😔', label: '低落' },
  { value: '😡', label: '烦' }
]

const todayStart = dayStart(Date.now())
const editorOpen = ref(false)
const editing = ref<DiaryRow | null>(null)
/** 正文/标题拿到焦点 = 输入法弹起来了：把标签区收掉，正文能多占一块 */
const typing = ref(false)
const form = ref({ date: fmtDate(Date.now()), title: '', content: '', tags: [] as string[], mood: '' })

/** 每篇最多贴 3 个 */
const MAX_TAGS = 3
/** 新建标签时可选的 8 个色，和候选页一致 */
const TAG_COLORS = ['#3f5f4f', '#9a6a12', '#4a5f7a', '#6b7f4a', '#7a5a7f', '#2f6f7a', '#a8322d', '#6b6862']

const cfg = useLive(() => db.config.get('app'))
/** 不填 = 用默认那 8 个；空数组 = 一个都没有 */
const allTags = computed<DiaryTag[]>(() => cfg.value?.prefs?.diaryTags ?? DEFAULT_DIARY_TAGS)

/** 标签找不到（比如被删了）就退回灰色，不报错 */
function tagColor(name: string): string {
  return allTags.value.find(tag => tag.name === name)?.color ?? '#6b6862'
}

/** 浅底胶囊：文字用标签色，底色是同色 12% */
function chipStyle(name: string) {
  const color = tagColor(name)
  return { color, background: `${color}1f` }
}

function toggleFormTag(name: string) {
  const list = form.value.tags
  const at = list.indexOf(name)
  if (at >= 0) list.splice(at, 1)
  else if (list.length >= MAX_TAGS) showToast(`最多贴 ${MAX_TAGS} 个标签`)
  else list.push(name)
}

const newTagName = ref('')
const newTagColor = ref(TAG_COLORS[0])
const tagsOpen = ref(false)
const editingColor = ref('')

async function saveTags(list: DiaryTag[]) {
  await patchConfig({ prefs: { diaryTags: list } })
}

/** 新建：已经有的同名标签就直接选上，不重复建 */
async function addNewTag() {
  // 标签名里不能有逗号/空格：库里是用逗号分隔存的
  const name = newTagName.value.trim().replace(/^#/, '').replace(/[,，\s]+/g, '')
  if (!name) return
  if (!allTags.value.some(tag => tag.name === name)) {
    await saveTags([...allTags.value, { name, color: newTagColor.value }])
  }
  if (!form.value.tags.includes(name)) toggleFormTag(name)
  newTagName.value = ''
}

async function removeTag(tag: DiaryTag) {
  try {
    await showConfirmDialog({
      title: '删除这个标签？',
      message: `${tag.name} —— 已经用过它的日记不会变，只是它不再出现在常用里`,
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      className: 'is-danger'
    })
  } catch {
    return
  }
  await saveTags(allTags.value.filter(item => item.name !== tag.name))
  form.value.tags = form.value.tags.filter(name => name !== tag.name)
}

async function setTagColor(tag: DiaryTag, color: string) {
  await saveTags(allTags.value.map(item => (item.name === tag.name ? { ...item, color } : item)))
  editingColor.value = ''
}

/* ---------- 原地改名：点名字就开始输，回车或点别处落地 ---------- */

const renamingTag = ref('')
const nameDraft = ref('')
const sheetRef = ref<HTMLElement | null>(null)

function startRename(tag: DiaryTag) {
  renamingTag.value = tag.name
  nameDraft.value = tag.name
  // 输入框是 v-if 现渲染出来的，要等这一帧过去才拿得到
  void nextTick(() => {
    const input = sheetRef.value?.querySelector<HTMLInputElement>('.tag-name-input')
    input?.focus()
    input?.select()
  })
}

function cancelRename() {
  renamingTag.value = ''
}

/**
 * 退出编辑（回车、失焦、点别处）就保存。
 * 先把 renamingTag 清掉再干活：回车之后浏览器还会补一次 blur，
 * 那次进来时已经对不上名字，直接返回，不会重复写库。
 */
async function commitRename(tag: DiaryTag) {
  if (renamingTag.value !== tag.name) return
  const raw = nameDraft.value
  renamingTag.value = ''
  // 和新建标签一样：去掉 #、逗号、空格（库里是用逗号分隔存的）
  const name = raw.trim().replace(/^#/, '').replace(/[,，\s]+/g, '')
  if (!name || name === tag.name) return
  if (allTags.value.some(item => item.name === name)) {
    showToast('已经有同名标签了')
    return
  }

  // 1) 先改标签表
  await saveTags(allTags.value.map(item => (item.name === tag.name ? { ...item, name } : item)))
  // 2) 用过旧名字的日记跟着改，否则那些标签会变成灰色的孤儿
  await db.transaction('rw', db.diary, async () => {
    for (const row of await db.diary.toArray()) {
      const next = renameTagInText(row.tags, tag.name, name)
      if (next != null) await db.diary.update(row.id, { tags: next })
    }
  })
  // 3) 正在编辑的这篇如果贴了旧标签，跟着换
  if (form.value.tags.includes(tag.name)) {
    form.value.tags = form.value.tags.map(item => (item === tag.name ? name : item))
  }
  showToast('已改名')
}
const saving = ref(false)
const keyword = ref('')
const searchOpen = ref(false)
const onlyPinned = ref(false)

const filtered = computed(() => {
  const list = entries.value ?? []
  const key = keyword.value.trim()
  return list.filter(row => {
    if (onlyPinned.value && !row.pinned) return false
    if (!key) return true
    return [row.title, row.content, row.tags ?? ''].some(text => text.includes(key))
  })
})

interface DiaryCard {
  row: DiaryRow
  day: string
  week: string
  isToday: boolean
}

/** 置顶单独一组，其余按月份倒序分组 */
const groups = computed(() => {
  const list = filtered.value
  const pinned = list.filter(row => row.pinned)
  const rest = list.filter(row => !row.pinned)

  const byMonth = new Map<string, DiaryRow[]>()
  for (const row of rest) {
    const d = new Date(row.date)
    const label = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`
    const bucket = byMonth.get(label)
    if (bucket) bucket.push(row)
    else byMonth.set(label, [row])
  }

  const toCard = (row: DiaryRow): DiaryCard => ({
    row,
    day: String(new Date(row.date).getDate()).padStart(2, '0'),
    week: weekdayName(row.date),
    isToday: dayStart(row.date) === todayStart
  })

  const out: { label: string; count: number; items: DiaryCard[] }[] = []
  if (pinned.length) out.push({ label: '置顶', count: pinned.length, items: pinned.map(toCard) })
  for (const [label, rows] of byMonth) {
    out.push({ label, count: rows.length, items: rows.map(toCard) })
  }
  return out
})

const total = computed(() => entries.value?.length ?? 0)
const todayEntry = computed(
  () => (entries.value ?? []).find(row => dayStart(row.date) === todayStart) ?? null
)
const todayLabel = computed(() => `${fmtDate(todayStart).slice(5).replace('-', ' 月 ')} 日`)

/** 关搜索时把过滤一起清掉，免得列表被看不见的条件筛着 */
function toggleSearch() {
  if (searchOpen.value) {
    keyword.value = ''
    onlyPinned.value = false
  }
  searchOpen.value = !searchOpen.value
}

function openCreate(mood = '') {
  editing.value = null
  form.value = { date: fmtDate(Date.now()), title: '', content: '', tags: [], mood }
  editorOpen.value = true
}

function openEdit(row: DiaryRow) {
  editing.value = row
  form.value = {
    date: fmtDate(row.date),
    title: row.title,
    content: row.content,
    tags: splitTags(row.tags),
    mood: row.mood ?? ''
  }
  editorOpen.value = true
}

async function save() {
  if (!form.value.content.trim()) {
    showToast('正文不能为空')
    return
  }
  saving.value = true
  try {
    const base = {
      date: dayStart(fromInputDate(form.value.date)),
      title: form.value.title.trim() || fmtDate(parseLocal(form.value.date)),
      content: form.value.content,
      // 库里仍然是逗号分隔的字符串，老数据不用迁
      tags: form.value.tags.join(','),
      mood: form.value.mood || undefined,
      updatedAt: Date.now()
    }

    if (editing.value) {
      await db.diary.update(editing.value.id, base)
      showToast('已保存')
    } else {
      // 界面写日记直接用库：工具那条路受「是否开放给模型」的开关管，不该拦住自己写
      const now = Date.now()
      await db.diary.add({ id: newId('dy'), ...base, createdAt: now })
      showToast('已写入')
    }
    editorOpen.value = false
  } finally {
    saving.value = false
  }
}

async function togglePin(row: DiaryRow) {
  const next = !row.pinned
  await db.diary.update(row.id, { pinned: next, updatedAt: Date.now() })
  if (editing.value?.id === row.id) editing.value = { ...editing.value, pinned: next }
}

async function remove(row: DiaryRow) {
  try {
    await showConfirmDialog({
      title: '删除这篇日记？',
      message: row.title,
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      className: 'is-danger'
    })
  } catch {
    return
  }
  await db.diary.delete(row.id)
  if (editing.value?.id === row.id) editorOpen.value = false
  showToast('已删除')
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 100 ? `${flat.slice(0, 100)}…` : flat
}

function wordCount(text: string): number {
  return text.replace(/\s/g, '').length
}
</script>

<template>
  <div class="page">
    <AppHeader title="日记" back>
      <template #right>
        <button class="icon-btn" aria-label="搜索" @click="toggleSearch">
          <AppIcon name="search" :size="19" />
        </button>
        <button class="icon-btn" aria-label="写日记" @click="openCreate()">
          <AppIcon name="plus" :size="20" />
        </button>
      </template>
    </AppHeader>

    <div class="page-body">
      <div v-if="searchOpen" class="diary-search">
        <input v-model="keyword" class="input grow" placeholder="搜索标题、正文、标签" autofocus />
        <button class="chip" :class="{ on: onlyPinned }" @click="onlyPinned = !onlyPinned">置顶</button>
      </div>

      <!-- 今天：写一句就够，先给个入口 -->
      <div class="diary-hero" :class="{ written: Boolean(todayEntry) }">
        <div class="row-between" style="align-items: flex-start">
          <div>
            <div class="dh-day">今天</div>
            <div class="dh-date">{{ todayLabel }} · {{ weekdayName(todayStart) }}</div>
          </div>
          <AppIcon name="book" :size="22" class="dh-icon" />
        </div>

        <template v-if="todayEntry">
          <div class="dh-written" @click="openEdit(todayEntry)">
            <MoodIcon v-if="todayEntry.mood" :mood="todayEntry.mood" :size="20" class="dh-mood" />
            <span class="grow ellipsis">{{ todayEntry.title }}</span>
            <AppIcon name="chevron" :size="14" class="muted" />
          </div>
          <button class="btn btn-ghost btn-sm" style="margin-top: 8px" @click="openCreate()">
            再写一篇
          </button>
        </template>

        <template v-else>
          <div class="dh-prompt">今天想记点什么？</div>
          <div class="dh-moods">
            <button
              v-for="mood in MOODS"
              :key="mood.value"
              type="button"
              class="mood-chip"
              :title="mood.label"
              @click="openCreate(mood.value)"
            >
              <MoodIcon :mood="mood.value" :size="26" />
            </button>
          </div>
        </template>
      </div>

      <div class="tiny muted diary-count">
        共 {{ total }} 篇{{ keyword ? `，匹配 ${filtered.length} 篇` : '' }} · 日记明文存在本机，写之前不用解锁密码库
      </div>

      <div v-if="!filtered.length" class="diary-empty">
        <AppIcon name="book" :size="26" />
        <div>{{ total ? '没有匹配的日记' : '还没有日记，从今天开始吧' }}</div>
      </div>

      <template v-for="group in groups" :key="group.label">
        <div class="diary-month">
          <span>{{ group.label }}</span>
          <span class="tiny muted">{{ group.count }} 篇</span>
        </div>

        <ul v-auto-animate="{ duration: 180 }" class="diary-timeline">
          <li
            v-for="item in group.items"
            :key="item.row.id"
            class="diary-item"
            @click="openEdit(item.row)"
          >
            <div class="diary-date" :class="{ today: item.isToday }">
              <span class="dd-day">{{ item.day }}</span>
              <span class="dd-week">{{ item.week }}</span>
            </div>

            <div class="diary-card">
              <div class="dc-head">
                <MoodIcon v-if="item.row.mood" :mood="item.row.mood" :size="19" class="dc-mood" />
                <span class="dc-title ellipsis">{{ item.row.title }}</span>
                <AppIcon v-if="item.row.pinned" name="star" :size="13" class="dc-pin" />
              </div>
              <div class="dc-excerpt">{{ excerpt(item.row.content) }}</div>
              <div class="dc-foot">
                <span
                  v-for="tag in splitTags(item.row.tags).slice(0, 3)"
                  :key="tag"
                  class="dc-tag"
                  :style="chipStyle(tag)"
                >
                  {{ tag }}
                </span>
                <span class="tiny muted dc-words">{{ wordCount(item.row.content) }} 字</span>
              </div>
            </div>
          </li>
        </ul>
      </template>
    </div>

    <Popup v-model:show="editorOpen" position="bottom" round :style="{ height: '92%' }">
      <!-- 输入法一出来就把标签区收掉（.typing），正文能多占一百来像素 -->
      <div class="diary-editor" :class="{ typing }">
        <div class="de-top">
          <button class="btn btn-ghost" @click="editorOpen = false">关闭</button>
          <input
            class="de-date"
            type="date"
            :value="form.date"
            @change="form.date = ($event.target as HTMLInputElement).value"
          />
          <!-- 2026-11-01：删除从底部搬到右上角、保存左边，和保存同一个 btn-sm 尺寸；日期框让位 -->
          <button v-if="editing" class="btn btn-danger btn-sm btn-act" @click="remove(editing)">
            <AppIcon name="trash" :size="13" /> 删除
          </button>
          <button class="btn btn-primary btn-sm btn-act" :disabled="saving" @click="save">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>

        <div class="de-moods">
          <button
            v-for="mood in MOODS"
            :key="mood.value"
            type="button"
            class="mood-chip"
            :class="{ on: form.mood === mood.value }"
            :title="mood.label"
            @click="form.mood = form.mood === mood.value ? '' : mood.value"
          >
            <MoodIcon :mood="mood.value" :size="27" />
          </button>
        </div>

        <input
          v-model="form.title"
          class="de-title"
          placeholder="标题（不填就用日期）"
          @focus="typing = true"
          @blur="typing = false"
        />
        <textarea
          v-model="form.content"
          class="de-body"
          placeholder="今天发生了什么…"
          @focus="typing = true"
          @blur="typing = false"
        />

        <div class="de-tagbox">
          <div class="de-taghead">
            <span class="de-taglabel">标签</span>
            <span v-if="!form.tags.length" class="tiny muted">不贴也行</span>
            <button
              v-for="tag in form.tags"
              :key="tag"
              class="pick-chip"
              :style="chipStyle(tag)"
              @click="toggleFormTag(tag)"
            >
              {{ tag }}<span class="pk-x">×</span>
            </button>
            <span class="tiny muted de-tagcount">{{ form.tags.length }}/3</span>
          </div>

          <div class="de-sug">
            <button
              v-for="tag in allTags"
              :key="tag.name"
              class="sug-chip"
              :class="{ on: form.tags.includes(tag.name), dim: !form.tags.includes(tag.name) && form.tags.length >= 3 }"
              :style="form.tags.includes(tag.name) ? chipStyle(tag.name) : undefined"
              @click="toggleFormTag(tag.name)"
            >
              <i :style="{ background: tag.color }"></i>{{ tag.name }}
            </button>
            <!-- 2026-11-01：新建标签 / 置顶都排到已有标签后面，宽度和标签胶囊一致（见 .de-sug .act-chip） -->
            <button class="sug-chip tag-entry" @click="tagsOpen = true">
              <AppIcon name="plus" :size="11" />标签
            </button>
            <button
              v-if="editing"
              class="sug-chip pin-entry"
              :class="{ on: editing.pinned }"
              @click="togglePin(editing)"
            >
              <AppIcon name="star" :size="11" />置顶
            </button>
          </div>
        </div>

        <div class="de-tagfoot">
          <span class="tiny muted">{{ wordCount(form.content) }} 字</span>
        </div>
      </div>
    </Popup>

    <Popup v-model:show="tagsOpen" position="bottom" round>
      <div ref="sheetRef" class="tag-sheet">
        <div class="tag-sheet-head">
          <span class="grow">管理标签</span>
          <button class="btn btn-ghost btn-sm" @click="tagsOpen = false">关闭</button>
        </div>

        <ul class="tag-sheet-list">
          <li v-for="tag in allTags" :key="tag.name" class="tag-row">
            <button
              class="tag-dot"
              :style="{ background: tag.color }"
              aria-label="换颜色"
              @click="editingColor = editingColor === tag.name ? '' : tag.name"
            />
            <!-- 点名字就地改：不给「改名」按钮，退出输入（回车 / 点别处）就保存 -->
            <input
              v-if="renamingTag === tag.name"
              v-model="nameDraft"
              class="tag-name-input grow"
              maxlength="12"
              @blur="commitRename(tag)"
              @keyup.enter="commitRename(tag)"
              @keyup.esc="cancelRename"
            />
            <span v-else class="tag-name grow" @click="startRename(tag)">{{ tag.name }}</span>
            <button class="btn btn-ghost btn-sm" @click="removeTag(tag)">删除</button>
            <div v-if="editingColor === tag.name" class="tag-colors">
              <button
                v-for="color in TAG_COLORS"
                :key="color"
                class="de-color"
                :class="{ on: tag.color === color }"
                :style="{ background: color }"
                @click="setTagColor(tag, color)"
              />
            </div>
          </li>
          <li v-if="!allTags.length" class="empty" style="padding: 14px 0">还没有标签，在下面加一个</li>
        </ul>

        <div class="tag-sheet-new">
          <input v-model="newTagName" class="de-newtag-input" placeholder="新标签名" @keyup.enter="addNewTag" />
          <div class="de-colors">
            <button
              v-for="color in TAG_COLORS"
              :key="color"
              class="de-color"
              :class="{ on: newTagColor === color }"
              :style="{ background: color }"
              :aria-label="`颜色 ${color}`"
              @click="newTagColor = color"
            />
          </div>
          <button class="btn btn-primary btn-sm" :disabled="!newTagName.trim()" @click="addNewTag">加</button>
        </div>

        <div class="tag-sheet-foot tiny muted">
          点名字直接改，点左边的色点换颜色。删掉标签不会改动已经写过的那几篇。
        </div>
      </div>
    </Popup>
  </div>
</template>
