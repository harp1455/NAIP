import type { CastSent, CastSnapshot } from '../nai/cast'

/** 히스토리 저장소 (IndexedDB). meta(썸네일 포함)와 원본 blob을 분리해 목록 로딩을 가볍게 한다. */
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
}

export type HistoryFilter = { fav: true } | { sceneId: number } | { unsaved: true } | { search: string } | null

const DB_NAME = 'naip'
let dbp: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
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

/** 검색 대상 글 — 보낸 프롬프트·네거티브·캐릭터·씬 이름·시드·모델·저장 이름 */
export function searchText(meta: HistoryMeta): string {
  return [
    meta.prompt,
    meta.negative,
    ...(meta.sent?.chars ?? []).flatMap((c) => [c.name, c.prompt]),
    meta.sceneName ?? '',
    String(meta.seed),
    meta.model,
    meta.saved ?? ''
  ]
    .join('\n')
    .toLowerCase()
}

/** 검색어를 쉼표로 나눈 조각들 — 모두 들어 있어야 일치 (예: "blue eyes, beach") */
export function searchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/_/g, ' ')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

export function matchesSearch(text: string, terms: string[]): boolean {
  return terms.length > 0 && terms.every((t) => text.includes(t))
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

export async function addImage(meta: HistoryMeta, blob: Blob): Promise<void> {
  const db = await open()
  // WebView에 따라 IndexedDB의 Blob 저장이 불안정해 ArrayBuffer로 저장한다.
  // 트랜잭션 안에서 await하면 트랜잭션이 닫히므로 버퍼를 먼저 만든다.
  const buffer = await blob.arrayBuffer()
  const tx = db.transaction(['meta', 'blobs', 'text'], 'readwrite')
  tx.objectStore('meta').put(meta)
  tx.objectStore('blobs').put(buffer, meta.id)
  tx.objectStore('text').put(searchText(meta), meta.id)
  await txDone(tx)
}

/** 검색어에 맞는 이미지 id (최신순, 전부) */
export async function searchIds(query: string): Promise<number[]> {
  const terms = searchTerms(query)
  if (!terms.length) return []
  const db = await open()
  const store = db.transaction('text').objectStore('text')
  return new Promise((resolve, reject) => {
    const out: number[] = []
    const req = store.openCursor(null, 'prev')
    req.onsuccess = () => {
      const cur = req.result
      if (!cur) return resolve(out)
      if (matchesSearch(cur.value as string, terms)) out.push(cur.key as number)
      cur.continue()
    }
    req.onerror = () => reject(req.error)
  })
}

/** id 목록의 meta (순서 유지, 지워진 것은 건너뜀) */
export async function getMetas(ids: number[]): Promise<HistoryMeta[]> {
  const db = await open()
  const store = db.transaction('meta').objectStore('meta')
  const found = await Promise.all(ids.map((id) => done(store.get(id)) as Promise<HistoryMeta | undefined>))
  return found.filter((m): m is HistoryMeta => !!m)
}

export async function listMeta(limit: number, beforeId?: number): Promise<HistoryMeta[]> {
  const db = await open()
  const store = db.transaction('meta').objectStore('meta')
  const range = beforeId === undefined ? undefined : IDBKeyRange.upperBound(beforeId, true)
  return new Promise((resolve, reject) => {
    const out: HistoryMeta[] = []
    const req = store.openCursor(range, 'prev')
    req.onsuccess = () => {
      const cur = req.result
      if (!cur || out.length >= limit) return resolve(out)
      out.push(cur.value as HistoryMeta)
      cur.continue()
    }
    req.onerror = () => reject(req.error)
  })
}

/** 필터에 맞는 전체 목록 (최신순). 즐겨찾기·씬 단위라 한 번에 읽는다 */
export async function listFiltered(
  filter: { fav: true } | { sceneId: number }
): Promise<HistoryMeta[]> {
  const db = await open()
  const store = db.transaction('meta').objectStore('meta')
  const req =
    'fav' in filter
      ? store.index('fav').getAll(IDBKeyRange.only(1))
      : store.index('scene').getAll(IDBKeyRange.only(filter.sceneId))
  return ((await done(req)) as HistoryMeta[]).sort((a, b) => b.id - a.id)
}

export async function getMeta(id: number): Promise<HistoryMeta | null> {
  const db = await open()
  return ((await done(db.transaction('meta').objectStore('meta').get(id))) as HistoryMeta | undefined) ?? null
}

/** 아직 저장하지 않은 이미지 (최신순, limit장씩). beforeId를 주면 그보다 오래된 것부터 */
export async function listUnsaved(limit: number, beforeId?: number): Promise<HistoryMeta[]> {
  const db = await open()
  const index = db.transaction('meta').objectStore('meta').index('unsaved')
  const range = IDBKeyRange.bound([1, 0], [1, beforeId ?? Number.MAX_SAFE_INTEGER], false, beforeId !== undefined)
  return new Promise((resolve, reject) => {
    const out: HistoryMeta[] = []
    const req = index.openCursor(range, 'prev')
    req.onsuccess = () => {
      const cur = req.result
      if (!cur || out.length >= limit) return resolve(out)
      out.push(cur.value as HistoryMeta)
      cur.continue()
    }
    req.onerror = () => reject(req.error)
  })
}

export async function putMeta(meta: HistoryMeta): Promise<void> {
  const db = await open()
  const tx = db.transaction(['meta', 'text'], 'readwrite')
  tx.objectStore('meta').put(meta)
  tx.objectStore('text').put(searchText(meta), meta.id)
  await txDone(tx)
}

/** 보관 한도 정리용: 즐겨찾기를 뺀 가장 오래된 n장의 id */
export async function oldestIds(n: number): Promise<number[]> {
  const db = await open()
  const store = db.transaction('meta').objectStore('meta')
  return new Promise((resolve, reject) => {
    const out: number[] = []
    const req = store.openCursor()
    req.onsuccess = () => {
      const cur = req.result
      if (!cur || out.length >= n) return resolve(out)
      if (!(cur.value as HistoryMeta).fav) out.push(cur.value.id as number)
      cur.continue()
    }
    req.onerror = () => reject(req.error)
  })
}

export async function countImages(): Promise<number> {
  const db = await open()
  return done(db.transaction('meta').objectStore('meta').count())
}

export async function getBlob(id: number, mime = 'image/png'): Promise<Blob | null> {
  const db = await open()
  const buf = (await done(db.transaction('blobs').objectStore('blobs').get(id))) as
    | ArrayBuffer
    | undefined
  return buf ? new Blob([buf], { type: mime }) : null
}

export async function deleteImages(ids: number[]): Promise<void> {
  const db = await open()
  const tx = db.transaction(['meta', 'blobs', 'text'], 'readwrite')
  for (const id of ids) {
    tx.objectStore('meta').delete(id)
    tx.objectStore('blobs').delete(id)
    tx.objectStore('text').delete(id)
  }
  await txDone(tx)
}

export async function clearImages(): Promise<void> {
  const db = await open()
  const tx = db.transaction(['meta', 'blobs', 'text'], 'readwrite')
  tx.objectStore('meta').clear()
  tx.objectStore('blobs').clear()
  tx.objectStore('text').clear()
  await txDone(tx)
}

/** zustand persist용 KV (레퍼런스 이미지처럼 localStorage 한도를 넘는 상태) */
export const idbStorage = {
  async getItem(name: string): Promise<string | null> {
    const db = await open()
    return ((await done(db.transaction('kv').objectStore('kv').get(name))) as string) ?? null
  },
  async setItem(name: string, value: string): Promise<void> {
    const db = await open()
    const tx = db.transaction('kv', 'readwrite')
    tx.objectStore('kv').put(value, name)
    await txDone(tx)
  },
  async removeItem(name: string): Promise<void> {
    const db = await open()
    const tx = db.transaction('kv', 'readwrite')
    tx.objectStore('kv').delete(name)
    await txDone(tx)
  }
}

/**
 * zustand persist용 저장소 — 레퍼런스처럼 큰 그림(base64)을 품은 상태를 위해 쓰기를 모아서 한다.
 * 슬라이더를 끄는 동안 바뀔 때마다 수 MB를 직렬화·저장하면 화면이 끊기므로, 마지막 변경 후
 * 잠깐 조용해지면 한 번만 쓴다. 앱이 뒤로 가면 바로 쓴다.
 */
export function debouncedIdbStorage<S>(delayMs = 400): {
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
