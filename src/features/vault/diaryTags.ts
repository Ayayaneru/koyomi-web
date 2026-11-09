/**
 * 日记的标签在库里是**一个逗号分隔的字符串**（DiaryRow.tags），不是数组。
 * 这里放两件跟它有关的纯函数，界面和改名流程共用，也好单测。
 */

/** "工作, #生活 读书" → ['工作', '生活', '读书']。中英文逗号、空格都算分隔符 */
export function splitTags(text: string | undefined): string[] {
  return (text ?? '')
    .split(/[,，\s]+/)
    .map(tag => tag.trim().replace(/^#/, ''))
    .filter(Boolean)
}

/**
 * 标签改名：把某条日记里的旧名字整词换成新名字。
 *
 * - 只换整词，'工作事项' 不会因为改 '工作' 被误伤；
 * - 换完和同一条里已有的标签重名就去重（'工作,生活' + 工作→生活 = '生活'）；
 * - 这条日记根本没有旧名字时返回 null，调用方据此跳过，不做多余的写库。
 */
export function renameTagInText(text: string | undefined, from: string, to: string): string | null {
  const tags = splitTags(text)
  if (!tags.includes(from)) return null
  const next: string[] = []
  for (const tag of tags) {
    const name = tag === from ? to : tag
    if (!next.includes(name)) next.push(name)
  }
  return next.join(',')
}
