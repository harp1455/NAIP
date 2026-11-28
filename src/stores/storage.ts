import { create } from 'zustand'
import { setKeepAwake } from '../lib/native'
import { freeSpace, getStorage } from '../storage'
import { idbLegacySource, migrateLegacy, type MigrationProgress, type MigrationResult } from '../storage/legacy'
import { useHistory } from './history'
import { loadResume, type ResumeEntry } from './queue-persist'
import { toast } from './toast'

type Phase = 'starting' | 'migrating' | 'nospace' | 'failed' | 'error' | 'ready'

interface StorageBootState {
  phase: Phase
  progress: MigrationProgress | null
  /** 옮기지 못한 이유 (공간 부족·실패) */
  result: MigrationResult | null
  error: string | null
  /** 아직 옮기지 않은 예전 히스토리 장수 ("나중에"를 고른 경우) */
  legacyLeft: number
  /** 지난 실행에서 끝나지 않은 생성 — 이어서 할지 묻는다 */
  resume: ResumeEntry[] | null
  /** 앱을 열 때 한 번: 저장소를 열고, 예전 히스토리가 있으면 옮기고, 히스토리·대기열을 불러온다 */
  boot: () => Promise<void>
  /** 예전 히스토리 옮기기 (다시 시도). skipUnreadable = 사용자가 두고 가기로 확인한 읽을 수 없는 장 */
  migrate: (opts?: { skipUnreadable?: readonly number[] }) => Promise<void>
  /**
   * 실패 이유가 읽을 수 없는 장뿐일 때(result.unreadable), 사용자가 확인한 뒤에만 부른다:
   * 그 장은 두고, 읽히는 장을 다시 검증해 맞으면 예전 히스토리를 비운다. 맞지 않으면 그대로 둔다
   */
  finishSkipping: () => Promise<void>
  /** 옮기기를 미루고 앱을 쓴다 (예전 데이터는 그대로 남는다) */
  later: () => void
  closeResume: () => void
}

let booted = false

export const useStorageBoot = create<StorageBootState>()((set, get) => ({
  phase: 'starting',
  progress: null,
  result: null,
  error: null,
  legacyLeft: 0,
  resume: null,
  boot: async () => {
    if (booted) return
    booted = true
    try {
      await getStorage()
    } catch (e) {
      set({ phase: 'error', error: (e as Error).message })
      booted = false
      return
    }
    const legacy = await idbLegacySource()
      .count()
      .catch(() => 0)
    if (legacy > 0) await get().migrate()
    else set({ phase: 'ready' })
    await useHistory.getState().init()
    // 끝나지 않은 대기열은 옮기기 화면이 닫힌 뒤에 묻는다
    const entries = await loadResume().catch((e: unknown) => {
      console.warn('대기열을 읽지 못했습니다', e)
      return []
    })
    if (entries.length) set({ resume: entries })
  },
  migrate: async (opts) => {
    set({ phase: 'migrating', progress: null, result: null, error: null })
    setKeepAwake(true)
    let last = 0
    try {
      const storage = await getStorage()
      const result = await migrateLegacy({
        storage,
        source: idbLegacySource(),
        freeSpace: () => freeSpace(true),
        skipUnreadable: opts?.skipUnreadable,
        onProgress: (progress) => {
          // 너무 자주 그리지 않는다
          const now = performance.now()
          if (now - last > 120 || progress.phase !== 'copy' || progress.done === progress.total) {
            last = now
            set({ progress })
          }
        }
      })
      if (result.status === 'done' || result.status === 'none') {
        set({ phase: 'ready', result, legacyLeft: 0 })
        if (result.status === 'done') {
          toast(
            `이전 히스토리 ${result.count.toLocaleString()}장을 새 저장소로 옮겼습니다` +
              (result.skipped ? ` · 읽을 수 없는 ${result.skipped.toLocaleString()}장은 건너뛰었습니다` : '')
          )
          await useHistory.getState().init()
        }
      } else {
        set({ phase: result.status, result, legacyLeft: result.total - result.done })
        // 옮긴 만큼은 바로 보이게
        await useHistory.getState().init()
      }
    } catch (e) {
      set({ phase: 'failed', error: (e as Error).message })
    } finally {
      setKeepAwake(false)
    }
  },
  finishSkipping: async () => {
    const r = get().result
    // 확인한 장만 넘긴다 — 다른 이유의 실패에서는 아무것도 하지 않는다
    if (r?.status !== 'failed' || !r.unreadable?.length) return
    await get().migrate({ skipUnreadable: r.unreadable })
  },
  later: () => {
    const r = get().result
    const left = r && (r.status === 'nospace' || r.status === 'failed') ? r.total - r.done : get().legacyLeft
    set({ phase: 'ready', legacyLeft: Math.max(left, 1) })
  },
  closeResume: () => set({ resume: null })
}))
