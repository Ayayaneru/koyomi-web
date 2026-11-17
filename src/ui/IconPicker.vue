<script setup lang="ts">
import { ref, watch } from 'vue'
import TaskIcon from './TaskIcon.vue'
import { iconStyle, setIconStyle, type IconStyle } from './iconStyle'

const props = defineProps<{ modelValue?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

/**
 * 25 个常用图标，两套画法（彩色 / 线条）共用同一份清单。
 * 第 26 个由用户自己贴 emoji —— 不在素材表里的会原样显示。
 */
const PRESETS = [
  '🐟', '🌱', '💧', '🪴', '☀️', '🌙', '💊', '🦷',
  '🧺', '🧹', '🚿', '🍚', '📚', '🏃', '💤', '🐱',
  '🚲', '📦', '💡', '🗑️', '☕', '🚰', '🛒', '🍳', '💸'
]

const STYLES: { key: IconStyle; label: string }[] = [
  { key: 'color', label: '彩色' },
  { key: 'line', label: '线条' }
]

const custom = ref('')

watch(
  () => props.modelValue,
  v => {
    if (v && !PRESETS.includes(v)) custom.value = v
  },
  { immediate: true }
)

function pick(icon: string) {
  emit('update:modelValue', props.modelValue === icon ? '' : icon)
}

function onCustom() {
  const first = Array.from(custom.value.trim())[0] ?? ''
  custom.value = first
  emit('update:modelValue', first)
}

function clear() {
  custom.value = ''
  emit('update:modelValue', '')
}
</script>

<template>
  <div>
    <div class="row-between" style="margin-bottom: 8px">
      <span class="tiny muted">{{ STYLES.find(s => s.key === iconStyle)?.label }} · 换个风格整页一起变</span>
      <div class="seg">
        <button
          v-for="s in STYLES"
          :key="s.key"
          type="button"
          :class="{ on: iconStyle === s.key }"
          @click="setIconStyle(s.key)"
        >
          {{ s.label }}
        </button>
      </div>
    </div>

    <div class="icon-grid">
      <button
        v-for="icon in PRESETS"
        :key="icon"
        type="button"
        class="icon-cell"
        :class="{ on: modelValue === icon }"
        @click="pick(icon)"
      >
        <TaskIcon :icon="icon" :size="26" />
      </button>
    </div>

    <div class="row" style="margin-top: 8px">
      <input
        v-model="custom"
        class="input"
        style="max-width: 120px; text-align: center"
        placeholder="自己贴一个"
        @input="onCustom"
      />
      <button type="button" class="chip" :class="{ on: !modelValue }" @click="clear">不用图标</button>
    </div>
    <div class="tiny muted" style="margin-top: 6px">
      不在这 25 个里的 emoji 会按手机字体的样子显示；不用图标就显示标题首字。
    </div>
  </div>
</template>
