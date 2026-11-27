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

export async function writeSecret(name: SecretName, value: string): Promise<void> {
  if (isNative) return Secure.set({ name, value })
  try {
    if (value) localStorage.setItem(DEV_PREFIX + name, value)
    else localStorage.removeItem(DEV_PREFIX + name)
  } catch {
    // 저장소를 못 쓰는 환경 — 이번 실행 동안만 메모리에 남는다
  }
}
