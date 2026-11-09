<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{ mood?: string; size?: number }>(), { size: 20 })

/**
 * 日记心情：实心色点（2026-10-31 用户选 C）。
 * 情绪主要靠颜色区分，白色五官压在上面 —— 小尺寸时比纯线条更清楚。
 * 数据库里存的仍是 emoji（😀🙂😐😔😡），这样老日记、备份文件都不用迁；
 * 认不出来的心情（早期数据或用户自己填的）退回显示原字符。
 */
const FACES: Record<string, { fill: string; mouth: string; brow?: string }> = {
  '😀': { fill: '#4a7f5f', mouth: 'M12.5 23.5c1.6 4.2 13 4.2 15 0' },
  '🙂': { fill: '#7f8f5f', mouth: 'M14 24.5c1.6 2.4 10.4 2.4 12 0' },
  '😐': { fill: '#8f8b80', mouth: 'M14.5 25h11' },
  '😔': { fill: '#6f7f96', mouth: 'M13.5 27.5c1.8-3.4 11.2-3.4 13 0' },
  '😡': { fill: '#a8322d', mouth: 'M14 27.5c2-2.8 10-2.8 12 0', brow: 'M12 12.5l5.5 2.5M28 12.5l-5.5 2.5' }
}

const face = computed(() => FACES[String(props.mood ?? '').trim()])
</script>

<template>
  <svg
    v-if="face"
    :width="size"
    :height="size"
    viewBox="0 0 40 40"
    fill="none"
    stroke="#fff"
    stroke-width="2.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="20" cy="20" r="16" :fill="face.fill" stroke="none" />
    <circle cx="15" cy="16.5" r="1.8" fill="#fff" stroke="none" />
    <circle cx="25" cy="16.5" r="1.8" fill="#fff" stroke="none" />
    <path :d="face.mouth" />
    <path v-if="face.brow" :d="face.brow" />
  </svg>
  <span v-else-if="mood" class="mood-fallback">{{ mood }}</span>
</template>
