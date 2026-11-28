import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { fetchSubscription } from '../nai/client'
import type { SubscriptionInfo } from '../nai/types'
import { clamp, round1 } from '../lib/util'
import type { TagSourceSetting } from '../lib/tags'
import { readSecret, writeSecret, type SecretName } from '../lib/secrets'
import { toast } from './toast'

export const DELAY_MIN = 1
export const DELAY_MAX = 2

type SecretField = 'token' | 'githubToken'
const SECRET_FIELDS: SecretField[] = ['token', 'githubToken']
const SECRET_NAME: Record<SecretField, SecretName> = { token: 'naiToken', githubToken: 'githubToken' }
const SECRET_LABEL: Record<SecretField, string> = { token: 'NovelAI 토큰', githubToken: 'GitHub 토큰' }

/**
 * 0.12.0까지 naip-settings(평문 localStorage)에 있던 토큰.
 * 암호화 저장소에 쓰고 다시 읽어 같은 값인 것을 확인하기 전에는 naip-settings에서 지우지 않는다
 * (옮기다 실패하면 다음 실행에서 다시 옮긴다). 확인되면 다음 저장 때 naip-settings에서 빠진다.
 */
const legacyHeld: Partial<Record<SecretField, string>> = {}
/** 이번 실행에서 사용자가 직접 넣은 토큰 — 시작할 때 읽어 온 값이나 예전 값으로 덮지 않는다 */
const userSet: Partial<Record<SecretField, boolean>> = {}

interface LoadedSecret {
  value: string
  /** 암호화 키가 바뀌어 저장된 값을 영영 풀 수 없어 지워졌다 */
  lost: boolean
  /** 지금은 읽지 못했다 (일시적인 오류일 수 있어 지우지 않았다) */
  unreadable: boolean
  /** 예전 평문을 암호화 저장소로 옮기지 못했다 (평문은 그대로 둔다) */
  unmoved: boolean
}

async function loadSecret(field: SecretField): Promise<LoadedSecret> {
  const name = SECRET_NAME[field]
  const none = { lost: false, unreadable: false, unmoved: false }
  let stored: { value: string; lost: boolean }
  try {
    stored = await readSecret(name)
  } catch {
    // 저장된 값도, 예전 평문도 그대로 둔다 — 이번 실행은 예전 평문(있으면)으로 쓴다
    return { ...none, value: legacyHeld[field] ?? '', unreadable: true }
  }
  const legacy = legacyHeld[field]
  if (legacy === undefined || userSet[field]) return { ...none, value: stored.value, lost: stored.lost }
  if (stored.value) {
    // 이미 옮겨져 있다 (지난 실행이 평문을 지우기 전에 끝났다) — 암호화 저장소 쪽이 최신이다
    delete legacyHeld[field]
    return { ...none, value: stored.value }
  }
  try {
    await writeSecret(name, legacy)
    const check = await readSecret(name)
    if (check.value !== legacy) throw new Error('verify')
    delete legacyHeld[field]
    return { ...none, value: legacy }
  } catch {
    return { ...none, value: legacy, unmoved: true }
  }
}

function secretNotice(field: SecretField, r: LoadedSecret): string | null {
  const label = SECRET_LABEL[field]
  if (r.lost) return `기기 보안 상태가 바뀌어 저장된 ${label}을 읽을 수 없습니다. ${label}을 다시 넣어 주세요`
  if (r.unreadable) return `저장된 ${label}을 지금은 읽지 못했습니다 (지우지 않았습니다). 앱을 다시 열어 보고, 계속되면 ${label}을 다시 넣어 주세요`
  if (r.unmoved) return `${label}을 암호화 저장소로 옮기지 못했습니다. 예전 자리에 그대로 두고 다음에 앱을 열 때 다시 옮깁니다`
  return null
}

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
  /** 토큰을 읽거나 저장하지 못한 이유 (구독 확인과 상관없이 새 토큰을 저장할 때까지 남는다) */
  secretErrors: Partial<Record<SecretField, string>>
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
      secretErrors: {},
      setToken: (token) => {
        const value = token.trim()
        set({ token: value, subscription: null, subscriptionError: null })
        void saveSecret('token', value)
      },
      setGithubToken: (token) => {
        const value = token.trim()
        set({ githubToken: value })
        void saveSecret('githubToken', value)
      },
      secretsLoaded: false,
      loadSecrets: async () => {
        // 0.12.0까지는 토큰이 naip-settings(localStorage)에 평문으로 들어 있었다 — 옮긴 것을 확인한 뒤에만 지운다
        const [nai, gh] = await Promise.all(SECRET_FIELDS.map(loadSecret))
        const loaded: Record<SecretField, LoadedSecret> = { token: nai, githubToken: gh }
        const next: Partial<SettingsState> = { secretsLoaded: true }
        const errors = { ...get().secretErrors }
        for (const field of SECRET_FIELDS) {
          // 읽는 사이 사용자가 새로 넣은 값은 그대로 둔다
          if (userSet[field]) continue
          next[field] = loaded[field].value
          const notice = secretNotice(field, loaded[field])
          if (notice) errors[field] = notice
        }
        set({ ...next, secretErrors: errors })
        const first = SECRET_FIELDS.map((f) => errors[f]).find(Boolean)
        if (first) toast(first, true)
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
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Record<SecretField, unknown>>
        for (const field of SECRET_FIELDS) {
          const v = p[field]
          if (typeof v === 'string' && v.trim()) legacyHeld[field] = v
        }
        return { ...current, ...(persisted as object) }
      },
      // 토큰은 여기(평문 localStorage)에 두지 않는다 — loadSecrets/setToken이 암호화 저장소를 쓴다.
      // 예외: 예전 평문 토큰은 암호화 저장소로 옮긴 것이 확인될 때까지 그대로 남긴다 (legacyHeld)
      partialize: (s) => ({
        ...legacyHeld,
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

/**
 * 암호화 저장소에 쓴다 (빈 값이면 지운다). 실패하면 화면에 알린다 — 저장된 값은 그대로라 앱을 다시 열면
 * 그 값(있으면)이 돌아온다. 예전 평문은 새 값을 저장했거나 사용자가 지웠을 때만 뺀다
 * (다른 값을 저장하지 못했을 때는 남은 하나뿐인 사본이라 그대로 둔다)
 */
async function saveSecret(field: SecretField, value: string): Promise<void> {
  userSet[field] = true
  const errors = (): Partial<Record<SecretField, string>> => ({ ...useSettings.getState().secretErrors })
  try {
    await writeSecret(SECRET_NAME[field], value)
    if (useSettings.getState()[field] !== value) return // 그 사이 또 바뀌었다 — 나중 호출이 정리한다
    // 새 값을 저장했으니 예전 평문은 필요 없다 (아래 setState가 naip-settings를 다시 쓴다)
    delete legacyHeld[field]
    const rest = errors()
    delete rest[field]
    useSettings.setState({ secretErrors: rest })
  } catch {
    if (useSettings.getState()[field] !== value) return
    const label = SECRET_LABEL[field]
    // 지운 토큰이 평문으로 남아 다음 실행에 되살아나지 않게 (아래 setState가 naip-settings를 다시 쓴다)
    if (!value) delete legacyHeld[field]
    useSettings.setState({
      secretErrors: {
        ...errors(),
        [field]: value
          ? `${label}을 기기에 저장하지 못했습니다. 이 값은 이번 실행에서만 쓰이고, 앱을 다시 열면 전에 저장된 값이 있으면 그 값을 씁니다`
          : `${label}을 기기에서 지우지 못했습니다. 앱을 다시 열면 전에 저장된 값이 다시 들어올 수 있으니 다시 지워 주세요`
      }
    })
  }
}

export function anlasOf(s: SubscriptionInfo | null): number | null {
  return s ? s.anlasFixed + s.anlasPurchased : null
}
