import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import { modules } from './core/container'

/**
 * hash 模式：WebView 里没有 HTTP 服务器，history 模式刷新和深链会 404。
 * 浏览器开发时 hash 也照样能用。
 */
const routes: RouteRecordRaw[] = [
  { path: '/', name: 'home', component: () => import('./HomeView.vue') },
  { path: '/settings', name: 'settings', component: () => import('./features/settings/SettingsView.vue') },
  ...modules.flatMap(m => m.routes),
  { path: '/:pathMatch(.*)*', redirect: '/' }
]

export default createRouter({ history: createWebHashHistory(), routes })
