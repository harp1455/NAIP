/** 히스토리 자료형과 IndexedDB kv. 히스토리 자체는 src/storage (SQLite + 파일)에 있다. */
import type { CastSent, CastSnapshot } from '../nai/cast'
import { getStorage } from '../storage'
import { matchesSearch, searchTerms, searchText, type HistoryRepo } from '../storage/history-repo'
import type { ProjectImageTag } from '../project/types' // ── Phase 5

/** 생성 당시의 설정 원본(조각 치환 전) — "설정 적용"으로 그대로 되돌리기 위해 보관 */
export interface SettingsSnapshot {
  base: string
  additional: string
  detail: string
  negative: string
  params: Record<string, unknown>
  chars: { name: string; prompt: string; negative: string; center?: { x: number; y: number } }[]
  /** 출연 슬롯·변형 뽑기 원본(슬롯 설정 + 캐릭터 원문, 조각 치환 전) — "재추첨 생성"이 다시 뽑는 데 쓴다 */
  cast?: CastSnapshot
}

export type ImageKind = 't2i' | 'i2i' | 'inpaint' | 'director' | 'upscale'

export interface HistoryMeta {
  id: number
  ts: number
  /** 화면에 띄울 썸네일 주소 (파일 주소·object URL, 방금 만든 것은 data: URL). 비어 있으면 화면이 다시 만든다 */
  thumb: string
  width: number
  height: number
  seed: number
  model: string
  kind: ImageKind
  prompt: string
  negative: string
  mime: string
  /** 씬 생성이면 씬 id·이름 */
  sceneId?: number
  sceneName?: string
  /** 즐겨찾기 (IndexedDB 인덱스용으로 1 또는 없음) */
  fav?: 1
  snap?: SettingsSnapshot
  /** 실제로 보낸 내용(조각 치환 후, 퀄리티 태그·UC 프리셋 병합 전) — "다시 생성"이 똑같이 되풀이하는 데 쓴다 */
  sent?: {
    prompt: string
    negative: string
    chars: { name: string; prompt: string; negative: string; center?: { x: number; y: number } }[]
    /** 슬롯·변형 뽑기 결과 (chars와 같은 순서) — 고른 변형 이름, 한도로 뺀 캐릭터, 고친 인원 태그 */
    cast?: CastSent
  }
  /** 갤러리에 저장했으면 Pictures/NAIP 아래의 경로 (마지막으로 저장한 것) */
  saved?: string
  /** i2i·인페인트 결과면 원본으로 쓴 히스토리 이미지 id (편집 계보) */
  parentId?: number
  /** 아직 갤러리에 저장하지 않았으면 1 ("미저장만 보기" 인덱스용 — 저장하면 지운다) */
  unsaved?: 1
  /** 이 그림을 만든 생성 요청의 id (앱이 죽은 뒤 대기열을 되살릴 때 이미 받은 결과인지 확인) */
  requestId?: string
  /** ── Phase 5: 에셋 프로젝트 분류 표시 (프로젝트 id·조합 키·좌표) */
  project?: ProjectImageTag
}

export type HistoryFilter = { fav: true } | { sceneId: number } | { unsaved: true } | { search: string } | null

const DB_NAME = 'naip'
let dbp: Promise<IDBDatabase> | null = null

/**
 * IndexedDB 'naip' (v4). 지금은 kv(레퍼런스·마스크 등 zustand 상태)만 쓰고,
 * meta·blobs·text는 예전 히스토리 — SQLite로 옮긴 뒤 비운다 (지우지는 않는다: 버전을 올리지 않으려고)
 */
export function openIdb(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 4)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'id' })
        db.createObjectStore('blobs')
        db.createObjectStore('kv')
      }
      // v2: 즐겨찾기·씬 필터용 인덱스 (값이 없는 레코드는 인덱스에 들어가지 않는다)
      const meta = req.transaction!.objectStore('meta')
      if (!meta.indexNames.contains('fav')) meta.createIndex('fav', 'fav')
      if (!meta.indexNames.contains('scene')) meta.createIndex('scene', 'sceneId')
      // v3: 미저장 필터용 인덱스. [unsaved, id] 복합 키라 최신순으로 끊어 읽을 수 있다.
      // 이전 버전에서 만든 이미지에는 표시가 없으므로 저장 기록이 없는 것에 한 번 채워 넣는다
      if (!meta.indexNames.contains('unsaved')) {
        meta.createIndex('unsaved', ['unsaved', 'id'])
        const cursor = meta.openCursor()
        cursor.onsuccess = () => {
          const cur = cursor.result
          if (!cur) return
          const value = cur.value as HistoryMeta
          if (!value.saved && !value.unsaved) cur.update({ ...value, unsaved: 1 })
          cur.continue()
        }
      }
      // v4: 히스토리 검색용 글자 색인 (이미지마다 짧은 소문자 글 한 줄 — 썸네일이 든 meta를 훑지 않으려고 따로 둔다)
      if (!db.objectStoreNames.contains('text')) {
        const text = db.createObjectStore('text')
        const cursor = meta.openCursor()
        cursor.onsuccess = () => {
          const cur = cursor.result
          if (!cur) return
          const value = cur.value as HistoryMeta
          text.put(searchText(value), value.id)
          cur.continue()
        }
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbp
}

export { matchesSearch, searchTerms, searchText }

export function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

/**
 * 예전 히스토리 함수들 — 이제는 SQLite + 파일 저장소(src/storage)로 넘겨준다.
 * 이름과 모양을 그대로 둬서 이 파일을 쓰던 코드가 바뀌지 않아도 된다.
 * (옛 IndexedDB의 meta·blobs·text는 src/storage/legacy-idb.ts가 처음 실행 때 옮기고 비운다)
 */
async function repo(): Promise<HistoryRepo> {
  return (await getStorage()).history
}

export async function addImage(meta: HistoryMeta, blob: Blob): Promise<void> {
  await (await repo()).add(meta, blob)
}

/** 검색어에 맞는 이미지 id (최신순, 전부) */
export async function searchIds(query: string): Promise<number[]> {
  return (await repo()).ids({ search: query })
}

/** id 목록의 meta (순서 유지, 지워진 것은 건너뜀) */
export async function getMetas(ids: number[]): Promise<HistoryMeta[]> {
  return (await repo()).getMany(ids)
}

export async function listMeta(limit: number, beforeId?: number): Promise<HistoryMeta[]> {
  return (await repo()).list({}, limit, beforeId)
}

/** 필터에 맞는 전체 목록 (최신순) */
export async function listFiltered(filter: { fav: true } | { sceneId: number }): Promise<HistoryMeta[]> {
  return (await repo()).list('fav' in filter ? { fav: true } : { sceneId: filter.sceneId }, Number.MAX_SAFE_INTEGER)
}

export async function getMeta(id: number): Promise<HistoryMeta | null> {
  return (await repo()).get(id)
}

/** 아직 저장하지 않은 이미지 (최신순, limit장씩). beforeId를 주면 그보다 오래된 것부터 */
export async function listUnsaved(limit: number, beforeId?: number): Promise<HistoryMeta[]> {
  return (await repo()).list({ unsaved: true }, limit, beforeId)
}

export async function putMeta(meta: HistoryMeta): Promise<void> {
  await (await repo()).put(meta)
}

/** 보관 한도 정리용: 즐겨찾기를 뺀 가장 오래된 n장의 id */
export async function oldestIds(n: number): Promise<number[]> {
  return (await repo()).oldestIds(n)
}

export async function countImages(): Promise<number> {
  return (await repo()).count({})
}

/** 원본 이미지 (휴대폰은 파일을 웹뷰 주소로 읽는다 — base64 왕복 없음) */
export async function getBlob(id: number, mime = 'image/png'): Promise<Blob | null> {
  return (await repo()).readOriginal(id, mime)
}

export async function deleteImages(ids: number[]): Promise<void> {
  await (await repo()).remove(ids)
}

export async function clearImages(): Promise<void> {
  await (await repo()).clear()
}

/** zustand persist용 KV (레퍼런스 이미지처럼 localStorage 한도를 넘는 상태) */
export const idbStorage = {
  async getItem(name: string): Promise<string | null> {
    const db = await openIdb()
    return ((await done(db.transaction('kv').objectStore('kv').get(name))) as string) ?? null
  },
  async setItem(name: string, value: string): Promise<void> {
    const db = await openIdb()
    const tx = db.transaction('kv', 'readwrite')
    tx.objectStore('kv').put(value, name)
    await txDone(tx)
  },
  async removeItem(name: string): Promise<void> {
    const db = await openIdb()
    const tx = db.transaction('kv', 'readwrite')
    tx.objectStore('kv').delete(name)
    await txDone(tx)
  }
}

/**
 * zustand persist용 저장소 — 레퍼런스처럼 큰 그림(base64)을 품은 상태를 위해 쓰기를 모아서 한다.
 * 슬라이더를 끄는 동안 바뀔 때마다 수 MB를 직렬화·저장하면 화면이 끊기므로, 마지막 변경 후
 * 잠깐 조용해지면 한 번만 쓴다. 앱이 뒤로 가면 바로 쓴다.
 *
 * canWrite 가 false 인 동안의 쓰기는 버린다 — 저장된 것을 아직(또는 끝내) 불러오지 못한 스토어가
 * 빈 목록을 저장해 사용자 데이터를 덮어쓰지 않게 한다 (zustand persist 는 setState 마다 저장한다).
 */
export function debouncedIdbStorage<S>(delayMs = 400, opts: { canWrite?: () => boolean } = {}): {
  getItem: (name: string) => Promise<{ state: S; version?: number } | null>
  setItem: (name: string, value: { state: S; version?: number }) => void
  removeItem: (name: string) => Promise<void>
} {
  const pending = new Map<string, { state: S; version?: number }>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = (): void => {
    clearTimeout(timer)
    for (const [name, value] of pending) void idbStorage.setItem(name, JSON.stringify(value))
    pending.clear()
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush()
    })
  }
  return {
    getItem: async (name) => {
      const pendingValue = pending.get(name)
      if (pendingValue) return pendingValue
      const raw = await idbStorage.getItem(name)
      return raw ? (JSON.parse(raw) as { state: S; version?: number }) : null
    },
    setItem: (name, value) => {
      if (opts.canWrite && !opts.canWrite()) return
      pending.set(name, value)
      clearTimeout(timer)
      timer = setTimeout(flush, delayMs)
    },
    removeItem: async (name) => {
      pending.delete(name)
      await idbStorage.removeItem(name)
    }
  }
}
