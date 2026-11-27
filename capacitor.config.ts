import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'io.github.harp1455.naip',
  appName: 'NAIP',
  webDir: 'dist',
  // 배포하는 APK는 디버그 빌드라 기본값(debug)이면 브리지가 모든 플러그인 호출의 인자와 결과를 logcat에 남긴다 —
  // NaipSecure.set/get(토큰 값), httpGet/installUpdate(GitHub 토큰)까지. 인증정보가 로그에 남지 않게 끈다
  loggingBehavior: 'none',
  android: {
    backgroundColor: '#111111'
  }
}

export default config
