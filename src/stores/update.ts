import { create } from 'zustand'
import { githubGet, installUpdate } from '../lib/native'
import { useSettings } from './settings'

export interface UpdateInfo {
  build: number
  title: string
  notes: string
  /** 공개 저장소용 직접 다운로드 주소 */
  downloadUrl: string
  /** 비공개 저장소용 API 주소 (토큰 + octet-stream) */
  assetApiUrl: string
  size: number
  pageUrl: string
}

type Status = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'error'

interface UpdateState {
  status: Status
  info: UpdateInfo | null
  error: string | null
  /** 0~1, 크기를 모르면 null */
  progress: number | null
  /** 이번 실행에서 배너를 닫았는지 */
  dismissed: boolean
  check: (silent?: boolean) => Promise<void>
  install: () => Promise<void>
  dismiss: () => void
}

/** 이 앱의 빌드 번호 (CI 빌드만 0보다 크다) */
export const CURRENT_BUILD = __BUILD__

interface ReleaseJson {
  tag_name?: string
  name?: string
  body?: string
  html_url?: string
  assets?: { name: string; size: number; url: string; browser_download_url: string }[]
}

/** 최신 릴리스(tag: build-번호)를 읽어 이 앱보다 새 빌드인지 판단한다 */
export function parseRelease(json: ReleaseJson): UpdateInfo | null {
  const build = Number(/^build-(\d+)$/.exec(json.tag_name ?? '')?.[1])
  const apk = json.assets?.find((a) => a.name.endsWith('.apk'))
  if (!Number.isFinite(build) || !apk) return null
  return {
    build,
    title: json.name ?? `build ${build}`,
    notes: (json.body ?? '').trim(),
    downloadUrl: apk.browser_download_url,
    assetApiUrl: apk.url,
    size: apk.size,
    pageUrl: json.html_url ?? ''
  }
}

export const useUpdate = create<UpdateState>()((set, get) => ({
  status: 'idle',
  info: null,
  error: null,
  progress: null,
  dismissed: false,
  dismiss: () => set({ dismissed: true }),
  check: async (silent = false) => {
    const busy = get().status
    if (busy === 'checking' || busy === 'downloading') return
    const { updateRepo, githubToken } = useSettings.getState()
    const repo = updateRepo.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '')
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      if (!silent) set({ status: 'error', error: '저장소는 "소유자/이름" 형식으로 적어 주세요' })
      return
    }
    if (!silent) set({ status: 'checking', error: null })
    try {
      const res = await githubGet(`https://api.github.com/repos/${repo}/releases/latest`, githubToken || undefined)
      if (res.status === 401) throw new Error('GitHub 토큰이 올바르지 않거나 만료됐습니다')
      if (res.status === 404) {
        throw new Error(
          githubToken
            ? '릴리스를 찾지 못했습니다. 저장소 이름과 토큰의 권한(Contents 읽기)을 확인해 주세요'
            : '릴리스를 찾지 못했습니다. 저장소가 비공개라면 아래에 GitHub 토큰을 넣어 주세요'
        )
      }
      if (res.status === 403 || res.status === 429) throw new Error('GitHub 요청 한도를 넘었습니다. 잠시 뒤 다시 시도해 주세요')
      if (res.status !== 200) throw new Error(`GitHub 응답 오류 (${res.status})`)
      const info = parseRelease(JSON.parse(res.body) as ReleaseJson)
      if (!info) throw new Error('최신 릴리스에 APK가 없습니다')
      set({ info, status: info.build > CURRENT_BUILD ? 'available' : 'latest', error: null })
    } catch (e) {
      // 자동 확인은 조용히 실패한다 (오프라인 등) — 직접 눌렀을 때만 알린다
      if (!silent) set({ status: 'error', error: (e as Error).message })
    }
  },
  install: async () => {
    const { info, status } = get()
    if (!info || status === 'downloading') return
    const token = useSettings.getState().githubToken || undefined
    set({ status: 'downloading', progress: 0, error: null })
    try {
      await installUpdate(
        // 토큰이 있으면(비공개 저장소) API 주소로, 없으면 공개 다운로드 주소로 받는다
        token ? info.assetApiUrl : info.downloadUrl,
        token,
        (received, total) => set({ progress: total > 0 ? received / total : info.size ? received / info.size : null }),
        info.pageUrl || info.downloadUrl
      )
      // 설치 화면이 떴다. 설치를 취소하고 돌아와도 다시 누를 수 있게 둔다
      set({ status: 'available', progress: null })
    } catch (e) {
      set({ status: 'error', progress: null, error: `업데이트 실패: ${(e as Error).message}` })
    }
  }
}))
