<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Popup, showToast } from 'vant'
import AppHeader from '../../ui/AppHeader.vue'
import AppIcon from '../../ui/AppIcon.vue'
import SchemaForm from '../../ui/SchemaForm.vue'
import { useLiveOn } from '../../ui/useLiveOn'
import { getConfig, type EventRow } from '../../core/db'
import type { JsonSchema } from '../../core/contracts'
import { lunarOf } from '../../core/lunar'
import { solarTermOf } from '../../core/solarTerms'
import {
  addDays,
  addMonths,
  dayStart,
  fmtDate,
  fmtDateTime,
  fmtTime,
  hourLabel,
  mondayOf,
  monthCells,
  weekDayLabels,
  weekStartOf,
  weekdayName,
  type WeekStart
} from '../../core/time'
import {
  agendaInRange,
  inRange,
  loadAgenda,
  SLOT_COUNT,
  SLOT_HOURS,
  SLOT_START_HOUR,
  slotIndexOf,
  slotItemsIn,
  type AgendaItem,
  type AgendaKind
} from './agenda'
import { DEFAULT_FESTIVALS, festivalOf } from './festivals'
import { holidayOf, holidayVersion } from './holidays'
import { scheduleCreateEvent, scheduleDeleteEvent, scheduleUpdateEvent } from './tool'

const route = useRoute()
const router = useRouter()

/** 只保留周 / 月。一天里就几件事，首页「今天」已经覆盖了 */
type View = 'week' | 'month'
const view = ref<View>('week')
const cursor = ref(dayStart(Date.now()))
/** 周表两小时一格：08–10 … 20–22，一共 7 格，格子高一点好点 */
const HOUR_START = SLOT_START_HOUR
const HOUR_COUNT = SLOT_COUNT * SLOT_HOURS
const hours = Array.from({ length: SLOT_COUNT }, (_, i) => HOUR_START + i * SLOT_HOURS)
/** 周表 / 月表各自的起点：0 = 周日，1 = 周一，读设置里的 prefs.calendar */
const weekStart = ref<WeekStart>(0)
const monthStart = ref<WeekStart>(0)
/** 表头只留一个字，顺序跟着周起始日走 */
const DOW = computed(() => weekDayLabels(weekStart.value))
const todayStart = dayStart(Date.now())

/* 选中：哪一天 + 哪个小时；周视图默认落在「现在这个整点」 */
const nowHour = (() => {
  const h = new Date().getHours()
  const slot = Math.floor((h - HOUR_START) / SLOT_HOURS) * SLOT_HOURS + HOUR_START
  return Math.min(HOUR_START + HOUR_COUNT - SLOT_HOURS, Math.max(HOUR_START, slot))
})()
const selectedDay = ref(todayStart)
const selectedHour = ref<number | null>(nowHour)
const enabledFestivals = ref<string[]>([...DEFAULT_FESTIVALS])

onMounted(async () => {
  const cfg = await getConfig()
  enabledFestivals.value = [...(cfg.prefs.festivals ?? DEFAULT_FESTIVALS)]
  weekStart.value = cfg.prefs.calendar?.weekStart ?? 0
  monthStart.value = cfg.prefs.calendar?.monthStart ?? 0

  // 从首页的「日程」点进来（/schedule?at=…）：选中那一条的时段，而不是「现在」
  const at = Number(route.query.at)
  if (Number.isFinite(at) && at > 0) {
    cursor.value = dayStart(at)
    view.value = 'week'
    const h = new Date(at).getHours()
    const slot = Math.floor((h - HOUR_START) / SLOT_HOURS) * SLOT_HOURS + HOUR_START
    selectSlot(dayStart(at), Math.min(HOUR_START + HOUR_COUNT - SLOT_HOURS, Math.max(HOUR_START, slot)))
    void router.replace({ path: '/schedule' })
  }
})

function repeatLabel(row: EventRow): string {
  if (row.repeatKind === 0) return ''
  if (row.repeatKind === 1) return '每天重复'
  if (row.repeatKind === 3) return `每 ${row.repeatEveryN ?? 1} 天重复`
  if (row.weekParity === 1) return '每周重复（单周）'
  if (row.weekParity === 2) return '每周重复（双周）'
  return '每周重复'
}

function selectDay(ts: number) {
  selectedDay.value = ts
  // 点「日期」= 整天；只有点具体时间段才有小时
  selectedHour.value = null
}

function selectSlot(ts: number, hour: number) {
  selectedDay.value = ts
  selectedHour.value = hour
}


/* ---------- 时间范围 ---------- */

const range = computed(() => {
  if (view.value === 'week') {
    const start = weekStartOf(cursor.value, weekStart.value)
    return { start, end: addDays(start, 7) }
  }
  const list = monthCells(cursor.value, monthStart.value)
  return { start: list[0].ts, end: addDays(list[list.length - 1].ts, 1) }
})

const source = useLiveOn(range, r => loadAgenda(r.start, r.end))
const rows = computed<EventRow[]>(() => source.value?.events ?? [])

/** 日历上的全部东西：日程 + 做过的任务 + 写过的日记 */
const agenda = computed<AgendaItem[]>(() =>
  agendaInRange(source.value, range.value.start, range.value.end)
)

/* ---------- 周视图 ---------- */

const weekDays = computed(() => {
  holidayVersion.value // 联网更新后要重算
  return Array.from({ length: 7 }, (_, i) => {
    const ts = addDays(weekStartOf(cursor.value, weekStart.value), i)
    return {
      ts,
      dow: DOW.value[i],
      day: new Date(ts).getDate(),
      holiday: holidayOf(ts),
      isToday: ts === todayStart,
      selected: ts === selectedDay.value
    }
  })
})

interface WeekLine {
  time: string
  title: string
  kind: AgendaKind
}

interface WeekSection {
  /** 这一格里「刚开始」的条目（跨进来的续不重复列，最多两条） */
  lines: WeekLine[]
}

interface WeekBlock {
  id: string
  /** 整块里有没有日程：全是任务/日记才用灰底（.aux） */
  aux: boolean
  col: number
  /** 起始行（= 第几个两小时 + 2） */
  row: number
  /** 跨几行 */
  span: number
  /** 起始格是第几个两小时（点方块时按手指位置换算） */
  startSlot: number
  /** 每格一段，段数 = span */
  sections: WeekSection[]
}

/** 周表列宽只有 40 出头，日记标题基本放不下：3 个字以上就只写「日记」，配小书本图标 */
function weekLabel(item: { kind: AgendaKind; title: string }): string {
  if (item.kind !== 'diary') return item.title
  return Array.from(item.title).length >= 3 ? '日记' : item.title
}

/**
 * 周表：同一个事件只画一块（2026-11-02 第二轮）。
 *
 * - 先把同一天里「格子相接且互有交集」的条目并成一块（cluster），块跨 row..row+span；
 * - 块内按「两小时一格」切成 span 段，每段只列**在这一格刚开始**的条目（跨进来的续不重复写），
 *   所以 09:00–12:00 + 11:00–12:00 是「一块两段，第二段写 11:00 那条」；
 * - 段与段之间用那条分隔虚线，且只在**两段都有内容**时画（单条事件跨两格就是一整块，不切口子）；
 * - 每段最多两条，多出来的不画（点这一格，下面面板里能看到全部）。
 */
const weekBlocks = computed<WeekBlock[]>(() => {
  const out: WeekBlock[] = []

  weekDays.value.forEach((day, index) => {
    const perSlot = Array.from({ length: SLOT_COUNT }, (_, slot) => slotItemsIn(agenda.value, day.ts, slot))

    // 合并成块：和当前块里任意一条有交集就并进去
    interface Cluster {
      items: AgendaItem[]
      start: number
      end: number
    }
    const clusters: Cluster[] = []
    let current: Cluster | null = null

    perSlot.forEach((list, slot) => {
      if (!list.length) {
        if (current) clusters.push(current)
        current = null
        return
      }
      if (!current) {
        current = { items: [...list], start: slot, end: slot }
        return
      }
      const shares = list.some(item => current!.items.includes(item))
      if (shares) {
        for (const item of list) if (!current.items.includes(item)) current.items.push(item)
        current.end = slot
      } else {
        clusters.push(current)
        current = { items: [...list], start: slot, end: slot }
      }
    })
    if (current) clusters.push(current)

    for (const cluster of clusters) {
      const sections: WeekSection[] = []
      for (let slot = cluster.start; slot <= cluster.end; slot++) {
        // 只列「起始格就是这一格」的：跨进来的续已经在上面那一段写过了
        const starting = cluster.items.filter(item => slotIndexOf(item.at, day.ts) === slot)
        sections.push({
          lines: starting.slice(0, 2).map(item => ({
            time: fmtTime(item.at),
            title: item.title,
            kind: item.kind
          }))
        })
      }

      out.push({
        id: `${day.ts}-${cluster.start}-${cluster.items.map(item => item.id).join('+')}`,
        aux: cluster.items.every(item => item.kind !== 'event'),
        col: index + 2,
        row: cluster.start + 2,
        span: cluster.end - cluster.start + 1,
        startSlot: cluster.start,
        sections
      })
    }
  })

  return out
})

/* ---------- 月视图 ---------- */

const cells = computed(() => {
  holidayVersion.value // 联网更新后要重算
  return monthCells(cursor.value, monthStart.value).map(cell => {
    const holiday = holidayOf(cell.ts)
    const lunar = lunarOf(cell.ts)
    // 节日名优先级：法定节假日 > 自己勾选的节日 > 农历日
    const festival = holiday?.name ? '' : festivalOf(cell.ts, enabledFestivals.value)
    return {
      ts: cell.ts,
      inMonth: cell.inMonth,
      day: new Date(cell.ts).getDate(),
      holiday,
      festival: Boolean(festival),
      term: solarTermOf(cell.ts) ?? '',
      // 优先顺序：法定假日名 > 自选节日 > 节气（代替农历） > 农历
      sub: holiday?.name || festival || solarTermOf(cell.ts) || lunar?.label || '',
      isToday: cell.ts === todayStart,
      selected: cell.ts === selectedDay.value
    }
  })
})

/** 周视图：面板看哪个小时；点日期表头时是「整天」，用 null 表示 */
const panelHour = computed(() => selectedHour.value ?? nowHour)

/**
 * 选中那一格在周表里的坐标（列 = 星期 + 2、行 = 第几个两小时 + 2）。
 * 用来画一个盖在事件块上面的选框 —— 只给格子加底色的话，有事件的格子被块盖住，看不出点在哪。
 */
const pickedCell = computed(() => {
  if (selectedHour.value === null) return null
  const col = weekDays.value.findIndex(day => day.ts === selectedDay.value)
  const row = Math.round((selectedHour.value - HOUR_START) / SLOT_HOURS)
  if (col < 0 || row < 0 || row >= SLOT_COUNT) return null
  return { col: col + 2, row: row + 2 }
})
const panelByDay = computed(() => selectedHour.value === null)

/** 面板看的是第几格（0 = 08:00–10:00） */
const panelSlot = computed(() => Math.max(0, Math.min(SLOT_COUNT - 1, Math.round((panelHour.value - HOUR_START) / SLOT_HOURS))))

/** 选了整点：只看这一天这一格里的（先按天裁，别的日子不会漏进来） */
const slotItems = computed(() => slotItemsIn(agenda.value, selectedDay.value, panelSlot.value))

/** 选了整天：那天所有的东西，顺序按时间 */
const dayItems = computed(() =>
  agenda.value.filter(item => inRange(item, selectedDay.value, addDays(selectedDay.value, 1)))
)

/** 面板要显示哪一批：选了小时就看那个小时，否则看整天 */
const panelItems = computed<AgendaItem[]>(() => (panelByDay.value ? dayItems.value : slotItems.value))

/** 列表左边的图标：日程是日历，任务是勾，日记是书 */
function itemIcon(item: AgendaItem): string {
  if (item.kind === 'task') return 'task'
  if (item.kind === 'diary') return 'book'
  return 'calendar'
}

function itemTime(item: AgendaItem): string {
  if (item.kind !== 'event') return fmtTime(item.at)
  return `${fmtTime(item.at)}–${fmtTime(item.endAt)}`
}

/** 时间后面那一小段说明：重复规则 / 类型 */
function itemMeta(item: AgendaItem): string {
  if (item.kind === 'task') return '任务'
  if (item.kind === 'diary') return '日记'
  const row = rows.value.find(r => r.id === item.rowId)
  return row ? repeatLabel(row) : ''
}

/** 点列表项：日程开编辑，任务/日记跳去各自的页面 */
function openAgendaItem(item: AgendaItem) {
  if (item.kind === 'event') {
    const row = rows.value.find(r => r.id === item.rowId)
    if (row) openEdit(row)
    return
  }
  router.push(item.kind === 'task' ? '/task' : '/vault')
}

/**
 * 周视图点方块 = 选这个时间段，不选事件（2026-11-02）。
 * 块跨了好几格时，按手指落在块里的位置换算成第几格 —— 点下半截就选下半截那个两小时。
 */
function onBlockClick(block: WeekBlock, event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect()
  const ratio = rect && rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0
  const offset = Math.min(block.span - 1, Math.max(0, Math.floor(ratio * block.span)))
  const slot = Math.min(SLOT_COUNT - 1, block.startSlot + offset)
  selectSlot(weekDays.value[block.col - 2].ts, HOUR_START + slot * SLOT_HOURS)
}

const dayMeta = computed(() => {
  const ts = selectedDay.value
  const parts: string[] = []
  const lunar = lunarOf(ts)
  if (lunar) parts.push(`农历${lunar.month}${lunar.isFirstDay ? '初一' : lunar.label}`)
  const festival = festivalOf(ts, enabledFestivals.value)
  if (festival) parts.push(festival)
  const holiday = holidayOf(ts)
  if (holiday?.name) parts.push(holiday.name)
  else if (holiday) parts.push(holiday.kind === 'off' ? '放假' : '调休上班')
  return parts.join(' · ')
})

/** 每天最多三个点，按类型上色：日程绿、任务黄、日记灰 */
const monthDots = computed(() => {
  const map = new Map<number, AgendaKind[]>()
  for (const cell of cells.value) {
    const to = addDays(cell.ts, 1)
    const kinds = agenda.value.filter(item => inRange(item, cell.ts, to)).map(item => item.kind)
    if (kinds.length) map.set(cell.ts, kinds.slice(0, 3))
  }
  return map
})

/* ---------- 导航 ---------- */

/** ISO 周数：取那一周的周四来算，跨年也不会跳 */
function isoWeek(ts: number): number {
  const d = new Date(dayStart(ts))
  const back = (d.getDay() + 6) % 7 // 周一 = 0
  d.setDate(d.getDate() - back + 3) // 那周的周四
  const firstThu = new Date(d.getFullYear(), 0, 4)
  firstThu.setDate(firstThu.getDate() - ((firstThu.getDay() + 6) % 7) + 3)
  return 1 + Math.round((d.getTime() - firstThu.getTime()) / (7 * 86400000))
}

const headTitle = computed(() => {
  if (view.value === 'week') {
    const start = weekStartOf(cursor.value, weekStart.value)
    const end = addDays(start, 6)
    const md = (ts: number) => {
      const d = new Date(ts)
      return `${d.getMonth() + 1}月${d.getDate()}日`
    }
    // 跨年那一周也不写年份（2026-11-02 用户要求）：12月27日 – 1月2日
    return `${md(start)} – ${md(end)} · 第 ${isoWeek(addDays(mondayOf(start), 3))} 周`
  }
  const d = new Date(cursor.value)
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`
})

/** 当前视野的范围（月视图按整月算，不算月历里那些前后月份的格子） */
function visibleRange(): { start: number; end: number } {
  if (view.value === 'week') {
    const start = weekStartOf(cursor.value, weekStart.value)
    return { start, end: addDays(start, 7) }
  }
  const d = new Date(cursor.value)
  const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
  return { start, end }
}

/** 翻页/切换视图后，选中的那天如果跑出视野，就挪到新视野里的合理位置 */
function followSelection() {
  const r = visibleRange()
  if (selectedDay.value >= r.start && selectedDay.value < r.end) return
  if (todayStart >= r.start && todayStart < r.end) selectDay(todayStart)
  else selectDay(r.start)
}

function shift(direction: -1 | 1) {
  cursor.value = view.value === 'week' ? addDays(cursor.value, direction * 7) : addMonths(cursor.value, direction)
  followSelection()
}

function switchView(next: View) {
  view.value = next
  selectedHour.value = next === 'month' ? null : (selectedHour.value ?? nowHour)
  followSelection()
}

function openWeekOf(ts: number) {
  cursor.value = ts
  selectDay(ts)
  view.value = 'week'
}

/* ---------- 编辑 ---------- */

const createSchema: JsonSchema = scheduleCreateEvent.parameters
const editSchema = computed<JsonSchema>(() => {
  const props = { ...scheduleUpdateEvent.parameters.properties }
  delete props.id
  return { type: 'object', properties: props, required: [] }
})

/* 表单分两段：常用的直接露出来，备注和重复规则收进「更多选项」 */
const BASIC_KEYS = ['title', 'startAt', 'endAt', 'location']
const ADVANCED_KEYS = ['note', 'repeatKind', 'repeatEveryN', 'weekParity', 'repeatUntil']

function subsetSchema(schema: JsonSchema, keys: string[]): JsonSchema {
  const properties: JsonSchema['properties'] = {}
  for (const key of keys) {
    const prop = schema.properties[key]
    if (prop) properties[key] = prop
  }
  return {
    type: 'object',
    properties,
    required: (schema.required ?? []).filter(key => keys.includes(key))
  }
}

const createBasic = subsetSchema(createSchema, BASIC_KEYS)
const createAdvanced = subsetSchema(createSchema, ADVANCED_KEYS)
const editBasic = computed(() => subsetSchema(editSchema.value, BASIC_KEYS))
const editAdvanced = computed(() => subsetSchema(editSchema.value, ADVANCED_KEYS))
const showAdvanced = ref(false)

const editorOpen = ref(false)
const editing = ref<EventRow | null>(null)
const formValues = ref<Record<string, unknown>>({})
const saving = ref(false)
const formRef = ref<InstanceType<typeof SchemaForm> | null>(null)

/** 新建时的默认时间：选中那天的选中小时；没选小时就 09:00 */
function defaultStart(): number {
  const hour = view.value === 'week' && selectedHour.value !== null ? panelHour.value : 9
  return selectedDay.value + hour * 3_600_000
}

function openCreate() {
  const start = defaultStart()
  editing.value = null
  formValues.value = {
    title: '',
    startAt: fmtDateTime(start),
    endAt: fmtDateTime(start + 3_600_000),
    repeatKind: 0,
    weekParity: 0,
    // 重复默认只排 3 个月；真要长期重复，把「重复到哪天」往后改
    repeatUntil: fmtDateTime(addMonths(start, 3))
  }
  showAdvanced.value = false
  editorOpen.value = true
}

function openEdit(row: EventRow) {
  editing.value = row
  formValues.value = {
    title: row.title,
    startAt: fmtDateTime(row.startAt),
    endAt: fmtDateTime(row.endAt),
    location: row.location ?? '',
    note: row.note ?? '',
    repeatKind: row.repeatKind,
    weekParity: row.weekParity,
    repeatEveryN: row.repeatEveryN ?? undefined,
    repeatUntil: row.repeatUntil ? fmtDateTime(row.repeatUntil) : ''
  }
  // 带备注或重复规则的，直接把折叠段展开，省得用户找不到
  showAdvanced.value = row.repeatKind !== 0 || Boolean(row.note?.trim())
  editorOpen.value = true
}

async function save() {
  if (!formRef.value?.validate()) return
  saving.value = true
  try {
    const result = editing.value
      ? await scheduleUpdateEvent.execute(
          { ...formValues.value, id: editing.value.id, version: editing.value.version },
          { source: 0 }
        )
      : await scheduleCreateEvent.execute(formValues.value, { source: 0 })
    if (!result.ok) {
      showToast(result.message ?? '保存失败')
      return
    }
    showToast(result.message ?? '已保存')
    editorOpen.value = false
  } catch (error) {
    showToast(error instanceof Error ? error.message : '保存失败')
  } finally {
    saving.value = false
  }
}

async function removeCurrent() {
  if (!editing.value) return
  const result = await scheduleDeleteEvent.execute({ id: editing.value.id }, { source: 0 })
  showToast(result.message ?? '已删除')
  editorOpen.value = false
}
</script>

<template>
  <div class="page schedule-page">
    <AppHeader title="日程" back>
      <template #right>
        <button class="icon-btn" aria-label="导入日程" @click="router.push('/schedule/import')">
          <AppIcon name="image" :size="19" />
        </button>
        <button class="icon-btn" aria-label="新建日程" @click="openCreate">
          <AppIcon name="plus" :size="20" />
        </button>
      </template>
    </AppHeader>

    <div class="page-body" :class="{ 'week-fit': view === 'week' }">
      <div class="view-tabs">
        <button :class="{ on: view === 'week' }" @click="switchView('week')">周</button>
        <button :class="{ on: view === 'month' }" @click="switchView('month')">月</button>
      </div>

      <div class="date-nav">
        <button class="icon-btn" aria-label="上一页" @click="shift(-1)">
          <AppIcon name="back" :size="18" />
        </button>
        <div class="title">{{ headTitle }}</div>
        <button class="icon-btn" aria-label="下一页" style="transform: rotate(180deg)" @click="shift(1)">
          <AppIcon name="back" :size="18" />
        </button>
      </div>

      <!-- 周视图 -->
      <template v-if="view === 'week'">
      <div class="week-scroll">
      <div
        class="week-table"
        :style="{ gridTemplateRows: `46px repeat(${SLOT_COUNT}, minmax(44px, 1fr))` }"
      >
        <div class="wk-corner" style="grid-column: 1; grid-row: 1" />
        <div
          v-for="(day, i) in weekDays"
          :key="day.ts"
          class="wk-head"
          :class="{ today: day.isToday, selected: day.selected }"
          :style="{ gridColumn: i + 2, gridRow: 1 }"
          @click="selectDay(day.ts)"
        >
          <span class="wk-dow">
            {{ day.dow }}
            <span v-if="day.holiday" class="wk-tag" :class="day.holiday.kind">
              {{ day.holiday.kind === 'off' ? '休' : '班' }}
            </span>
          </span>
          <span class="wk-date">{{ day.day }}</span>
        </div>

        <template v-for="(h, hi) in hours" :key="h">
          <div class="cell timecol" :style="{ gridColumn: 1, gridRow: hi + 2 }">{{ hourLabel(h) }}</div>
          <div
            v-for="i in 7"
            :key="`${h}-${i}`"
            class="cell"
            :class="{ 'slot-selected': weekDays[i - 1].ts === selectedDay && selectedHour === h }"
            :style="{ gridColumn: i + 1, gridRow: hi + 2 }"
            @click="selectSlot(weekDays[i - 1].ts, h)"
          />
        </template>

        <!-- 选中框：盖在事件块上面，不然有事件的格子看不出点的是哪 -->
        <div
          v-if="pickedCell"
          class="cell-pick"
          :style="{ gridColumn: pickedCell.col, gridRow: pickedCell.row }"
        />

        <!-- 同一个事件只有一块：块跨几格，内部就切几段 -->
        <div
          v-for="block in weekBlocks"
          :key="block.id"
          class="week-event"
          :class="{ aux: block.aux }"
          :style="{ gridColumn: block.col, gridRow: `${block.row} / span ${block.span}` }"
          @click.stop="onBlockClick(block, $event)"
        >
          <div
            v-for="(sec, si) in block.sections"
            :key="si"
            class="we-sec"
            :class="{ 'we-sec-line': si > 0 && sec.lines.length }"
          >
            <!-- 一格最多两件：每件都是「时间 / 标题」两行 -->
            <span v-for="(line, li) in sec.lines" :key="li" class="we-item">
              <span class="we-time">{{ line.time }}</span>
              <span class="we-title">
                <AppIcon v-if="line.kind === 'diary'" name="book" :size="9" class="we-icon" />
                <i v-else-if="line.kind === 'task'" class="we-mark">✓</i>{{ weekLabel(line) }}
              </span>
            </span>
          </div>
        </div>
      </div>
      </div>

      </template>

      <!-- 月视图 -->
      <template v-else>
        <div class="month-grid">
          <div v-for="d in DOW" :key="d" class="month-head">{{ d }}</div>
          <div
            v-for="cell in cells"
            :key="cell.ts"
            class="month-cell"
            :class="{ out: !cell.inMonth, today: cell.isToday, selected: cell.selected }"
            @click="selectDay(cell.ts)"
          >
            <div class="mc-face">
              <div class="mc-top">
                <!-- 2026-11-01：休/班跟着数字走（数字右上角的小上标），不再绝对定位到格子右上角压住数字 -->
                <span class="mc-day">{{ cell.day }}<i v-if="cell.holiday" class="mc-tag" :class="cell.holiday.kind">{{ cell.holiday.kind === 'off' ? '休' : '班' }}</i></span>
              </div>
              <div class="mc-sub" :class="{ festival: Boolean(cell.festival) }">{{ cell.sub }}</div>
              <div class="mc-dots">
              <span
                v-for="(kind, i) in (monthDots.get(cell.ts) ?? [])"
                :key="i"
                class="mc-dot"
                :class="kind"
              />
              </div>
            </div>
          </div>
        </div>

      </template>

      <!-- 选中那天的安排：周 / 月共用一块，永远在日历下面，不会把表格顶下去 -->
      <div class="day-panel">
        <div class="row-between">
          <div>
            <div class="dp-title">{{ fmtDate(selectedDay) }} {{ weekdayName(selectedDay) }}</div>
            <div class="tiny muted">
              {{ dayMeta }}
              <span v-if="view === 'week' && !panelByDay">
                · {{ hourLabel(panelHour) }}–{{ hourLabel(panelHour + SLOT_HOURS) }}
              </span>
            </div>
          </div>
          <button v-if="view === 'month'" class="btn btn-ghost btn-sm" @click="openWeekOf(selectedDay)">
            看这一周
          </button>
        </div>

        <ul v-if="panelItems.length" class="list">
          <li
            v-for="e in panelItems"
            :key="e.id"
            class="list-item"
            @click="openAgendaItem(e)"
          >
            <span class="avatar" :class="e.kind">
              <AppIcon :name="itemIcon(e)" :size="15" />
            </span>
            <div class="grow">
              <div class="ellipsis">{{ e.title }}</div>
              <div class="tiny muted">
                {{ itemTime(e) }}<span v-if="itemMeta(e)"> · {{ itemMeta(e) }}</span>
              </div>
            </div>
          </li>
        </ul>
        <div v-else class="empty" style="padding: 10px 0">
          {{ panelByDay ? '这天还没有安排' : '这时还没有安排' }}
        </div>
      </div>

    </div>

    <Popup v-model:show="editorOpen" position="bottom" round :style="{ maxHeight: '86%' }">
      <div style="padding: 16px 16px 24px; overflow-y: auto; max-height: 86vh">
        <div class="row-between" style="margin-bottom: 14px">
          <div style="font-size: 16px; font-weight: 600">{{ editing ? '编辑日程' : '新建日程' }}</div>
          <!-- 2026-11-01：删除从底部搬到右上角、保存左边，和保存按钮同一套 btn-sm 尺寸 -->
          <div class="row" style="gap: 8px">
            <button v-if="editing" class="btn btn-danger btn-sm btn-act" @click="removeCurrent">
              <AppIcon name="trash" :size="13" /> 删除
            </button>
            <button class="btn btn-primary btn-sm btn-act" :disabled="saving" @click="save">
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </div>
        </div>

        <SchemaForm ref="formRef" :schema="editing ? editBasic : createBasic" v-model="formValues" />

        <button type="button" class="more-toggle" @click="showAdvanced = !showAdvanced">
          <span>更多选项 <span class="muted">· 备注、重复</span></span>
          <span class="tiny muted">{{ showAdvanced ? '收起' : '展开' }}</span>
        </button>

        <div v-if="showAdvanced" class="more-fields">
          <SchemaForm :schema="editing ? editAdvanced : createAdvanced" v-model="formValues" />
          <div class="tiny muted">单双周只对「每周」重复有效；每 N 天重复会忽略单双周。</div>
        </div>
      </div>
    </Popup>
  </div>
</template>
