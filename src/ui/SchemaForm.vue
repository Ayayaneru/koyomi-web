<script setup lang="ts">
import { computed, ref } from 'vue'
import { Picker, Popup } from 'vant'
import IconPicker from './IconPicker.vue'
import type { JsonSchema, JsonSchemaProp } from '../core/contracts'

const props = defineProps<{ schema: JsonSchema; modelValue: Record<string, unknown> }>()
const emit = defineEmits<{ 'update:modelValue': [value: Record<string, unknown>] }>()

const errors = ref<Record<string, string>>({})
const pickerKey = ref<string | null>(null)
const pickerIndex = ref<number>(0)

const fields = computed(() =>
  Object.entries(props.schema.properties).map(([name, prop]) => ({ name, prop }))
)
const required = computed(() => new Set(props.schema.required ?? []))

function get(name: string): unknown {
  return props.modelValue?.[name]
}

function set(name: string, value: unknown) {
  emit('update:modelValue', { ...props.modelValue, [name]: value })
  if (errors.value[name]) {
    const next = { ...errors.value }
    delete next[name]
    errors.value = next
  }
}

function str(name: string): string {
  const v = get(name)
  return v === undefined || v === null ? '' : String(v)
}

function num(name: string): string {
  const v = get(name)
  return typeof v === 'number' ? String(v) : ''
}

function onNum(name: string, prop: JsonSchemaProp, event: Event) {
  const raw = (event.target as HTMLInputElement).value
  if (raw === '') return set(name, undefined)
  let n = prop.type === 'integer' ? Math.round(Number(raw)) : Number(raw)
  if (Number.isNaN(n)) return
  if (prop.minimum !== undefined) n = Math.max(prop.minimum, n)
  if (prop.maximum !== undefined) n = Math.min(prop.maximum, n)
  set(name, n)
}

/* date-time：界面用原生控件，存的是 "2026-10-28 14:00"（全库统一的时间格式） */
function dateTimeInput(name: string): string {
  const v = str(name)
  return v ? v.replace(' ', 'T') : ''
}

function onDateTime(name: string, event: Event) {
  const raw = (event.target as HTMLInputElement).value
  set(name, raw ? raw.replace('T', ' ') : '')
}

/* enum：≤5 个选项分段按钮，>5 个用 Picker */
function enumOptions(prop: JsonSchemaProp): { value: string | number; text: string }[] {
  return (prop.enum ?? []).map((value, i) => ({ value, text: prop.enumNames?.[i] ?? String(value) }))
}

function enumLabel(prop: JsonSchemaProp, value: unknown): string {
  const hit = enumOptions(prop).find(o => o.value === value)
  return hit ? hit.text : '请选择'
}

function openPicker(name: string, prop: JsonSchemaProp) {
  pickerIndex.value = Math.max(0, enumOptions(prop).findIndex(o => o.value === get(name)))
  pickerKey.value = name
}

function onPickerConfirm(payload: { selectedValues: (string | number)[] }) {
  if (!pickerKey.value) return
  set(pickerKey.value, payload.selectedValues[0])
  pickerKey.value = null
}

function isMissing(name: string): boolean {
  const v = get(name)
  return v === undefined || v === null || v === ''
}

/** 提交前调用；返回 false 表示还差必填项 */
function validate(): boolean {
  const next: Record<string, string> = {}
  for (const { name, prop } of fields.value) {
    if (required.value.has(name) && isMissing(name)) {
      next[name] = '必填'
      continue
    }
    if (!isMissing(name) && (prop.type === 'number' || prop.type === 'integer') && typeof get(name) !== 'number') {
      next[name] = '要填数字'
    }
  }
  errors.value = next
  return Object.keys(next).length === 0
}

defineExpose({ validate })
</script>

<template>
  <div class="form">
    <div v-for="field in fields" :key="field.name">
      <label class="label">
        {{ field.prop.title || field.prop.description || field.name }}
        <span v-if="required.has(field.name)" style="color: var(--danger)">*</span>
      </label>

      <!-- 单个 emoji -->
      <IconPicker
        v-if="field.prop.format === 'icon'"
        :model-value="str(field.name)"
        @update:model-value="v => set(field.name, v)"
      />

      <!-- 日期时间 -->
      <input
        v-else-if="field.prop.format === 'date-time'"
        class="input"
        type="datetime-local"
        :value="dateTimeInput(field.name)"
        @input="onDateTime(field.name, $event)"
      />

      <!-- 多行文本 -->
      <textarea
        v-else-if="field.prop.format === 'textarea'"
        class="textarea"
        :value="str(field.name)"
        @input="set(field.name, ($event.target as HTMLTextAreaElement).value)"
      />

      <!-- 枚举：少则分段，多则 Picker（放在数字之前，否则 integer 枚举会掉进数字输入框） -->
      <div v-else-if="field.prop.enum && field.prop.enum.length">
        <div v-if="field.prop.enum.length <= 5" class="seg">
          <button
            v-for="opt in enumOptions(field.prop)"
            :key="opt.value"
            type="button"
            :class="{ on: get(field.name) === opt.value }"
            @click="set(field.name, opt.value)"
          >
            {{ opt.text }}
          </button>
        </div>
        <button v-else type="button" class="input row-between" @click="openPicker(field.name, field.prop)">
          <span>{{ enumLabel(field.prop, get(field.name)) }}</span>
          <span class="muted">›</span>
        </button>
      </div>

      <!-- 布尔 -->
      <div v-else-if="field.prop.type === 'boolean'" class="row">
        <button
          type="button"
          class="switch-dot"
          :class="{ on: get(field.name) === true }"
          @click="set(field.name, !(get(field.name) === true))"
        >
          ✓
        </button>
        <span class="small muted">{{ get(field.name) === true ? '是' : '否' }}</span>
      </div>

      <!-- 数字 -->
      <input
        v-else-if="field.prop.type === 'number' || field.prop.type === 'integer'"
        class="input"
        type="number"
        inputmode="decimal"
        :value="num(field.name)"
        @input="onNum(field.name, field.prop, $event)"
      />

      <!-- 普通字符串 -->
      <input
        v-else
        class="input"
        type="text"
        :value="str(field.name)"
        @input="set(field.name, ($event.target as HTMLInputElement).value)"
      />

      <div v-if="errors[field.name]" class="error-text">{{ errors[field.name] }}</div>
    </div>

    <Popup :show="pickerKey !== null" position="bottom" round @update:show="v => !v && (pickerKey = null)">
      <Picker
        :columns="pickerKey ? enumOptions(props.schema.properties[pickerKey]) : []"
        :model-value="pickerKey ? [enumOptions(props.schema.properties[pickerKey])[pickerIndex]?.value] : []"
        title="选择"
        @confirm="onPickerConfirm"
        @cancel="pickerKey = null"
      />
    </Popup>
  </div>
</template>
