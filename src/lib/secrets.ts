import { registerPlugin } from '@capacitor/core'
import { isNative } from './native'

/**
 * 인증정보 보관 — 휴대폰에서는 Android Keystore로 암호화한 저장소(NaipSecurePlugin),
 * 브라우저 개발 빌드에서는 별도 localStorage 칸(평문, 개발용)을 쓴다.
 * 설정 저장소(naip-settings)와 백업에는 토큰이 들어가지 않는다.
 */
interface NaipSecurePlugin {
  get(opts: { name: string }): Promise<{ value: string; lost?: boolean }>
  set(opts: { name: string; value: string }): Promise<void>
}

const Secure = registerPlugin<NaipSecurePlugin>('NaipSecure')
const DEV_PREFIX = 'naip-dev-secret:'

export type SecretName = 'naiToken' | 'githubToken'

/**
 * lost: 암호화 키가 바뀌어 다시는 풀 수 없는 값이라 지웠다.
 * 휴대폰에서 키 저장소가 잠시 응답하지 않으면 reject 한다 — 저장된 값은 지우지 않는다 (다음에 다시 읽는다)
 */
export async function readSecret(name: SecretName): Promise<{ value: string; lost: boolean }> {
  if (isNative) {
    const r = await Secure.get({ name })
    return { value: r.value ?? '', lost: !!r.lost }
  }
  try {
    return { value: localStorage.getItem(DEV_PREFIX + name) ?? '', lost: false }
  } catch {
    return { value: '', lost: false }
  }
}

/** 디스크에 쓴 뒤에 끝난다 (실패하면 reject — 메시지에 값은 없다) */
export async function writeSecret(name: SecretName, value: string): Promise<void> {
  if (isNative) return Secure.set({ name, value })
  try {
    if (value) localStorage.setItem(DEV_PREFIX + name, value)
    else localStorage.removeItem(DEV_PREFIX + name)
  } catch {
    // 저장소를 못 쓰는 환경 — 이번 실행 동안만 메모리에 남는다
  }
}
