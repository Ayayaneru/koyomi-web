<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Capacitor } from '@capacitor/core'
import { showToast } from 'vant'
import AppHeader from '../../ui/AppHeader.vue'
import { getConfig, patchConfig, type LlmConfig, type VlmConfig } from '../../core/db'
import { fetchBalance, listModels, probeProvider } from './client'

const router = useRouter()

const NATIVE = Capacitor.isNativePlatform()
/** 智谱不放行浏览器跨域：网页里走 vite 的本机转发，装机后才用真实地址 */
const ZHIPU_BASE = NATIVE ? 'https://open.bigmodel.cn/api/paas/v4' : '/zhipu/api/paas/v4'

const form = ref<LlmConfig>({
  baseUrl: '',
  model: '',
  apiKey: '',
  temperature: 0.7,
  maxHistoryTurns: 8,
  supportsVision: false
})
const probing = ref(false)
const probeResult = ref<{ ok: boolean; message: string } | null>(null)

/** 图片识别单独一套（2026-10-27 加）：聊天模型看不了图也能识图 */
const vlm = ref<VlmConfig>({ baseUrl: '', model: '', apiKey: '' })
const vlmProbing = ref(false)
const vlmProbe = ref<{ ok: boolean; message: string } | null>(null)

const VLM_PRESETS = [
  { name: '智谱 GLM-4V-Flash', baseUrl: ZHIPU_BASE, model: 'glm-4v-flash' },
  { name: 'OpenAI gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }
]

const PRESETS = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', vision: false },
  { name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', vision: false },
  { name: '通义', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', vision: false },
  { name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-72B-Instruct', vision: false },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', vision: true },
  { name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5', vision: false },
  // 智谱不放行浏览器跨域；glm-4.6 支持 function calling。网址按运行环境给
  { name: '智谱 GLM-4.6', baseUrl: ZHIPU_BASE, model: 'glm-4.6', vision: false },
  // OpenCode 只放行 GET 跨域（/models 能扫），POST 的预检是 404，浏览器里必须走本机转发
  {
    name: 'OpenCode Go（本机代理）',
    baseUrl: '/opencode/zen/go/v1',
    model: 'deepseek-v4.1-flash',
    vision: false
  }
]

const scanning = ref(false)
const modelOptions = ref<string[]>([])
const scanError = ref('')
const balance = ref('')

const isDeepseek = computed(() => form.value.baseUrl.includes('api.deepseek.com'))

/** 填的是智谱官网地址、但我们在浏览器里 —— 直连一定被跨域拦，给个一键换成本机转发 */
const canProxyChat = computed(() => !NATIVE && /open\.bigmodel\.cn/.test(form.value.baseUrl))
const canProxyVlm = computed(() => !NATIVE && /open\.bigmodel\.cn/.test(vlm.value.baseUrl))

/** APK 里没有本机代理：`/zhipu/…` 这种地址发出去就是 no protocol，得当场提醒 */
const relativeChat = computed(() => NATIVE && form.value.baseUrl.trim().startsWith('/'))
const relativeVlm = computed(() => NATIVE && vlm.value.baseUrl.trim().startsWith('/'))
const ZHIPU_REAL = 'https://open.bigmodel.cn/api/paas/v4'

const vlmFilled = computed(() =>
  Boolean(vlm.value.baseUrl.trim() && vlm.value.model.trim() && vlm.value.apiKey.trim())
)

/** 识图当前实际会用谁：单独配的视觉模型优先，没配好就降级用聊天模型 */
const visionStatus = computed<{ tone: 'ok' | 'warn' | 'none'; text: string }>(() => {
  if (vlmFilled.value) return { tone: 'ok', text: `现在识图用：${vlm.value.model}（视觉模型）` }
  const llmReady = Boolean(
    form.value.supportsVision && form.value.baseUrl && form.value.model && form.value.apiKey
  )
  if (llmReady) {
    return { tone: 'warn', text: `视觉模型没填全 → 识图会降级用聊天模型 ${form.value.model}` }
  }
  return { tone: 'none', text: '现在没有能识图的模型：导入日程会置灰' }
})

async function switchChatToProxy() {
  form.value.baseUrl = '/zhipu/api/paas/v4'
  probeResult.value = null
  // 只是改表单，得点保存才落库 —— 不说一句会被漏掉
  showToast('已换成本机转发地址，记得点保存')
  await probe()
}

async function switchVlmToProxy() {
  vlm.value.baseUrl = '/zhipu/api/paas/v4'
  vlmProbe.value = null
  showToast('已换成本机转发地址，记得点保存')
  await probeVlm()
}

async function scanModels() {
  scanning.value = true
  scanError.value = ''
  try {
    modelOptions.value = await listModels(form.value)
    if (!modelOptions.value.includes(form.value.model)) scanError.value = '列表里没有当前填的模型，点下面的挑一个'
  } catch (error) {
    scanError.value = `扫描失败：${error instanceof Error ? error.message : String(error)}`
  } finally {
    scanning.value = false
  }
}

async function queryBalance() {
  try {
    balance.value = await fetchBalance(form.value.apiKey)
  } catch (error) {
    balance.value = `查不到：${error instanceof Error ? error.message : String(error)}`
  }
}

onMounted(async () => {
  const cfg = await getConfig()
  form.value = { ...cfg.llm }
  if (cfg.vlm) vlm.value = { ...cfg.vlm }
})

function applyPreset(preset: (typeof PRESETS)[number]) {
  form.value = { ...form.value, baseUrl: preset.baseUrl, model: preset.model, supportsVision: preset.vision }
  probeResult.value = null
}

async function probe() {
  probing.value = true
  try {
    probeResult.value = await probeProvider(form.value)
  } finally {
    probing.value = false
  }
}

function applyVlmPreset(preset: (typeof VLM_PRESETS)[number]) {
  vlm.value = { ...vlm.value, baseUrl: preset.baseUrl, model: preset.model }
  vlmProbe.value = null
}

async function probeVlm() {
  vlmProbing.value = true
  try {
    vlmProbe.value = await probeProvider(vlm.value)
  } finally {
    vlmProbing.value = false
  }
}

async function save() {
  await patchConfig({ llm: { ...form.value }, vlm: { ...vlm.value } })
  showToast('已保存')
}
</script>

<template>
  <div class="page">
    <AppHeader title="模型设置" back>
      <template #right>
        <button class="btn btn-ghost btn-sm" @click="router.push('/llm/prompt')">助理预设</button>
      </template>
    </AppHeader>

    <div class="page-body">
      <div class="section-title">常用供应商</div>
      <div class="chips">
        <button v-for="preset in PRESETS" :key="preset.name" class="chip" @click="applyPreset(preset)">
          {{ preset.name }}
        </button>
      </div>

      <div class="section-title">连接</div>
      <div class="card">
        <div class="form">
          <div>
            <label class="label">Base URL</label>
            <input v-model="form.baseUrl" class="input" :placeholder="NATIVE ? 'https://open.bigmodel.cn/api/paas/v4' : 'https://api.deepseek.com/v1'" />
            <div class="tiny muted" style="margin-top: 4px">只填到 /v1，不要带 /chat/completions。</div>
            <div v-if="canProxyChat" class="proxy-hint">
              浏览器直连智谱这个地址会被跨域拦住。
              <button class="link-btn" @click="switchChatToProxy">换成本机代理</button>
            </div>
            <div v-if="relativeChat" class="proxy-hint">
              App 里没有本机代理，`/zhipu/…` 这类地址发不出去。
              <button class="link-btn" @click="form.baseUrl = ZHIPU_REAL">换成官网地址</button>
            </div>
          </div>
          <div>
            <label class="label">模型名</label>
            <div class="row" style="gap: 6px">
              <input v-model="form.model" class="input grow" placeholder="deepseek-chat" />
              <button class="btn btn-sm" :disabled="scanning" @click="scanModels">
                {{ scanning ? '扫描中…' : '扫描' }}
              </button>
            </div>
            <div v-if="modelOptions.length" class="chips" style="margin-top: 8px">
              <button
                v-for="id in modelOptions"
                :key="id"
                class="chip"
                :class="{ on: form.model === id }"
                @click="form.model = id"
              >
                {{ id }}
              </button>
            </div>
            <div v-if="scanError" class="tiny" style="color: var(--danger); margin-top: 6px">{{ scanError }}</div>
            <div v-if="isDeepseek" class="row" style="gap: 8px; margin-top: 6px; align-items: center">
              <button class="btn btn-ghost btn-sm" @click="queryBalance">查余额</button>
              <span v-if="balance" class="tiny muted">{{ balance }}</span>
            </div>
          </div>
          <div>
            <label class="label">API Key</label>
            <input v-model="form.apiKey" class="input" type="password" autocomplete="off" placeholder="sk-…" />
            <div class="tiny muted" style="margin-top: 4px">只存在本机 IndexedDB，不会发给除该供应商外的任何地方。</div>
          </div>
        </div>

        <div class="row" style="margin-top: 12px; gap: 8px; flex-wrap: wrap">
          <button class="btn" :disabled="probing" @click="probe">
            {{ probing ? '探测中…' : '测一下能不能连' }}
          </button>
          <span
            v-if="probeResult"
            class="tiny"
            :style="{ color: probeResult.ok ? 'var(--accent)' : 'var(--danger)' }"
          >
            {{ probeResult.message }}
          </span>
          <button
            v-if="probeResult && !probeResult.ok && canProxyChat"
            class="btn btn-sm"
            @click="switchChatToProxy"
          >
            换成本机代理再试
          </button>
        </div>
      </div>

      <div class="section-title">请求参数</div>
      <div class="card">
        <div class="form">
          <div>
            <label class="label">温度（{{ form.temperature }}）</label>
            <input v-model.number="form.temperature" class="input" type="number" min="0" max="2" step="0.1" />
          </div>
          <div>
            <label class="label">发给模型的历史轮数</label>
            <input v-model.number="form.maxHistoryTurns" class="input" type="number" min="1" max="30" />
            <div class="tiny muted" style="margin-top: 4px">只影响发给模型多少轮历史，对话本身不存盘。</div>
          </div>
          <div class="row-between">
            <div>
              <div class="k">这个模型支持图片</div>
              <div class="tiny muted">只在你确实用 GPT-4o / Qwen-VL 这类模型时才打开</div>
              <div v-if="form.supportsVision && !vlmFilled" class="tiny" style="color: var(--warn); margin-top: 4px">
                下面的视觉模型没填全，识图会降级用它
              </div>
            </div>
            <button
              class="switch-dot"
              :class="{ on: form.supportsVision }"
              @click="form.supportsVision = !form.supportsVision"
            >
              ✓
            </button>
          </div>
        </div>
      </div>

      <div class="section-title">视觉模型（识图用）</div>
      <div class="card">
        <div class="small muted" style="margin-bottom: 10px">
          留空就用上面的聊天模型（需要勾「支持图片」）。单独填一套，聊天和识图可以用不同供应商。
        </div>
        <div class="chips" style="margin-bottom: 12px">
          <button v-for="preset in VLM_PRESETS" :key="preset.name" class="chip" @click="applyVlmPreset(preset)">
            {{ preset.name }}
          </button>
        </div>
        <div class="form">
          <div>
            <label class="label">Base URL</label>
            <input
              v-model="vlm.baseUrl"
              class="input"
              :placeholder="NATIVE ? 'https://open.bigmodel.cn/api/paas/v4' : '/zhipu/api/paas/v4'"
            />
            <div v-if="canProxyVlm" class="proxy-hint">
              浏览器直连智谱这个地址会被跨域拦住。
              <button class="link-btn" @click="switchVlmToProxy">换成本机代理</button>
            </div>
            <div v-if="relativeVlm" class="proxy-hint">
              App 里没有本机代理，`/zhipu/…` 这类地址发不出去。
              <button class="link-btn" @click="vlm.baseUrl = ZHIPU_REAL">换成官网地址</button>
            </div>
          </div>
          <div>
            <label class="label">模型名</label>
            <input v-model="vlm.model" class="input" placeholder="glm-4v-flash" />
          </div>
          <div>
            <label class="label">API Key</label>
            <input v-model="vlm.apiKey" class="input" type="password" autocomplete="off" placeholder="留空表示不单独配" />
          </div>
        </div>
        <div class="row" style="margin-top: 12px; gap: 8px; flex-wrap: wrap">
          <button class="btn btn-sm" :disabled="vlmProbing" @click="probeVlm">
            {{ vlmProbing ? '探测中…' : '测一下' }}
          </button>
          <span v-if="vlmProbe" class="tiny" :style="{ color: vlmProbe.ok ? 'var(--accent)' : 'var(--danger)' }">
            {{ vlmProbe.message }}
          </span>
          <button
            v-if="vlmProbe && !vlmProbe.ok && canProxyVlm"
            class="btn btn-sm"
            @click="switchVlmToProxy"
          >
            换成本机代理再试
          </button>
        </div>

        <!-- 识图实际会用谁：降级要明说，不要悄悄换掉 -->
        <div class="vision-status" :class="visionStatus.tone">{{ visionStatus.text }}</div>

        <div class="tiny muted" style="margin-top: 8px">
          {{ NATIVE
            ? '智谱的接口不放行跨域，App 里靠原生请求绕过去，Base URL 直接填 https://open.bigmodel.cn/api/paas/v4（预设已经是这个）。'
            : '智谱的接口不放行浏览器跨域，网页里只能用 /zhipu/…（本机转发，只在 npm run dev 下有效）；装成 App 后会自动换成真实地址。' }}
        </div>
      </div>

      <!-- 一条保存管整页：聊天模型 + 视觉模型一起写进去 -->
      <div class="save-bar">
        <div class="tiny muted save-bar-hint">聊天模型和视觉模型一起保存</div>
        <button class="btn btn-primary btn-block" @click="save">保存设置</button>
      </div>
    </div>
  </div>
</template>
