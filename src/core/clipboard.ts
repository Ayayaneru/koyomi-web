/**
 * 复制到剪贴板（2026-11-02）。
 *
 * 安卓 WebView 里 `navigator.clipboard.writeText` 经常被拒（NotAllowedError），
 * 所以先走同步的 `execCommand('copy')`：它在用户手势里最稳，而且不用等异步。
 * 两条都失败才返回 false，由界面提示「长按手动选」。
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  if (legacyCopy(text)) return true
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 掉到下面的失败返回
  }
  return false
}

/** 老办法：临时 textarea + 选中 + execCommand，全程同步 */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  // 放在视口里但看不见：display:none / 移出屏幕都可能让 select() 失效
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.left = '0'
  area.style.width = '1px'
  area.style.height = '1px'
  area.style.padding = '0'
  area.style.border = 'none'
  area.style.opacity = '0'
  area.style.pointerEvents = 'none'
  document.body.appendChild(area)
  try {
    area.focus({ preventScroll: true })
    area.select()
    area.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
  }
}
