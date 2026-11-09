import type { CapacitorConfig } from '@capacitor/cli'

/**
 * APK 外壳配置（§11.2）。
 * webDir 是 npm run build 的产物，每次 cap sync 覆盖，不要手改 android/app/src/main/assets/public。
 */
const config: CapacitorConfig = {
  appId: 'com.koyomi.app',
  appName: 'Koyomi',
  webDir: 'dist',
  server: {
    // APK 里的 origin 是 https://localhost，与浏览器的 localhost:5173 是两个互不相干的库
    androidScheme: 'https'
  },
  android: {
    allowMixedContent: false
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_icon',
      iconColor: '#3f5f4f'
    }
  }
}

export default config
