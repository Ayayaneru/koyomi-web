import { ref } from 'vue'
import { getConfig, patchConfig } from '../core/db'

/** color = OpenMoji 彩色（C）；line = 同一套图形的黑色描边（E） */
export type IconStyle = 'color' | 'line'

/**
 * 任务图标的画法，全局一份。
 * 存在 prefs.taskIconStyle 里，改完立刻生效，不用重启也不用改数据
 * —— 数据库里存的始终是 emoji 字符，换风格只换画法。
 */
export const iconStyle = ref<IconStyle>('color')

export async function loadIconStyle(): Promise<void> {
  const cfg = await getConfig()
  iconStyle.value = cfg.prefs.taskIconStyle === 'line' ? 'line' : 'color'
}

export async function setIconStyle(next: IconStyle): Promise<void> {
  iconStyle.value = next
  await patchConfig({ prefs: { taskIconStyle: next } })
}
