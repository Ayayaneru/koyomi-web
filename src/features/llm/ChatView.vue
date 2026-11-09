<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Popup, showConfirmDialog, showToast } from 'vant'
import { vAutoAnimate } from '@formkit/auto-animate'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import AppHeader from '../../ui/AppHeader.vue'
import AppIcon from '../../ui/AppIcon.vue'
import { db, getConfig, patchConfig, type ChatSessionRow, type ConfigRow } from '../../core/db'
import { newId } from '../../core/crypto'
import { fmtDateTime } from '../../core/time'
import type { ChatMessage } from './client'
import { runAgent, type ConfirmRequest } from './agent'
import { activePreset, buildPrompt, memoryAwareModules, presetList } from './prompt'
import { toOpenAITools } from './tools'

const router = useRouter()

/** 模型输出必须先过 DOMPurify 再进 v-html，Markdown 解析器也从源头关掉原始 HTML */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
function renderMarkdown(src: string): string {
  return DOMPurify.sanitize(md.render(src), { ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i })
}

type BubbleKind = 'user' | 'assistant' | 'tool' | 'notice' | 'error'
interface Bubble {
  id: string
  kind: BubbleKind
  text: string
  ok?: boolean
  streaming?: boolean
  /** 推理模型（如 GLM-4.6）先吐 reasoning_content，这段期间界面上显示「思考中…」 */
  thinking?: boolean
}

const DRAFT_KEY = 'koyomi.chat.draft'

/* ---------- 历史会话 ---------- */

const sessionId = ref<string | null>(null)
const sessions = ref<ChatSessionRow[]>([])
const historyOpen = ref(false)

/** 历史只列当前预设的；老会话没有 presetId，按「对话」算 */
async function refreshSessions() {
  try {
    const all = await db.chatSessions.orderBy('updatedAt').reverse().limit(80).toArray()
    const id = currentPreset.value?.id ?? 'chat'
    sessions.value = all.filter(row => (row.presetId ?? 'chat') === id).slice(0, 50)
  } catch (error) {
    console.warn('[chat] 读取历史失败', error)
  }
}

function openSession(row: ChatSessionRow) {
  sessionId.value = row.id
  // 工具记录只用来回放界面，不作为对话历史发给模型
  history.value = row.messages
    .filter(m => m.role !== 'tool')
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  bubbles.value = row.messages.map(m =>
    m.role === 'tool'
      ? { id: `b${++seq}`, kind: 'tool' as const, text: m.content, ok: m.ok }
      : { id: `b${++seq}`, kind: m.role, text: m.content }
  )
  historyOpen.value = false
  sessionStorage.removeItem(DRAFT_KEY)
  input.value = ''
}

function newSession() {
  sessionId.value = null
  bubbles.value = []
  history.value = []
  historyOpen.value = false
  sessionStorage.removeItem(DRAFT_KEY)
  input.value = ''
}

type SessionMessage = { role: 'user' | 'assistant' | 'tool'; content: string; ok?: boolean }

async function persistTurn(question: string, answer: string, tools: { content: string; ok?: boolean }[] = []) {
  const now = Date.now()
  const rows: SessionMessage[] = [{ role: 'user', content: question }]
  // 2026-11-02：工具调用也存进去，不然退出对话再回来只剩问答
  for (const tool of tools) rows.push({ role: 'tool', content: tool.content, ok: tool.ok })
  if (answer) rows.push({ role: 'assistant', content: answer })

  try {
    if (!sessionId.value) {
      const id = newId('cs')
      sessionId.value = id
      await db.chatSessions.put({
        id,
        title: question.slice(0, 24),
        presetId: currentPreset.value?.id ?? 'chat',
        messages: rows,
        createdAt: now,
        updatedAt: now
      })
    } else {
      const row = await db.chatSessions.get(sessionId.value)
      if (!row) return
      await db.chatSessions.put({ ...row, messages: [...row.messages, ...rows], updatedAt: now })
    }
    await refreshSessions()
  } catch (error) {
    console.warn('[chat] 保存历史失败', error)
  }
}

async function removeSession(row: ChatSessionRow) {
  try {
    await showConfirmDialog({
      title: '删除这段对话？',
      message: row.title,
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      className: 'is-danger'
    })
  } catch {
    return
  }
  await db.chatSessions.delete(row.id)
  if (sessionId.value === row.id) newSession()
  await refreshSessions()
}

const cfg = ref<ConfigRow | null>(null)
const bubbles = ref<Bubble[]>([])

/* ---------- 历史对话：批量选择 ---------- */

const selectMode = ref(false)
const selectedIds = ref<string[]>([])

const allSelected = computed(
  () => sessions.value.length > 0 && selectedIds.value.length === sessions.value.length
)

function toggleSelectMode() {
  selectMode.value = !selectMode.value
  selectedIds.value = []
}

function toggleSelect(id: string) {
  const at = selectedIds.value.indexOf(id)
  if (at >= 0) selectedIds.value.splice(at, 1)
  else selectedIds.value.push(id)
}

function toggleSelectAll() {
  selectedIds.value = allSelected.value ? [] : sessions.value.map(row => row.id)
}

async function deleteSelected() {
  const count = selectedIds.value.length
  if (!count) return
  try {
    await showConfirmDialog({
      title: `删除 ${count} 个对话？`,
      message: '删掉就找不回来了。',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      className: 'is-danger'
    })
  } catch {
    return
  }
  const ids = [...selectedIds.value]
  await db.chatSessions.bulkDelete(ids)
  // 当前正开着的那条被删了，就回到空白
  if (sessionId.value && ids.includes(sessionId.value)) newSession()
  selectedIds.value = []
  selectMode.value = false
  await refreshSessions()
  showToast(`已删除 ${count} 个对话`)
}

/* ---------- 工具调用折叠 ---------- */

interface ChatRow {
  id: string
  /** tools = 连续几条工具记录合成一组，折叠起来 */
  kind: 'single' | 'tools'
  bubble?: Bubble
  items?: Bubble[]
}

const chatRows = computed<ChatRow[]>(() => {
  const rows: ChatRow[] = []
  for (const bubble of bubbles.value) {
    const last = rows[rows.length - 1]
    if (bubble.kind === 'tool') {
      if (last && last.kind === 'tools') last.items!.push(bubble)
      else rows.push({ id: `g${bubble.id}`, kind: 'tools', items: [bubble] })
    } else {
      rows.push({ id: bubble.id, kind: 'single', bubble })
    }
  }
  return rows
})

/**
 * 本轮正在追加的那一组工具（2026-11-02）。
 * 以前是「最后一条还是『调用 …』就算在跑」，于是每调完一个工具就折叠、下一个又开始，
 * 屏幕上就会闪一下内容、步数跟着跳。现在整轮都算进行中，回答结束才收起来。
 */
const runningGroup = ref('')

function isRunning(row: ChatRow): boolean {
  return Boolean(runningGroup.value) && row.id === runningGroup.value
}

/** 展开工具卡时把它拉进视野：卡在屏幕上方展开后，下半截会掉到屏幕外，看着像「只有前三条」 */
function onSummaryClick(event: MouseEvent) {
  const details = (event.currentTarget as HTMLElement).closest('details')
  if (!details || details.open) return
  requestAnimationFrame(() => details.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
}

function toolsFailed(items: Bubble[]): number {
  return items.filter(item => item.ok === false).length
}

/** 这组调用涉及哪些工具（去重）—— 折叠着也能看见调了什么 */
function toolsCalled(items: Bubble[]): string {
  const names = items
    .map(item => item.text.match(/^(?:调用 )?([a-z_]+)/)?.[1] ?? '')
    .filter(Boolean)
    .filter((name, index, list) => list.indexOf(name) === index)
  if (names.length <= 2) return names.join('、')
  return `${names.slice(0, 2).join('、')} 等 ${names.length} 个`
}
const history = ref<ChatMessage[]>([])
const input = ref(sessionStorage.getItem(DRAFT_KEY) ?? '')
const sending = ref(false)
const bodyRef = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLTextAreaElement | null>(null)
let controller: AbortController | null = null
let seq = 0

/**
 * 输入框最多长到这么高（和 theme.css 里的 max-height 一致），再高就内部滚动。
 * 142 = 5 行 × 24px + 内边距 20 + 边框 2：取行高的整数倍，滚到底时顶上是整行，不会露出半截字。
 */
const INPUT_MAX_HEIGHT = 142

/**
 * 按「显示出来的行数」长高（2026-11-03，参考微信）。
 * 用 scrollHeight 而不是数 \n：一句很长的话会被软换行折成好几行，数换行符数不出来。
 * +2 是上下各 1px 边框（textarea 是 border-box，scrollHeight 不含边框）。
 */
function autoGrow() {
  const el = inputRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight + 2, INPUT_MAX_HEIGHT)}px`
  const full = el.scrollHeight + 2 > INPUT_MAX_HEIGHT
  el.style.overflowY = full ? 'auto' : 'hidden'

  // 长到头以后浏览器会滚到底，顶部会露出半截字。手动把滚动位置对到整行：
  // 行高是 24 的整数倍，最下面一行照样完整（多出来的那点是 padding）。
  if (full) {
    const style = getComputedStyle(el)
    const line = parseFloat(style.lineHeight)
    const padTop = parseFloat(style.paddingTop)
    const max = el.scrollHeight - el.clientHeight
    if (line > 0 && max > 0) {
      el.scrollTop = Math.min(max, padTop + Math.floor((max - padTop) / line) * line)
    }
  }

  // 输入框长高后可视区变矮，原本贴在底部的话跟着再贴一次，别把最后一句顶出去
  const body = bodyRef.value
  if (body && body.scrollHeight - body.scrollTop - body.clientHeight < 80) {
    body.scrollTop = body.scrollHeight
  }
}

const hasKey = computed(() => Boolean(cfg.value?.llm.apiKey && cfg.value?.llm.baseUrl))

/* ---------- 预设切换（换一套助理：人格 / 工具 / 记忆一起换） ---------- */

const presets = computed(() => (cfg.value ? presetList(cfg.value) : []))
const currentPreset = computed(() => (cfg.value ? activePreset(cfg.value) : null))

const presetOpen = ref(false)

function pickPreset(id: string) {
  presetOpen.value = false
  void switchPreset(id)
}

async function switchPreset(id: string) {
  if (!cfg.value || id === currentPreset.value?.id) return
  await patchConfig({ prefs: { activePreset: id } })
  cfg.value = await getConfig()
  // 换人设就开一段新对话：别让「心理」接着上一段「对话」的话头
  newSession()
  // 历史列表跟着换：每个预设只列自己那批
  await refreshSessions()
  showToast(`已切到「${presets.value.find(item => item.id === id)?.name ?? id}」`)
}

/** 空对话时的说明，也按预设换 */
const emptyHint = computed(() => {
  const id = currentPreset.value?.id ?? 'chat'
  if (id === 'write') return '丢一段草稿或一个念头过来。\n要把聊天写成日记时，会先给你看一版。'
  if (id === 'mind') return '想说什么都行。\n这里只有你和我，不评价，也不劝。'
  return '说一句话就能建日程、记任务、写日记。\n数据在本机，改动的工具调用会先问你。'
})

/** 空对话时的示例，按当前预设换一套（写作 / 心理问「明天开会」很奇怪） */
const examples = computed(() => {
  const id = currentPreset.value?.id ?? 'chat'
  if (id === 'write') return ['把这段改通顺些', '写一段关于下雨的', '把刚才聊的记成日记']
  if (id === 'mind') return ['今天有点累', '这两天睡不着', '有件事一直想不通']
  return ['明天下午三点开会', '这个月浇了几次花', '周三那节课改到四点']
})

onMounted(async () => {
  cfg.value = await getConfig()
  await refreshSessions()
  // 有草稿就先不打开历史，免得把没发出去的话冲掉
  if (!input.value.trim() && sessions.value[0]) openSession(sessions.value[0])
  // 草稿可能有几行，先把输入框撑到该有的高度
  await nextTick()
  autoGrow()
  window.addEventListener('resize', autoGrow)
})

watch(input, value => {
  sessionStorage.setItem(DRAFT_KEY, value)
  void nextTick(autoGrow)
})

watch(
  bubbles,
  async () => {
    await nextTick()
    const el = bodyRef.value
    if (el) el.scrollTop = el.scrollHeight
  },
  { deep: true }
)

function push(kind: BubbleKind, text: string, extra: Partial<Bubble> = {}): Bubble {
  const bubble: Bubble = { id: `b${++seq}`, kind, text, ...extra }
  bubbles.value.push(bubble)
  // 返回「数组里那个响应式对象」，不是刚建的原对象：
  // 拿原对象去改 text 不会触发渲染，流式一直停在「思考中…」，直到别的地方 push 才一次性蹦出来。
  return bubbles.value[bubbles.value.length - 1]
}

async function confirmTool(reqs: ConfirmRequest[]): Promise<boolean> {
  const multi = reqs.length > 1
  const body = reqs
    .map((req, index) => {
      const entries = Object.entries(req.args).filter(
        ([, value]) => value !== undefined && value !== null && String(value).trim() !== ''
      )
      // 有 preview 的时候，参数都在下面那段里了，只留一句「为什么改」
      const shown = req.preview ? entries.filter(([key]) => key === 'reason') : entries
      const args = shown
        .map(([key, value]) => `${key}：${String(value).length > 60 ? `${String(value).slice(0, 60)}…` : String(value)}`)
        .join(' · ')
      const head = `${multi ? `${index + 1}. ` : ''}${req.toolName}\n${multi ? '   ' : ''}${args || '（无参数）'}`
      if (!req.preview) return head
      // 工具给的「改前 → 改后」，每行跟着缩进
      const pad = multi ? '   ' : ''
      const detail = req.preview
        .split('\n')
        .map(line => `${pad}${line}`)
        .join('\n')
      return `${head}\n${detail}`
    })
    .join('\n\n')

  try {
    await showConfirmDialog({
      title: multi ? `模型一次要改 ${reqs.length} 处` : '模型要动你的数据',
      message: body,
      messageAlign: 'left',
      confirmButtonText: multi ? `全部执行` : '执行',
      cancelButtonText: multi ? '都取消' : '取消'
    })
    return true
  } catch {
    return false
  }
}

async function send(text?: string) {
  const content = (text ?? input.value).trim()
  if (!content || sending.value) return
  if (!cfg.value) return
  if (!hasKey.value) {
    showToast('先去设置里填 Base URL 和 API Key')
    void router.push('/llm/settings')
    return
  }

  input.value = ''
  sessionStorage.removeItem(DRAFT_KEY)
  push('user', content)
  sending.value = true
  controller = new AbortController()

  try {
    // 当前预设（对话 / 写作 / 心理）：人格、能用哪些工具、记忆都跟着它变
    const preset = activePreset(cfg.value)
    const prompt = await buildPrompt(preset, cfg.value)
    // 先占一个气泡：推理模型要想几秒才吐正文，不给反馈会像卡死了
    let assistant: Bubble | null = push('assistant', '', { streaming: true, thinking: true })
    let assistantText = ''
    /** 本轮的工具记录：跟着这次问答一起落盘 */
    const turnTools: { content: string; ok?: boolean }[] = []
    runningGroup.value = ''

    /** 推一条工具记录，并把「正在进行的那一组」指到它所在的分组 */
    function pushTool(text: string, ok?: boolean) {
      const bubble = push('tool', text, { ok })
      turnTools.push({ content: text, ok })
      const last = chatRows.value[chatRows.value.length - 1]
      if (last && last.kind === 'tools') runningGroup.value = last.id
      return bubble
    }

    /**
     * 收掉「还一个字都没吐」的占位气泡。
     * 参数校验失败、工具不存在的调用**不发 tool-start**，只发 tool-result，
     * 所以两个分支都要先收一次，否则那个「思考中…」会一直挂在工具卡上面。
     */
    function dropPlaceholder() {
      if (assistant && !assistant.text.trim()) {
        const id = assistant.id
        bubbles.value = bubbles.value.filter(b => b.id !== id)
      }
      assistant = null
    }

    for await (const event of runAgent({
      cfg: cfg.value.llm,
      system: prompt.system,
      context: prompt.context,
      history: history.value,
      input: content,
      // 工具范围 = 预设允许的模块；允许自改的预设（写作 / 心理）额外挂上记忆工具
      tools: toOpenAITools(memoryAwareModules(cfg.value, preset)),
      confirm: confirmTool,
      signal: controller.signal,
      // 同一段对话用同一个 id，OpenCode 靠它做路由和缓存；其他厂商不认
      session: sessionId.value ?? undefined
    })) {
      if (event.type === 'delta') {
        if (!assistant) {
          assistant = push('assistant', '', { streaming: true })
        }
        assistant.thinking = false
        assistant.text += event.text
        assistantText += event.text
      } else if (event.type === 'assistant') {
        assistantText = event.text
        if (assistant) {
          assistant.thinking = false
          assistant.text = event.text
          assistant.streaming = false
        } else {
          assistant = push('assistant', event.text)
        }
      } else if (event.type === 'tool-start') {
        // 这一轮只有工具调用、没有正文：把「思考中…」的占位气泡收掉，
        // 否则最后一句回复会接在工具卡片上方，看起来像答非所问
        dropPlaceholder()
        pushTool(`调用 ${event.display}`, undefined)
      } else if (event.type === 'tool-result') {
        dropPlaceholder()
        pushTool(`${event.name}：${event.message || (event.ok ? '完成' : '失败')}`, event.ok)
        // 工具跑完到下一句正文之间，模型还要想几秒。
        // 不补这个占位气泡，屏幕上就只剩一张折起来的工具卡（看着像卡住、只剩一条线）。
        assistant = push('assistant', '', { streaming: true, thinking: true })
      } else if (event.type === 'tool-skip') {
        dropPlaceholder()
        pushTool(`${event.name}：你取消了`, false)
        assistant = push('assistant', '', { streaming: true, thinking: true })
      } else if (event.type === 'notice') {
        push('notice', event.text)
      } else if (event.type === 'error') {
        push('error', event.message)
      }
    }

    if (assistant) {
      assistant.streaming = false
      assistant.thinking = false
      // 只有工具调用、没有正文时，别在界面上留一个空气泡
      if (!assistant.text.trim()) bubbles.value = bubbles.value.filter(b => b.id !== assistant?.id)
    }
    const answer = assistantText.trim()
    const nextHistory: ChatMessage[] = [{ role: 'user', content }]
    if (answer) nextHistory.push({ role: 'assistant', content: answer })
    history.value.push(...nextHistory)
    await persistTurn(content, answer, turnTools)
  } catch (error) {
    push('error', error instanceof Error ? error.message : String(error))
  } finally {
    sending.value = false
    runningGroup.value = ''
    controller = null
  }
}

function stop() {
  controller?.abort()
}

function reset() {
  newSession()
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void send()
  }
}

onUnmounted(() => {
  controller?.abort()
  window.removeEventListener('resize', autoGrow)
})

const canSend = computed(() => input.value.trim().length > 0 && !sending.value)
</script>

<template>
  <div class="page" style="height: 100dvh">
    <AppHeader title="对话" back>
      <template #right>
        <button class="icon-btn" aria-label="历史对话" @click="historyOpen = true; refreshSessions()">
          <AppIcon name="history" :size="19" />
        </button>
        <button class="btn btn-ghost btn-sm" @click="reset">新对话</button>
        <button class="icon-btn" aria-label="模型设置" @click="router.push('/llm/settings')">
          <AppIcon name="settings" :size="19" />
        </button>
      </template>
    </AppHeader>

    <div ref="bodyRef" v-auto-animate="{ duration: 160 }" class="chat-body">
      <div v-if="!bubbles.length" class="empty" style="margin-top: 28px">
        <p style="white-space: pre-line">{{ emptyHint }}</p>
        <div class="chips" style="justify-content: center">
          <button v-for="sample in examples" :key="sample" class="chip" @click="send(sample)">{{ sample }}</button>
        </div>
      </div>

      <template v-for="row in chatRows" :key="row.id">
        <!-- 连续的工具调用折成一块（参考网页版助手的「已调用 N 个工具」）
             2026-11-01：从「一条虚线上写小字」改成真卡片 —— 虚线 + 11px 淡字在手机上看着就是一条虚线 -->
        <details
          v-if="row.kind === 'tools'"
          class="tool-group"
          :class="{ running: isRunning(row) }"
          :open="isRunning(row) || undefined"
        >
          <summary @click="onSummaryClick">
            <span class="tg-label">
              <span class="tg-count">
                工具调用 · {{ Math.ceil((row.items?.length ?? 0) / 2) }} 步
              </span>
              <span v-if="toolsCalled(row.items ?? [])" class="tg-name">
                {{ toolsCalled(row.items ?? []) }}
              </span>
            </span>
            <span v-if="isRunning(row)" class="tg-live">
              <i class="tg-dot" />进行中
            </span>
            <span v-else-if="toolsFailed(row.items ?? [])" class="tg-fail">
              {{ toolsFailed(row.items ?? []) }} 个失败
            </span>
          </summary>
          <div
            v-for="item in row.items"
            :key="item.id"
            class="tool-line"
            :class="{ fail: item.ok === false }"
          >
            {{ item.text }}
          </div>
        </details>

        <template v-else>
          <div v-if="row.bubble?.kind === 'user'" class="msg user">{{ row.bubble?.text }}</div>
          <div v-else-if="row.bubble?.kind === 'assistant'" class="msg assistant">
            <span v-if="row.bubble.thinking && !row.bubble.text" class="muted small">思考中…</span>
            <span
              v-else
              v-html="renderMarkdown((row.bubble.text ?? '') + (row.bubble.streaming ? ' ▍' : ''))"
            />
          </div>
          <div v-else-if="row.bubble?.kind === 'error'" class="tool-card fail">
            {{ row.bubble.text }}
          </div>
          <div v-else class="tiny muted" style="text-align: center">{{ row.bubble?.text }}</div>
        </template>
      </template>
    </div>

    <div v-if="!hasKey" class="banner" style="margin: 0 12px 8px">
      <div class="grow small">还没填 Base URL 或 API Key，填好才能聊。</div>
      <button class="btn btn-sm" @click="router.push('/llm/settings')">去设置</button>
    </div>

    <div class="chat-input">
      <!-- 当前助理：名字 + 下拉箭头的胶囊，点开换（管理在设置里） -->
      <button class="preset-btn" :aria-label="`当前助理：${currentPreset?.name ?? '对话'}`" @click="presetOpen = true">
        {{ currentPreset?.name ?? '对话' }}
        <span class="preset-chev"><AppIcon name="chevron" :size="12" /></span>
      </button>
      <textarea
        ref="inputRef"
        v-model="input"
        rows="1"
        placeholder="说点什么…"
        @keydown="onKeydown"
      />
      <button v-if="sending" class="btn btn-danger" @click="stop">
        <AppIcon name="stop" :size="15" />
      </button>
      <button v-else class="btn btn-primary" :disabled="!canSend" @click="send()">
        <AppIcon name="send" :size="16" />
      </button>
    </div>

    <!-- 换助理 -->
    <Popup v-model:show="presetOpen" position="bottom" round>
      <div class="preset-sheet">
        <div class="preset-sheet-head">换助理</div>
        <button
          v-for="preset in presets"
          :key="preset.id"
          class="preset-option"
          :class="{ on: preset.id === currentPreset?.id }"
          @click="pickPreset(preset.id)"
        >
          <span class="grow">{{ preset.name }}</span>
          <AppIcon v-if="preset.id === currentPreset?.id" name="check" :size="16" />
        </button>
        <div class="tiny muted" style="margin-top: 10px">
          想改人格、记忆或权限，去 设置 → 助理预设。
        </div>
      </div>
    </Popup>

    <!-- 历史会话（左边抽屉，参考网页版助手的做法） -->
    <Popup v-model:show="historyOpen" position="left" :style="{ width: '80%', height: '100%' }">
      <div class="history-panel">
        <div class="row-between" style="padding: 14px 14px 10px">
          <div style="font-weight: 600">历史对话</div>
          <div class="row" style="gap: 6px">
            <button v-if="sessions.length" class="btn btn-sm" @click="toggleSelectMode">
              {{ selectMode ? '取消' : '选择' }}
            </button>
            <button class="btn btn-sm" @click="newSession">新对话</button>
          </div>
        </div>

        <!-- 多选工具条 -->
        <div v-if="selectMode" class="history-select">
          <button class="link-btn" @click="toggleSelectAll">
            {{ allSelected ? '取消全选' : '全选' }}
          </button>
          <span class="tiny muted grow">已选 {{ selectedIds.length }} 个</span>
          <button class="btn btn-danger btn-sm" :disabled="!selectedIds.length" @click="deleteSelected">
            删除
          </button>
        </div>

        <div class="history-list">
          <div
            v-for="row in sessions"
            :key="row.id"
            class="history-item"
            :class="{ on: row.id === sessionId, picking: selectMode }"
            @click="selectMode ? toggleSelect(row.id) : openSession(row)"
          >
            <span v-if="selectMode" class="pick-box" :class="{ on: selectedIds.includes(row.id) }">
              <AppIcon v-if="selectedIds.includes(row.id)" name="check" :size="12" />
            </span>
            <div class="grow">
              <div class="ellipsis">{{ row.title || '未命名对话' }}</div>
              <div class="tiny muted">
                {{ row.messages.filter(m => m.role !== 'tool').length }} 条 · {{ fmtDateTime(row.updatedAt) }}
              </div>
            </div>
            <button
              v-if="!selectMode"
              class="icon-btn"
              aria-label="删除会话"
              @click.stop="removeSession(row)"
            >
              <AppIcon name="trash" :size="15" />
            </button>
          </div>
          <div v-if="!sessions.length" class="empty" style="padding: 24px 0">还没有历史对话</div>
        </div>
      </div>
    </Popup>
  </div>
</template>
