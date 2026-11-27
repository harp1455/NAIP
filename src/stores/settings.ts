import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { fetchSubscription } from '../nai/client'
import type { SubscriptionInfo } from '../nai/types'
import { clamp, round1 } from '../lib/util'
import type { TagSourceSetting } from '../lib/tags'
import { readSecret, writeSecret } from '../lib/secrets'

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
  /** 골라서 저장할 때 쓰는 폴더 목록 (Pictures/NAIP 아래) */
  saveFolders: string[]
  /** 마지막으로 고른 저장 폴더 ('' = 기본) 와 메타데이터 제거 여부 */
  saveFolder: string
  stripMeta: boolean
  /** 저장할 때 이름 정하는 방식: auto = 자동(번호), manual = 하나씩 지정 */
  nameMode: 'auto' | 'manual'
  /** 자동 번호를 이어 매기기 위한 마지막 번호 (`폴더/이름` → 번호) */
  nameCounters: Record<string, number>
  /** 업데이트를 확인할 GitHub 저장소 (owner/repo) 와, 비공개 저장소일 때 쓰는 읽기 전용 토큰 */
  updateRepo: string
  githubToken: string
  /** 클립보드 복사·공유로 내보낼 때 NAI 메타데이터를 지울지 */
  shareStripMeta: boolean
  /** 생성 중 단계별 미리보기 (generate-image-stream) */
  streaming: boolean
  subscription: SubscriptionInfo | null
  /** subscription을 서버에서 읽은 시각 (V5 할당량이 언제 다 차는지 계산하는 기준) */
  subscriptionAt: number
  subscriptionError: string | null
  setToken: (token: string) => void
  setDelay: (min: number, max: number) => void
  patch: (
    p: Partial<
      Pick<SettingsState, 'autoSave' | 'keepAwake' | 'background' | 'vibrate' | 'historyLimit' | 'sceneFolders' | 'tagSource' | 'saveFolders' | 'saveFolder' | 'stripMeta' | 'nameMode' | 'nameCounters' | 'updateRepo' | 'githubToken' | 'shareStripMeta' | 'streaming'>
    >
  ) => void
  refreshSubscription: () => Promise<void>
  /** 암호화 저장소에서 토큰을 읽었는지 (읽기 전에는 "토큰 없음"으로 단정하지 않는다) */
  secretsLoaded: boolean
  /** 앱 시작 시 한 번: 암호화 저장소에서 토큰을 읽고, 예전 평문 토큰이 있으면 옮긴 뒤 지운다 */
  loadSecrets: () => Promise<void>
  setGithubToken: (token: string) => void
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
      saveFolders: [],
      saveFolder: '',
      stripMeta: false,
      nameMode: 'auto',
      nameCounters: {},
      updateRepo: 'harp1455/NAIP',
      githubToken: '',
      shareStripMeta: false,
      streaming: true,
      subscription: null,
      subscriptionAt: 0,
      subscriptionError: null,
      setToken: (token) => {
        const value = token.trim()
        set({ token: value, subscription: null, subscriptionError: null })
        void writeSecret('naiToken', value)
      },
      setGithubToken: (token) => {
        const value = token.trim()
        set({ githubToken: value })
        void writeSecret('githubToken', value)
      },
      secretsLoaded: false,
      loadSecrets: async () => {
        // 0.12.0까지는 토큰이 naip-settings(localStorage)에 평문으로 들어 있었다 — 한 번 옮기고 지운다
        const legacy = get() as SettingsState & { token: string; githubToken: string }
        const [nai, gh] = await Promise.all([readSecret('naiToken'), readSecret('githubToken')])
        let token = nai.value
        let githubToken = gh.value
        if (!token && legacy.token) {
          token = legacy.token
          await writeSecret('naiToken', token)
        }
        if (!githubToken && legacy.githubToken) {
          githubToken = legacy.githubToken
          await writeSecret('githubToken', githubToken)
        }
        set({
          token,
          githubToken,
          secretsLoaded: true,
          ...(nai.lost ? { subscriptionError: '기기 보안 상태가 바뀌어 저장된 토큰을 읽을 수 없습니다. 토큰을 다시 넣어 주세요' } : {})
        })
      },
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
          if (get().token === token) set({ subscription, subscriptionAt: Date.now(), subscriptionError: null })
        } catch (e) {
          if (get().token === token) set({ subscriptionError: (e as Error).message })
        }
      }
    }),
    {
      name: 'naip-settings',
      // 토큰은 여기(평문 localStorage)에 두지 않는다 — loadSecrets/setToken이 암호화 저장소를 쓴다
      partialize: (s) => ({
        delayMin: s.delayMin,
        delayMax: s.delayMax,
        autoSave: s.autoSave,
        keepAwake: s.keepAwake,
        background: s.background,
        vibrate: s.vibrate,
        historyLimit: s.historyLimit,
        sceneFolders: s.sceneFolders,
        tagSource: s.tagSource,
        saveFolders: s.saveFolders,
        saveFolder: s.saveFolder,
        stripMeta: s.stripMeta,
        nameMode: s.nameMode,
        nameCounters: s.nameCounters,
        updateRepo: s.updateRepo,
        shareStripMeta: s.shareStripMeta,
        streaming: s.streaming
      })
    }
  )
)

export function anlasOf(s: SubscriptionInfo | null): number | null {
  return s ? s.anlasFixed + s.anlasPurchased : null
}
