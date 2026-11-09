import { readFileSync } from 'node:fs'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// 版本号只有一个来源：package.json。设置页里的「关于」显示的就是它
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string }

/**
 * 只给网页形态用的转发：有些厂商不放行浏览器跨域，直连会被拦。
 * 在设置页把 Base URL 填成 /zhipu/api/paas/v4 或 /opencode/zen/go/v1，请求就经这里转出去。
 * dev 和 preview 都要挂（有人用 `npm run preview` 看构建产物，那种情况下 /zhipu 也得通）。
 * 打包成 APK 后不需要它（非流式请求走 CapacitorHttp）。
 */
const proxy = {
  '/zhipu': {
    target: 'https://open.bigmodel.cn',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/zhipu/, '')
  },
  // OpenCode 的网关只放行 GET 的跨域（/models 能扫），POST /chat/completions 的预检直接 404
  '/opencode': {
    target: 'https://opencode.ai',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/opencode/, '')
  }
}

export default defineConfig({
  // 相对路径：APK 里从 https://localhost/ 读本地文件，两种形态都能用
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [vue()],
  server: {
    port: 5173,
    // android/ 里有 cap sync 复制进来的构建产物，别让 HMR 跟着它刷新
    watch: { ignored: ['**/android/**'] },
    proxy
  },
  preview: {
    port: 4173,
    proxy
  },
  build: {
    target: 'es2022'
  }
})
