import { onUnmounted, ref, watch, type ComputedRef, type Ref } from 'vue'
import { liveQuery } from 'dexie'

/**
 * 带依赖的 live 查询：依赖变了就换一次订阅（ScheduleView 切换日期时用）。
 * 和 useLive 一样，结果只用于渲染，不要再复制到本地变量。
 */
export function useLiveOn<D, T>(
  dep: Ref<D> | ComputedRef<D>,
  query: (value: D) => Promise<T>
): Ref<T | undefined> {
  const data = ref<T>()
  let sub: { unsubscribe(): void } | null = null

  const stop = watch(
    dep,
    value => {
      sub?.unsubscribe()
      sub = liveQuery(() => query(value)).subscribe({
        next: v => {
          data.value = v as T
        },
        error: e => console.error('[liveQuery]', e)
      })
    },
    { immediate: true }
  )

  onUnmounted(() => {
    stop()
    sub?.unsubscribe()
  })

  return data as Ref<T | undefined>
}
