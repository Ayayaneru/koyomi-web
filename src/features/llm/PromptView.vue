<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { showConfirmDialog, showToast } from 'vant'
import AppHeader from '../../ui/AppHeader.vue'
import { DEFAULT_PRESETS, getConfig, patchConfig, type Preset } from '../../core/db'
import { buildPrompt, presetList, type BuiltPrompt } from './prompt'

/**
 * 预设（Preset）：一套「人格 + 能用的模块 + 记忆」。
 * 2026-11-01 之前这一页是「给哪个模块写规则」，对话其实只用了 llm 那一段；
 * 现在改成按预设编辑，切预设就是换一套助理。
 */

const BUILTIN = ['chat', 'write', 'mind']
/** 模块 chips 只列日程和任务：日记单独用开关管（它是一整块权限，不是「能力」之一） */
const BUSINESS_MODULES: Record<string, string> = { schedule: '日程', task: '任务' }

const loaded = ref(false)
const presets = ref<Preset[]>([])
const activeId = ref('chat')
const preview = ref<BuiltPrompt | null>(null)

const name = ref('')
const persona = ref('')
const context = ref('')
const moduleIds = ref<string[]>([])
const allowDiary = ref(false)
const allowEditPersona = ref(false)
const allowEditModules = ref(false)
const allowEditMemory = ref(false)

const varHint =
  '{{today}} {{now}} {{weekday}} {{upcoming_events}} {{tasks_due}} {{diary_titles}} {{user_name}}'

const isBuiltin = computed(() => BUILTIN.includes(activeId.value))

async function load() {
  const cfg = await getConfig()
  presets.value = JSON.parse(JSON.stringify(presetList(cfg))) as Preset[]
  activeId.value = cfg.prefs.activePreset ?? presets.value[0].id
  syncForm()
  loaded.value = true
  await refresh()
}

/** 把当前预设的字段拷进输入框 */
function syncForm() {
  const preset = presets.value.find(p => p.id === activeId.value)
  name.value = preset?.name ?? ''
  persona.value = preset?.persona ?? ''
  context.value = preset?.context ?? ''
  moduleIds.value = [...(preset?.modules ?? [])]
  allowDiary.value = Boolean(preset?.allowDiary)
  allowEditPersona.value = Boolean(preset?.allowEditPersona)
  allowEditModules.value = Boolean(preset?.allowEditModules)
  allowEditMemory.value = Boolean(preset?.allowEditMemory)
}

/** 编辑中的值合并回预设列表（预览和保存都用它） */
function draftPresets(): Preset[] {
  return presets.value.map(preset =>
    preset.id === activeId.value
      ? {
          ...preset,
          name: name.value,
          persona: persona.value,
          context: context.value,
          modules: [...moduleIds.value],
          allowDiary: allowDiary.value,
          allowEditPersona: allowEditPersona.value,
          allowEditModules: allowEditModules.value,
          allowEditMemory: allowEditMemory.value
        }
      : preset
  )
}

async function refresh() {
  if (!loaded.value) return
  const cfg = await getConfig()
  const list = draftPresets()
  const draft = { ...cfg, prefs: { ...cfg.prefs, presets: list, activePreset: activeId.value } }
  const current = list.find(p => p.id === activeId.value) ?? list[0]
  preview.value = await buildPrompt(current, draft)
}

let timer: ReturnType<typeof setTimeout> | undefined
function scheduleRefresh() {
  if (!loaded.value) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void refresh(), 300)
}

watch(
  [name, persona, context, moduleIds, allowDiary, allowEditPersona, allowEditModules, allowEditMemory],
  scheduleRefresh,
  { deep: true }
)

watch(activeId, () => {
  syncForm()
  void refresh()
})

function toggleModule(id: string) {
  moduleIds.value = moduleIds.value.includes(id)
    ? moduleIds.value.filter(item => item !== id)
    : [...moduleIds.value, id]
}

function addPreset() {
  const id = `p${Date.now().toString(36)}`
  presets.value = [
    ...presets.value,
    {
      id,
      name: '新助理',
      persona: '',
      modules: [],
      context: '',
      allowDiary: false,
      allowEditPersona: false,
      allowEditModules: false,
      allowEditMemory: false
    }
  ]
  activeId.value = id
  showToast('建好了，记得保存')
}

async function removePreset() {
  if (isBuiltin.value) return
  try {
    await showConfirmDialog({
      title: `删除「${name.value}」？`,
      message: '它的人格和记忆会一起删掉，删了就找不回来了。',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      className: 'is-danger'
    })
  } catch {
    return
  }
  const rest = presets.value.filter(item => item.id !== activeId.value)
  presets.value = rest.length ? rest : (JSON.parse(JSON.stringify(DEFAULT_PRESETS)) as Preset[])
  activeId.value = presets.value[0].id
  // 关键：先把表单切到新的那一条再存。否则 draftPresets() 会拿「被删掉那个」的名字/人格
  // 去覆盖新选中的预设（2026-11-02 修：删完「新助理」，对话就被改名成「新助理」）
  syncForm()
  await save(presets.value)
}

/** list 明确传进来时就不再从表单取值：切预设的瞬间表单还是上一条的内容 */
async function save(list?: Preset[]) {
  const next = list ?? draftPresets()
  await patchConfig({ prefs: { presets: next, activePreset: activeId.value } })
  presets.value = next
  showToast('已保存')
}

/** 把人格/记忆恢复成出厂那段（只动输入框，点保存才生效） */
function resetPreset() {
  const preset = presets.value.find(p => p.id === activeId.value)
  if (!preset) return
  const fresh = DEFAULT_PRESETS.find(item => item.id === preset.id)
  if (fresh) {
    name.value = fresh.name
    persona.value = fresh.persona
    context.value = fresh.context
    moduleIds.value = [...fresh.modules]
    allowDiary.value = Boolean(fresh.allowDiary)
    allowEditPersona.value = Boolean(fresh.allowEditPersona)
    allowEditModules.value = Boolean(fresh.allowEditModules)
    allowEditMemory.value = Boolean(fresh.allowEditMemory)
    showToast('已恢复默认，点保存才生效')
    return
  }
  persona.value = ''
  context.value = ''
  showToast('清空了人格和记忆，点保存才生效')
}

onMounted(load)
onUnmounted(() => {
  if (timer) clearTimeout(timer)
})

interface Segment {
  text: string
  bad: boolean
}

const segments = computed<Segment[]>(() => {
  if (!preview.value) return []
  const full = `【system】\n${preview.value.system}\n\n【context（作为 user 消息）】\n${preview.value.context}`
  const unknown = new Set(preview.value.unknown)
  const out: Segment[] = []
  const re = /\{\{(\w+)\}\}/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(full))) {
    if (match.index > last) out.push({ text: full.slice(last, match.index), bad: false })
    out.push({ text: match[0], bad: unknown.has(match[1]) })
    last = match.index + match[0].length
  }
  if (last < full.length) out.push({ text: full.slice(last), bad: false })
  return out
})

const budget = computed(() => {
  const tokens = preview.value?.tokens ?? { persona: 0, module: 0, context: 0 }
  return [
    { label: '人格', value: tokens.persona, limit: 400 },
    { label: '模块规则', value: tokens.module, limit: 200 },
    { label: '上下文 / 记忆', value: tokens.context, limit: 900 }
  ]
})
</script>

<template>
  <div class="page">
    <AppHeader title="助理预设" back>
      <template #right>
        <button class="btn btn-primary btn-sm btn-act" @click="save()">保存</button>
      </template>
    </AppHeader>

    <div class="page-body">
      <div class="chips" style="margin-bottom: 6px">
        <button
          v-for="preset in presets"
          :key="preset.id"
          class="chip"
          :class="{ on: activeId === preset.id }"
          @click="activeId = preset.id"
        >
          {{ preset.name }}
        </button>
        <button class="chip" @click="addPreset">＋ 新建</button>
      </div>
      <div class="tiny muted" style="margin: 0 2px 8px">
        切换预设 = 换一套助理：人格、能用的模块、记忆三样一起变。聊天页顶部也能切。
      </div>

      <div class="section-title">名字</div>
      <div class="card">
        <input v-model="name" class="input" placeholder="例：写作、心理、学习" />
      </div>

      <div class="section-title">人格</div>
      <div class="card">
        <textarea
          v-model="persona"
          class="textarea"
          style="min-height: 168px"
          placeholder="说话风格、称呼、性格"
        />
        <div class="tiny muted" style="margin-top: 6px">
          {{ persona.trim() ? '发给模型的 system 第一段，可以直接改' : '留空 = 用内置的 Koyomi 人格' }}
        </div>
      </div>

      <div class="section-title">能用哪些</div>
      <div class="card">
        <div class="chips">
          <button
            v-for="(label, id) in BUSINESS_MODULES"
            :key="id"
            class="chip"
            :class="{ on: moduleIds.includes(id) }"
            @click="toggleModule(id)"
          >
            {{ label }}
          </button>
        </div>
        <div class="tiny muted" style="margin-top: 8px">
          勾上哪个模块，它的工具就给它用，模块自带的行为规则也会一起拼进去。<br />
          没勾的模块（以及下面关着的日记），这个助理既看不到也改不了。
        </div>
      </div>

      <div class="section-title">模型能动哪些</div>
      <div class="card">
        <div class="switch-row">
          <div class="grow">
            <div>用日记</div>
            <div class="tiny muted">关着就看不到、也写不了日记</div>
          </div>
          <button class="switch-dot" :class="{ on: allowDiary }" @click="allowDiary = !allowDiary">
            ✓
          </button>
        </div>
        <div class="switch-row">
          <div class="grow">
            <div>改人格</div>
            <div class="tiny muted">让它能调自己的说话方式</div>
          </div>
          <button
            class="switch-dot"
            :class="{ on: allowEditPersona }"
            @click="allowEditPersona = !allowEditPersona"
          >
            ✓
          </button>
        </div>
        <div class="switch-row">
          <div class="grow">
            <div>改工具范围</div>
            <div class="tiny muted">让它能给自己加 / 减模块（只能从你开着的模块里挑）</div>
          </div>
          <button
            class="switch-dot"
            :class="{ on: allowEditModules }"
            @click="allowEditModules = !allowEditModules"
          >
            ✓
          </button>
        </div>
        <div class="switch-row">
          <div class="grow">
            <div>改记忆</div>
            <div class="tiny muted">让它能往长期记忆里记东西</div>
          </div>
          <button
            class="switch-dot"
            :class="{ on: allowEditMemory }"
            @click="allowEditMemory = !allowEditMemory"
          >
            ✓
          </button>
        </div>
        <div class="tiny muted" style="margin-top: 8px">
          开了之后它才有对应的工具，每次改动都会弹确认框，框里显示「改前 / 改后」。
        </div>
      </div>

      <div class="section-title">上下文模板（记忆）</div>
      <div class="card">
        <textarea
          v-model="context"
          class="textarea"
          style="min-height: 196px"
          placeholder="留空 = 用内置的默认上下文模板"
        />
        <div class="tiny muted" style="margin-top: 6px">
          可用变量：{{ varHint }}。写错会原样保留并标红。
        </div>
        <div v-if="allowEditMemory" class="tiny muted" style="margin-top: 6px">
          这个预设允许模型自己维护记忆，改之前会弹确认框。
        </div>
      </div>

      <div class="row" style="margin-top: 10px">
        <button class="btn grow" @click="resetPreset">恢复默认</button>
        <button v-if="!isBuiltin" class="btn btn-danger" @click="removePreset">删除这个预设</button>
      </div>

      <div class="section-title">预算</div>
      <div class="card">
        <div v-for="row in budget" :key="row.label" class="row-between" style="padding: 3px 0">
          <span class="small">{{ row.label }}</span>
          <span class="small" :class="{ 'budget-warn': row.value > row.limit }">
            ≈ {{ row.value }} / {{ row.limit }} token
          </span>
        </div>
      </div>

      <div class="section-title">渲染结果</div>
      <div class="card">
        <div class="prompt-preview">
          <span v-for="(seg, i) in segments" :key="i" :class="{ 'var-unknown': seg.bad }">{{
            seg.text
          }}</span>
        </div>
        <div class="row-between" style="margin-top: 8px">
          <span class="tiny muted">未知变量会原样保留并标红，不会被替换成空。</span>
          <button class="btn btn-ghost btn-sm" @click="refresh">刷新</button>
        </div>
      </div>
    </div>
  </div>
</template>
