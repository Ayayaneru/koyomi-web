<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Popup, showConfirmDialog, showToast } from 'vant'
import { vAutoAnimate } from '@formkit/auto-animate'
import AppHeader from '../../ui/AppHeader.vue'
import AppIcon from '../../ui/AppIcon.vue'
import { useLive } from '../../ui/useLive'
import { copyText } from '../../core/clipboard'
import { db, type VaultEntry } from '../../core/db'
import {
  buildVaultFile,
  deleteEntry,
  downloadVault,
  hasMasterPassword,
  importVaultFile,
  lockVault,
  migrateSiteNames,
  readEntry,
  saveEntry,
  setupMasterPassword,
  unlockVault,
  vaultKey,
  type EntryInput,
  type EntryRead
} from './vaultFile'
import { parseVaultText } from './vaultImport'

const hasMaster = ref<boolean | null>(null)
const unlocked = computed(() => vaultKey.value !== null)
const busy = ref(false)

// vaultEntries 只有主键索引，排序在内存里做
const entries = useLive(() => db.vaultEntries.toArray())

/* 2026-11-02：不再「点显示才解密」，解锁后直接把所有条目解开——列表默认就显示账号和密码。
   解密用的是内存里的密钥，一条四次 AES-GCM，几十条也就几毫秒。 */
const details = ref<Record<string, EntryRead>>({})
/** 第一轮解密跑完了没有：跑完之前不显示「解不开」的提示，免得闪一下 */
const loaded = ref(false)

/** 解密后的名称（名称也加密了，排序 / 去重都用这个） */
function siteOf(row: VaultEntry): string {
  return details.value[row.id]?.site ?? row.site
}

const sortedEntries = computed(() =>
  [...(entries.value ?? [])].sort((a, b) => siteOf(a).localeCompare(siteOf(b), 'zh'))
)

/** 账号/密码解不开的条数：正常是 0，密钥换过才会一堆 */
const brokenCount = computed(
  () => (entries.value ?? []).filter(row => details.value[row.id]?.broken).length
)

async function loadDetails() {
  if (!vaultKey.value) {
    details.value = {}
    return
  }
  // 老条目的名称还是明文：解锁后先搬进密文字段（搬完 entries 会再触发一次这里）。
  // 迁移失败不该连累读取，所以单独兜一层
  try {
    await migrateSiteNames()
  } catch {
    /* 名字还是明文，读取照常 */
  }
  const next: Record<string, EntryRead> = {}
  await Promise.all(
    (entries.value ?? []).map(async row => {
      try {
        next[row.id] = await readEntry(row)
      } catch {
        // 单条坏了不影响别的
      }
    })
  )
  details.value = next
  loaded.value = true
}

watch([entries, unlocked], () => void loadDetails(), { immediate: true })

const pwd1 = ref('')
const pwd2 = ref('')
const pwd = ref('')

onMounted(async () => {
  hasMaster.value = await hasMasterPassword()
})

async function setup() {
  if (pwd1.value.length < 6) return showToast('主密码至少 6 位')
  if (pwd1.value !== pwd2.value) return showToast('两次输入不一致')
  busy.value = true
  try {
    await setupMasterPassword(pwd1.value)
    hasMaster.value = true
    pwd1.value = ''
    pwd2.value = ''
    showToast('已设置主密码，建议立刻导出一份加密库')
  } finally {
    busy.value = false
  }
}

async function unlock() {
  if (!pwd.value) return
  busy.value = true
  try {
    const ok = await unlockVault(pwd.value)
    if (!ok) {
      showToast('主密码不对')
      return
    }
    pwd.value = ''
    showToast('已解锁')
  } finally {
    busy.value = false
  }
}

function lock() {
  lockVault()
  details.value = {}
  showToast('已锁定，密钥已从内存清掉')
}

function detailOf(id: string): EntryRead | undefined {
  return details.value[id]
}

/** 账号 / 密码点一下直接复制（按钮已经去掉） */
async function copyField(row: VaultEntry, text: string | undefined, label: string) {
  if (details.value[row.id]?.broken) return showToast('这条解不开，复制不了')
  if (!text) return showToast(`这条没填${label}`)
  const ok = await copyText(text)
  showToast(ok ? `${label}已复制` : '复制失败，长按手动选吧')
}

/* ---------- 新增 / 编辑 ---------- */

const editorOpen = ref(false)
const editingId = ref<string | null>(null)
const form = ref<EntryInput>({ site: '', account: '', secret: '', note: '' })

function openCreate() {
  editingId.value = null
  form.value = { site: '', account: '', secret: '', note: '' }
  editorOpen.value = true
}

function openEdit(row: VaultEntry) {
  const detail = details.value[row.id]
  if (!detail || detail.broken) {
    showToast('这条解不开，改不了')
    return
  }
  editingId.value = row.id
  form.value = { ...detail }
  editorOpen.value = true
}

const saving = ref(false)

async function save() {
  if (saving.value) return
  saving.value = true
  try {
    await saveEntry(form.value, editingId.value ?? undefined)
    editorOpen.value = false
    showToast('已保存')
    await loadDetails()
  } catch (error) {
    showToast(error instanceof Error ? error.message : '保存失败')
  } finally {
    saving.value = false
  }
}

/** 删除只在编辑弹窗里给，且一定先问一遍 —— 列表上没有删除按钮 */
async function removeCurrent() {
  const id = editingId.value
  if (!id) return
  try {
    await showConfirmDialog({
      title: '删除这条？',
      message: `${form.value.site || '未命名'} —— 删掉就找不回来了`,
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      className: 'is-danger'
    })
  } catch {
    return
  }
  await deleteEntry(id)
  editorOpen.value = false
  editingId.value = null
  await loadDetails()
  showToast('已删除')
}

/* ---------- 批量添加 ---------- */

const batchOpen = ref(false)
const batchText = ref('')
const batchPreview = computed(() => parseVaultText(batchText.value))

function openBatch() {
  batchText.value = ''
  batchOpen.value = true
}

async function doBatchImport() {
  const rows = batchPreview.value.entries
  if (!rows.length) return showToast('没解析出条目，看看下面的格式说明')

  // 同名的跳过：重复粘同一份不会变成一堆重复条目
  const existing = new Set((entries.value ?? []).map(row => siteOf(row).trim().toLowerCase()))
  let added = 0
  let skipped = 0
  busy.value = true
  try {
    for (const row of rows) {
      const key = row.site.trim().toLowerCase()
      if (existing.has(key)) {
        skipped++
        continue
      }
      await saveEntry(row)
      existing.add(key)
      added++
    }
    await loadDetails()
    batchOpen.value = false
    showToast(`已导入 ${added} 条${skipped ? `，跳过 ${skipped} 条同名` : ''}`)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '导入失败')
  } finally {
    busy.value = false
  }
}

/* ---------- 导出 / 导入 ---------- */

async function exportVault() {
  try {
    await downloadVault(await buildVaultFile())
    showToast('已导出加密库')
  } catch (error) {
    const message = error instanceof Error ? error.message : '导出失败'
    if (!message.includes('取消')) showToast(message)
  }
}

const importOpen = ref(false)
const importPwd = ref('')
const importFile = ref<File | null>(null)

function pickImport() {
  importOpen.value = true
  importPwd.value = ''
  importFile.value = null
}

async function doImport() {
  if (!importFile.value || !importPwd.value) return showToast('选文件并输入主密码')
  busy.value = true
  try {
    const payload = JSON.parse(await importFile.value.text())
    const result = await importVaultFile(payload, importPwd.value)
    hasMaster.value = true
    importOpen.value = false
    showToast(`已导入 ${result.count} 条`)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '导入失败')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page">
    <AppHeader title="密码库" back>
      <template #right>
        <button v-if="unlocked" class="btn btn-ghost btn-sm" @click="lock">锁定</button>
      </template>
    </AppHeader>

    <div class="page-body">
      <div v-if="hasMaster === null" class="empty">读取中…</div>

      <!-- 未设置主密码 -->
      <template v-else-if="!hasMaster">
        <div class="banner danger">
          <div class="grow small">
            主密码忘了就打不开了。没有找回途径，也没有客服。建议设好之后立刻导出一份加密库。
          </div>
        </div>
        <div class="vault-gate">
          <div>
            <label class="label">设置主密码（至少 6 位）</label>
            <input v-model="pwd1" class="input" type="password" autocomplete="new-password" />
          </div>
          <div>
            <label class="label">再输一遍</label>
            <input v-model="pwd2" class="input" type="password" autocomplete="new-password" />
          </div>
          <button class="btn btn-primary btn-block" :disabled="busy" @click="setup">
            {{ busy ? '派生密钥中…' : '设置并解锁' }}
          </button>
          <button class="btn btn-block" @click="pickImport">导入已有加密库</button>
        </div>
      </template>

      <!-- 未解锁 -->
      <template v-else-if="!unlocked">
        <div class="vault-gate">
          <div>
            <label class="label">主密码</label>
            <input v-model="pwd" class="input" type="password" autocomplete="current-password" @keyup.enter="unlock" />
          </div>
          <button class="btn btn-primary btn-block" :disabled="busy" @click="unlock">
            {{ busy ? '解锁中…' : '解锁' }}
          </button>
          <div class="tiny muted">密钥只在内存里，刷新或锁定就没了。</div>
          <button class="btn btn-block" @click="pickImport">从文件导入加密库</button>
        </div>
      </template>

      <!-- 已解锁 -->
      <template v-else>
        <div class="row" style="gap: 8px">
          <button class="btn btn-primary grow" @click="openCreate">
            <AppIcon name="plus" :size="16" /> 新增
          </button>
          <button class="btn" @click="openBatch">批量</button>
          <button class="btn" @click="exportVault">
            <AppIcon name="download" :size="16" /> 导出
          </button>
        </div>

        <!-- 解不开的时候说清楚原因，别让每条都只写「解密失败」 -->
        <div v-if="loaded && brokenCount" class="banner danger" style="margin-top: 12px">
          <div class="grow small">
            <template v-if="brokenCount === sortedEntries.length">
              这 {{ brokenCount }} 条都解不开：它们不是用现在这个主密码加密的（中途重设过主密码就会这样）。
              旧密钥找不回来，只能删掉重建；如果之前导出过加密库文件，用那个文件 + 当时的主密码导入能救回来。
            </template>
            <template v-else>
              有 {{ brokenCount }} 条解不开（不是当前主密码加密的），其余正常。
            </template>
          </div>
        </div>

        <ul v-auto-animate="{ duration: 180 }" class="list card" style="margin-top: 12px">
          <li v-if="!sortedEntries.length" class="empty" style="padding: 18px 0">还没有条目</li>
          <!-- 2026-11-02：去掉钥匙图标和右边三颗按钮；名称 + 账号 + 密码三行，
               账号/密码点一下复制，点别处进编辑；有备注的在名称后面挂一个小图标。 -->
          <li
            v-for="row in sortedEntries"
            :key="row.id"
            class="list-item tap vault-row"
            @click="openEdit(row)"
          >
            <div class="grow vault-main">
              <div class="vault-site">
                <span class="ellipsis" :class="{ 'vault-broken': detailOf(row.id)?.broken }">
                  {{ siteOf(row) || '（解不开）' }}
                </span>
                <span v-if="detailOf(row.id)?.note" class="vault-note" title="有备注" aria-label="有备注">
                  <AppIcon name="note" :size="12" />
                </span>
              </div>
              <button type="button" class="vault-field" @click.stop="copyField(row, detailOf(row.id)?.account, '账号')">
                <span class="vault-k">账号</span>
                <span class="vault-v">{{ detailOf(row.id)?.account || '—' }}</span>
              </button>
              <button type="button" class="vault-field" @click.stop="copyField(row, detailOf(row.id)?.secret, '密码')">
                <span class="vault-k">密码</span>
                <span class="vault-v">{{ detailOf(row.id)?.secret || '—' }}</span>
              </button>
            </div>
            <!-- 右下角的箭头单独做成按钮：44px 的触摸区，不用瞄准那个小图标 -->
            <button type="button" class="vault-arrow" aria-label="编辑这一条" @click.stop="openEdit(row)">
              <AppIcon name="chevron" :size="15" />
            </button>
          </li>
        </ul>
        <div class="tiny muted" style="margin-top: 10px">
          名称、账号、密码、备注都是加密的；锁屏或刷新后密钥就从内存里清掉，要重新输主密码。
        </div>
      </template>
    </div>

    <Popup v-model:show="editorOpen" position="bottom" round :style="{ maxHeight: '86%' }">
      <div style="padding: 16px; padding-bottom: calc(20px + env(safe-area-inset-bottom)); overflow-y: auto; max-height: 86vh">
        <!-- 顶栏和日程编辑一致：标题 + 右边「删除 / 保存」，没有关闭按钮 -->
        <div class="row-between" style="margin-bottom: 14px">
          <div style="font-size: 16px; font-weight: 600">{{ editingId ? '编辑条目' : '新增条目' }}</div>
          <div class="row" style="gap: 8px">
            <button v-if="editingId" class="btn btn-danger btn-sm btn-act" @click="removeCurrent">
              <AppIcon name="trash" :size="13" /> 删除
            </button>
            <button class="btn btn-primary btn-sm btn-act" :disabled="saving" @click="save">
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </div>
        </div>
        <div class="form">
          <div>
            <label class="label">名称</label>
            <input v-model="form.site" class="input" placeholder="银行 / 网站 / App" />
          </div>
          <div>
            <label class="label">账号</label>
            <input v-model="form.account" class="input" autocomplete="off" />
          </div>
          <div>
            <label class="label">密码</label>
            <input v-model="form.secret" class="input" autocomplete="off" />
          </div>
          <div>
            <label class="label">备注</label>
            <textarea v-model="form.note" class="textarea" style="min-height: 80px" />
          </div>
        </div>
      </div>
    </Popup>

    <Popup v-model:show="batchOpen" position="bottom" round :style="{ maxHeight: '88%' }">
      <div style="padding: 16px; padding-bottom: calc(20px + env(safe-area-inset-bottom)); overflow-y: auto; max-height: 88vh">
        <div class="row-between" style="margin-bottom: 12px">
          <div style="font-size: 16px; font-weight: 600">批量添加</div>
          <button class="btn btn-ghost" @click="batchOpen = false">关闭</button>
        </div>

        <textarea
          v-model="batchText"
          class="textarea"
          style="min-height: 150px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px"
          placeholder="一行一条，可以直接粘浏览器导出的 CSV：&#10;GitHub,me@example.com,pass123&#10;淘宝,me@example.com,tb888&#10;&#10;带表头也认：name,url,username,password"
        />

        <div class="tiny muted" style="margin-top: 8px">
          认三种写法：浏览器导出的 CSV（有表头最准）、Tab / 逗号分隔的三四列、空格分隔的「站点 账号 密码」。
          同名（名称一样）的会跳过，不会重复加。
        </div>

        <div v-if="batchPreview.entries.length" class="batch-preview">
          <div class="tiny muted" style="margin-bottom: 6px">
            识别到 {{ batchPreview.entries.length }} 条<template v-if="batchPreview.skipped">，另有 {{ batchPreview.skipped }} 行看不懂会被跳过</template>
          </div>
          <div v-for="row in batchPreview.entries.slice(0, 5)" :key="`${row.site}-${row.account}`" class="batch-row">
            <span class="grow ellipsis">{{ row.site }}</span>
            <span class="tiny muted ellipsis" style="max-width: 42%">{{ row.account || '—' }}</span>
            <span class="tiny muted">{{ '•'.repeat(Math.min(8, Math.max(4, row.secret.length))) }}</span>
          </div>
          <div v-if="batchPreview.entries.length > 5" class="tiny muted" style="margin-top: 4px">
            还有 {{ batchPreview.entries.length - 5 }} 条…
          </div>
        </div>

        <button
          class="btn btn-primary btn-block"
          style="margin-top: 14px"
          :disabled="busy || !batchPreview.entries.length"
          @click="doBatchImport"
        >
          {{ busy ? '加密写入中…' : `导入 ${batchPreview.entries.length} 条` }}
        </button>
      </div>
    </Popup>

    <Popup v-model:show="importOpen" position="bottom" round>
      <div style="padding: 16px; padding-bottom: calc(20px + env(safe-area-inset-bottom))">
        <div class="row-between" style="margin-bottom: 14px">
          <div style="font-size: 16px; font-weight: 600">导入加密库</div>
          <button class="btn btn-ghost" @click="importOpen = false">关闭</button>
        </div>
        <div class="banner danger" style="margin-top: 0">
          <div class="grow small">导入会覆盖本机现有的全部密码条目，无法撤销。</div>
        </div>
        <div class="form" style="margin-top: 12px">
          <div>
            <label class="label">选择文件</label>
            <input
              class="input"
              type="file"
              accept="application/json,.json"
              @change="importFile = ($event.target as HTMLInputElement).files?.[0] ?? null"
            />
          </div>
          <div>
            <label class="label">这份文件的主密码</label>
            <input v-model="importPwd" class="input" type="password" />
          </div>
        </div>
        <button class="btn btn-primary btn-block" style="margin-top: 16px" :disabled="busy" @click="doImport">
          {{ busy ? '校验中…' : '导入' }}
        </button>
      </div>
    </Popup>
  </div>
</template>
