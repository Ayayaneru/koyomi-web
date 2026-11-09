import type { FeatureModule } from '../../core/contracts'
import { vaultSearchDiary, vaultWriteDiary } from './diaryTool'

/**
 * 密码库不在这里出现 —— 它不实现 AppTool，模型拿到的函数列表里从来没有它。
 * tools 数组里只有日记那两个。
 */
const vault: FeatureModule = {
  id: 'vault',
  routes: [
    { path: '/vault', name: 'vault-diary', component: () => import('./DiaryView.vue') },
    { path: '/vault/passwords', name: 'vault-passwords', component: () => import('./PasswordsView.vue') }
  ],
  homeEntry: { title: '日记', icon: 'book', to: '/vault' },
  tools: [vaultWriteDiary, vaultSearchDiary],
  // 2026-11-01：能写能查工具说明里有；密码库那句已经挪进人格（它跟日记权限无关）
  defaultModulePrompt: `除非用户明确要求，不要主动引用日记正文。`
}

export default vault
