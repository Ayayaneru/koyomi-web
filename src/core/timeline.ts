import { liveQuery } from 'dexie'
import { onUnmounted, ref, watch, type Ref } from 'vue'
import type { DayItem } from './contracts'
import { modules } from './container'

/**
 * 唯一的跨模块地方。日视图不认识任何具体模块，只向注册表要这一段有哪些条目。
 * 删掉 task 模块，时间轴自动只剩日程，日视图一行都不用改。
 */
export function useDayTimeline(range: Ref<{ start: number; end: number }>) {
  const data = ref<DayItem[]>([])
  let sub: { unsubscribe(): void } | null = null

  watch(
    range,
    r => {
      sub?.unsubscribe()
      sub = liveQuery(async () => {
        const parts = await Promise.all(modules.map(m => m.timeline?.(r) ?? Promise.resolve([])))
        return parts.flat().sort((a, b) => a.at - b.at)
      }).subscribe({
        next: v => {
          data.value = v as DayItem[]
        },
        error: e => console.error('[timeline]', e)
      })
    },
    { immediate: true, deep: true }
  )

  onUnmounted(() => sub?.unsubscribe())
  return data
}
