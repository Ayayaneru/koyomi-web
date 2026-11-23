<script setup lang="ts">
import { computed } from 'vue'
import { iconStyle } from './iconStyle'

const props = withDefaults(
  defineProps<{ icon?: string; fallback?: string; size?: number }>(),
  { size: 24 }
)

/**
 * emoji → 素材文件码点。素材在 src/assets/task-icons/，全部自绘（随代码按 MIT）。
 * 彩色（color）和黑色描边（black）是同一套图形的两版，只差一个后缀。
 * 表里没有的 emoji（用户自己贴的）照原样显示，不会变成方块。
 */
const CODES: Record<string, string> = {
  '🐟': '1F41F',
  '🌱': '1F331',
  '💧': '1F4A7',
  '🪴': '1FAB4',
  '☀': '2600',
  '☀️': '2600',
  '🌙': '1F319',
  '💊': '1F48A',
  '🦷': '1F9B7',
  '🧺': '1F9FA',
  '🧹': '1F9F9',
  '🚿': '1F6BF',
  '🍚': '1F35A',
  '📚': '1F4DA',
  '🏃': '1F3C3',
  '💤': '1F4A4',
  '🐱': '1F431',
  '🚲': '1F6B2',
  '📦': '1F4E6',
  '💡': '1F4A1',
  '🗑': '1F5D1',
  '🗑️': '1F5D1',
  '☕': '2615',
  '🚰': '1F6B0',
  '🛒': '1F6D2',
  '🍳': '1F373',
  '💸': '1F4B8'
}

const FILES = import.meta.glob('../assets/task-icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

const url = computed(() => {
  const code = CODES[String(props.icon ?? '').trim()]
  if (!code) return ''
  const variant = iconStyle.value === 'line' ? 'black' : 'color'
  return FILES[`../assets/task-icons/${code}-${variant}.svg`] ?? ''
})

/** 没有图标、或者图标不在素材表里，就退回文字（标题首字 / 用户自己贴的 emoji） */
const text = computed(() => String(props.icon ?? '').trim() || props.fallback || '·')
</script>

<template>
  <img
    v-if="url"
    :src="url"
    :width="size"
    :height="size"
    :alt="text"
    class="task-glyph"
    aria-hidden="true"
  />
  <span v-else class="task-glyph-text">{{ text }}</span>
</template>
