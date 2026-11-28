import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'io.github.harp1455.naip',
  appName: 'NAIP',
  webDir: 'dist',
  // 배포하는 APK는 디버그 빌드라 기본값(debug)이면 브리지가 모든 플러그인 호출의 인자와 결과를 logcat에 남긴다 —
  // NaipSecure.set/get(토큰 값), httpGet/installUpdate(GitHub 토큰)까지. 인증정보가 로그에 남지 않게 끈다
  loggingBehavior: 'none',
  android: {
    backgroundColor: '#111111',
    // 적지 않으면 디버그 APK(배포본)에서 웹뷰 원격 디버깅이 켜져, USB로 연결한 누구나 chrome://inspect에서
    // 플러그인을 불러 토큰을 꺼낼 수 있다. 개발하면서 웹뷰를 살펴볼 때만 이 기기에서 잠시 켠다
    webContentsDebuggingEnabled: false
  }
}

export default config
