import { Capacitor, registerPlugin } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

/**
 * 把一段文本存成文件（2026-11-02）。
 *
 * 浏览器：Blob + `<a download>`，落到浏览器的默认下载目录。
 * APK：WebView 没有 DownloadListener，`<a download>` 点了不报错也不产生文件；
 *      系统分享面板里也不一定有「保存到文件」（取决于装了哪些 App）。
 *      所以走自定义插件 `SaveFile`：`ACTION_CREATE_DOCUMENT`，让用户自己选目录（下载 / Documents / 网盘），
 *      不需要任何存储权限。插件不可用（老包）或写入失败时，退回「写缓存 + 系统分享」。
 */
export async function saveTextFile(fileName: string, text: string, mime = 'application/json'): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    const blob = new Blob([text], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = Object.assign(document.createElement('a'), { href: url, download: fileName })
    a.click()
    // 立刻 revoke 在部分浏览器会取消下载
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return
  }

  try {
    await SaveFile.save({ fileName, data: text, mime })
    return
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 用户自己点了取消：不兜底，也不提示失败
    if (message.includes('取消')) throw error
  }

  const written = await Filesystem.writeFile({
    path: fileName,
    data: text,
    directory: Directory.Cache,
    encoding: Encoding.UTF8
  })
  await Share.share({
    title: fileName,
    url: written.uri,
    dialogTitle: '导出到…'
  })
}

interface SaveFilePlugin {
  /** 打开系统「保存到」界面；用户取消时 reject 一条带「取消」的错误 */
  save(options: { fileName: string; data: string; mime?: string }): Promise<void>
}

const SaveFile = registerPlugin<SaveFilePlugin>('SaveFile')
