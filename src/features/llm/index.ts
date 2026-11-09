import type { FeatureModule } from '../../core/contracts'
import { accessUpdateTool, memoryUpdateTool } from './memoryTool'

const llm: FeatureModule = {
  id: 'llm',
  routes: [
    { path: '/llm', name: 'llm-chat', component: () => import('./ChatView.vue') },
    { path: '/llm/settings', name: 'llm-settings', component: () => import('./LlmSettingsView.vue') },
    { path: '/llm/prompt', name: 'llm-prompt', component: () => import('./PromptView.vue') }
  ],
  homeEntry: { title: '对话', icon: 'chat', to: '/llm' },
  // 记忆/人格工具：只有「写作」「心理」这类允许自改的预设才会把它交给模型（见 memoryAwareModules）
  tools: [memoryUpdateTool, accessUpdateTool],
  defaultModulePrompt: ''
}

export default llm
