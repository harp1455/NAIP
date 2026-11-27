import { Capacitor } from '@capacitor/core'
import type { SqlDriver } from './driver'
import { idbFileStore, type FileStore } from './files'
import { createHistoryRepo, type HistoryRepo } from './history-repo'
import { NaipStorage, nativeDriver, nativeFileStore, openNative, type StorageInfo } from './native'
import { createQueueRepo, type QueueRepo } from './queue-repo'
import { migrate } from './schema'

/**
 * 히스토리 저장소 — 휴대폰은 네이티브 SQLite + 앱 전용 폴더의 파일, 브라우저는 sql.js + IndexedDB.
 * 처음 부를 때 DB를 열고 스키마를 맞춘다. 모든 저장소 함수는 이것을 기다리므로 부르는 순서를 신경 쓰지 않아도 된다.
 */
export interface Storage {
  driver: SqlDriver
  files: FileStore
  history: HistoryRepo
  queue: QueueRepo
}

const native = Capacitor.isNativePlatform()
let current: Promise<Storage> | null = null

async function open(): Promise<Storage> {
  let driver: SqlDriver
  let files: FileStore
  if (native) {
    await openNative()
    driver = nativeDriver()
    files = nativeFileStore()
  } else {
    const [{ createSqlJsDriver, idbPersistence }, wasm] = await Promise.all([
      import('./sqljs'),
      import('sql.js/dist/sql-wasm-browser.wasm?url')
    ])
    driver = await createSqlJsDriver({ persistence: idbPersistence(), locateFile: () => wasm.default })
    files = idbFileStore()
  }
  await migrate(driver)
  const storage = { driver, files, history: createHistoryRepo(driver, files), queue: createQueueRepo(driver, files) }
  // 브라우저 개발용 측정 도구 (주소에 ?naipdev) — 휴대폰 빌드에서는 불리지 않는다
  if (!native && typeof location !== 'undefined' && /[?&]naipdev\b/.test(location.search)) {
    void import('./dev').then((m) => m.installDevHooks(storage))
  }
  return storage
}

export function getStorage(): Promise<Storage> {
  current ??= open().catch((e: unknown) => {
    // 다음 호출에서 다시 열어 볼 수 있게
    current = null
    throw e
  })
  return current
}

/** 테스트: 미리 만든 저장소를 쓴다 */
export async function setStorageForTests(driver: SqlDriver, files: FileStore): Promise<Storage> {
  await migrate(driver)
  const s = { driver, files, history: createHistoryRepo(driver, files), queue: createQueueRepo(driver, files) }
  current = Promise.resolve(s)
  return s
}

export const isNativeStorage = native

/** 기기 남은 공간과 앱이 쓰는 공간. 브라우저는 StorageManager 추정치 */
export async function storageInfo(): Promise<StorageInfo> {
  if (native) {
    await getStorage()
    return NaipStorage.storageInfo()
  }
  const s = await getStorage()
  const est = await navigator.storage?.estimate?.().catch(() => undefined)
  const [img] = await s.driver.query<{ n: number }>('SELECT COALESCE(SUM(bytes), 0) AS n FROM images')
  const thumbs = await s.files.list('thumbs')
  return {
    free: est?.quota !== undefined && est.usage !== undefined ? est.quota - est.usage : Number.MAX_SAFE_INTEGER,
    total: est?.quota ?? 0,
    dbBytes: 0,
    imagesBytes: Number(img?.n ?? 0),
    thumbsBytes: thumbs.reduce((a, f) => a + f.size, 0),
    cacheBytes: 0
  }
}

let freeCache: { at: number; free: number } | null = null

/** 기기 남은 공간 (20초 동안 다시 묻지 않는다). 알 수 없으면 null */
export async function freeSpace(fresh = false): Promise<number | null> {
  if (!fresh && freeCache && Date.now() - freeCache.at < 20000) return freeCache.free
  try {
    if (native) {
      await getStorage()
      freeCache = { at: Date.now(), free: (await NaipStorage.freeBytes()).free }
    } else {
      const est = await navigator.storage?.estimate?.()
      if (est?.quota === undefined || est.usage === undefined) return null
      freeCache = { at: Date.now(), free: est.quota - est.usage }
    }
    return freeCache.free
  } catch {
    return null
  }
}

/** 앱 캐시(공유·클립보드 사본, 받은 업데이트, 웹뷰 캐시)를 비운다. 원본·썸네일은 건드리지 않는다 */
export async function clearCache(): Promise<number> {
  if (!native) return 0
  return (await NaipStorage.clearCache()).freed
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(n >= 100 * 1024 ** 2 ? 0 : 1)}MB`
  return `${Math.max(0, Math.round(n / 1024))}KB`
}

/** 한 장을 만들면 쓰는 대략의 공간 (원본 PNG + 썸네일 + 여유) */
export const BYTES_PER_IMAGE = 2.5 * 1024 * 1024
/** 이보다 적게 남으면 생성 전에 묻는다 */
export const LOW_SPACE_BYTES = 300 * 1024 * 1024

/** 생성 전 공간 확인 — 부족할 것 같으면 경고 문구, 괜찮거나 알 수 없으면 null */
export async function lowSpaceWarning(count: number): Promise<string | null> {
  const free = await freeSpace()
  if (free === null) return null
  const need = count * BYTES_PER_IMAGE
  if (free >= need + LOW_SPACE_BYTES) return null
  return free < need
    ? `저장 공간이 ${formatBytes(free)}밖에 남지 않았습니다. ${count}장(약 ${formatBytes(need)})을 저장하기에 모자랄 수 있습니다. 그래도 시작할까요?`
    : `저장 공간이 ${formatBytes(free)} 남았습니다. 생성을 마치면 공간이 거의 없게 됩니다. 그래도 시작할까요?`
}
