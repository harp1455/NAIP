import { describe, expect, it } from 'vitest'
import config from '../capacitor.config'

describe('Capacitor bridge logging', () => {
  it('is off, so plugin arguments and results (token values) never reach logcat', () => {
    // 기본값 debug 는 디버그 APK(배포본)에서 Bridge.callPluginMethod 가 methodData 를 Logger.verbose 로 찍는다 —
    // NaipSecure.set 의 value, NaipNative.httpGet·installUpdate 의 token. 웹뷰 쪽 logFromNative(NaipSecure.get 결과)도 같은 스위치다
    expect(config.loggingBehavior).toBe('none')
    // android 쪽 설정이 있으면 위 값을 덮어쓴다
    expect(config.android?.loggingBehavior ?? 'none').toBe('none')
  })

  it('turns WebView remote debugging off, which a debug APK would otherwise leave on', () => {
    // CapConfig: android.webContentsDebuggingEnabled 를 적지 않으면 FLAG_DEBUGGABLE(배포하는 디버그 APK는 켜짐)을 따른다 —
    // 그러면 USB로 연결한 누구나 chrome://inspect 에서 NaipSecure.get 으로 토큰을 꺼낼 수 있다
    expect(config.android?.webContentsDebuggingEnabled).toBe(false)
  })
})
