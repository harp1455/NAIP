import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { fetchSubscription } from '../nai/client'
import type { SubscriptionInfo } from '../nai/types'
import { clamp, round1 } from '../lib/util'
import type { TagSourceSetting } from '../lib/tags'

export const DELAY_MIN = 1
export const DELAY_MAX = 2

interface SettingsState {
  token: string
  /** 장 사이 대기 시간(초) 범위. 매 장마다 [delayMin, delayMax]에서 무작위로 뽑는다 */
  delayMin: number
  delayMax: number
  autoSave: boolean
  keepAwake: boolean
  /** 앱이 뒤로 가도 계속 생성 (포그라운드 서비스 + 진행 알림) */
  background: boolean
  /** 배치가 끝나면 진동 */
  vibrate: boolean
  /** 히스토리 보관 한도 (0 = 무제한). 넘으면 즐겨찾기를 뺀 오래된 것부터 삭제 */
  historyLimit: number
  /** 자동 저장 시 씬 이름 하위 폴더로 나눠 저장 */
  sceneFolders: boolean
  /** 태그 자동완성 출처 */
  tagSource: TagSourceSetting
  subscription: SubscriptionInfo | null
  subscriptionError: string | null
  setToken: (token: string) => void
  setDelay: (min: number, max: number) => void
  patch: (
    p: Partial<
      Pick<SettingsState, 'autoSave' | 'keepAwake' | 'background' | 'vibrate' | 'historyLimit' | 'sceneFolders' | 'tagSource'>
    >
  ) => void
  refreshSubscription: () => Promise<void>
}

export const useSettings = create<SettingsState>()(
  persist(
    (set, get) => ({
      token: '',
      delayMin: 1.1,
      delayMax: 1.3,
      autoSave: false,
      keepAwake: true,
      background: true,
      vibrate: true,
      historyLimit: 0,
      sceneFolders: true,
      tagSource: 'both',
      subscription: null,
      subscriptionError: null,
      setToken: (token) => set({ token: token.trim(), subscription: null, subscriptionError: null }),
      setDelay: (min, max) => {
        const lo = round1(clamp(min, DELAY_MIN, DELAY_MAX))
        const hi = round1(clamp(max, DELAY_MIN, DELAY_MAX))
        set({ delayMin: Math.min(lo, hi), delayMax: Math.max(lo, hi) })
      },
      patch: (p) => set(p),
      refreshSubscription: async () => {
        const token = get().token
        if (!token) {
          set({ subscription: null, subscriptionError: null })
          return
        }
        try {
          const subscription = await fetchSubscription(token)
          if (get().token === token) set({ subscription, subscriptionError: null })
        } catch (e) {
          if (get().token === token) set({ subscriptionError: (e as Error).message })
        }
      }
    }),
    {
      name: 'naip-settings',
      partialize: (s) => ({
        token: s.token,
        delayMin: s.delayMin,
        delayMax: s.delayMax,
        autoSave: s.autoSave,
        keepAwake: s.keepAwake,
        background: s.background,
        vibrate: s.vibrate,
        historyLimit: s.historyLimit,
        sceneFolders: s.sceneFolders,
        tagSource: s.tagSource
      })
    }
  )
)

export function anlasOf(s: SubscriptionInfo | null): number | null {
  return s ? s.anlasFixed + s.anlasPurchased : null
}
