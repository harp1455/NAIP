/** 히스토리 저장소 (IndexedDB). meta(썸네일 포함)와 원본 blob을 분리해 목록 로딩을 가볍게 한다. */
export interface HistoryMeta {
  id: number
  ts: number
  thumb: string
  width: number
  height: number
  seed: number
  model: string
  kind: 't2i' | 'i2i' | 'inpaint'
  prompt: string
  negative: string
  mime: string
}

const DB_NAME = 'naip'
let dbp: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      db.createObjectStore('meta', { keyPath: 'id' })
      db.createObjectStore('blobs')
      db.createObjectStore('kv')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbp
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
  const tx = db.transaction(['meta', 'blobs'], 'readwrite')
  tx.objectStore('meta').put(meta)
  tx.objectStore('blobs').put(buffer, meta.id)
  await txDone(tx)
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
  const tx = db.transaction(['meta', 'blobs'], 'readwrite')
  for (const id of ids) {
    tx.objectStore('meta').delete(id)
    tx.objectStore('blobs').delete(id)
  }
  await txDone(tx)
}

export async function clearImages(): Promise<void> {
  const db = await open()
  const tx = db.transaction(['meta', 'blobs'], 'readwrite')
  tx.objectStore('meta').clear()
  tx.objectStore('blobs').clear()
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
