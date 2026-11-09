import { liveQuery } from 'dexie'
import { onMounted, onUnmounted, ref, type Ref } from 'vue'

/**
 * 订阅式列表。
 * 唯一规矩：查询结果不许再复制到本地 ref 覆盖渲染，否则数据库变了界面不会更新。
 */
export function useLive<T>(query: () => Promise<T>): Ref<T | undefined> {
  const data = ref<T>()
  let sub: { unsubscribe(): void } | null = null

  onMounted(() => {
    sub = liveQuery(query).subscribe({
      next: v => {
        data.value = v as T
      },
      error: e => console.error('[liveQuery]', e)
    })
  })
  onUnmounted(() => sub?.unsubscribe())

  return data as Ref<T | undefined>
}
