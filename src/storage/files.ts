/**
 * 원본·썸네일 파일 보관소. 휴대폰은 앱 전용 폴더(files/images, files/thumbs)의 진짜 파일,
 * 브라우저·테스트는 IndexedDB·메모리로 흉내 낸다. 경로는 늘 "images/123.png"처럼 상대 경로.
 */
export interface FileEntry {
  name: string
  size: number
}

export interface FileStore {
  readonly kind: 'native' | 'idb' | 'memory'
  /** 쓰고 실제로 기록된 바이트 수를 돌려준다. data가 문자열이면 base64 (data: 머리말은 있어도 된다) */
  write(path: string, data: Blob | string): Promise<number>
  /** 화면에 띄울 주소. 휴대폰은 파일 주소(복사 없음), 브라우저는 object URL */
  url(path: string): Promise<string>
  /** 동기로 만들 수 있으면 주소 (휴대폰), 아니면 null */
  urlSync(path: string): string | null
  read(path: string, mime?: string): Promise<Blob | null>
  /** 파일 크기 (없으면 -1) — 여러 개를 한 번에 */
  sizes(paths: string[]): Promise<number[]>
  remove(paths: string[]): Promise<void>
  list(dir: string): Promise<FileEntry[]>
}

export function base64ToBytes(data: string): Uint8Array {
  const b64 = data.replace(/^data:[^,]*,/, '')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** dataURL의 MIME (없으면 null) */
export function dataUrlMime(data: string): string | null {
  return /^data:([^;,]+)/.exec(data)?.[1] ?? null
}

function mimeOf(path: string): string {
  if (path.endsWith('.webp')) return 'image/webp'
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg'
  if (path.endsWith('.png')) return 'image/png'
  return 'application/octet-stream'
}

async function toBytes(data: Blob | string): Promise<Uint8Array> {
  return typeof data === 'string' ? base64ToBytes(data) : new Uint8Array(await data.arrayBuffer())
}

/** 테스트용 메모리 보관소 */
export function memoryFileStore(): FileStore & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>()
  return {
    kind: 'memory',
    files,
    async write(path, data) {
      const bytes = await toBytes(data)
      files.set(path, bytes)
      return bytes.byteLength
    },
    async url(path) {
      return `memory://${path}`
    },
    urlSync: (path) => `memory://${path}`,
    async read(path, mime) {
      const bytes = files.get(path)
      return bytes ? new Blob([bytes as BlobPart], { type: mime ?? mimeOf(path) }) : null
    },
    async sizes(paths) {
      return paths.map((p) => files.get(p)?.byteLength ?? -1)
    },
    async remove(paths) {
      for (const p of paths) files.delete(p)
    },
    async list(dir) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`
      return [...files.entries()]
        .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(([p, b]) => ({ name: p.slice(prefix.length), size: b.byteLength }))
    }
  }
}

/** 브라우저 개발 빌드: 파일을 IndexedDB(naip-files)에 ArrayBuffer로 보관한다 */
export function idbFileStore(dbName = 'naip-files'): FileStore {
  let dbp: Promise<IDBDatabase> | null = null
  const open = (): Promise<IDBDatabase> =>
    (dbp ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1)
      req.onupgradeneeded = () => req.result.createObjectStore('files')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    }))
  const done = <T>(req: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  const urls = new Map<string, string>()
  const forget = (path: string): void => {
    const u = urls.get(path)
    if (u) URL.revokeObjectURL(u)
    urls.delete(path)
  }
  return {
    kind: 'idb',
    async write(path, data) {
      const bytes = await toBytes(data)
      const db = await open()
      const tx = db.transaction('files', 'readwrite')
      tx.objectStore('files').put(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), path)
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
      forget(path)
      return bytes.byteLength
    },
    async url(path) {
      const hit = urls.get(path)
      if (hit) return hit
      const blob = await this.read(path)
      if (!blob) return ''
      const u = URL.createObjectURL(blob)
      urls.set(path, u)
      return u
    },
    urlSync: (path) => urls.get(path) ?? null,
    async read(path, mime) {
      const db = await open()
      const buf = (await done(db.transaction('files').objectStore('files').get(path))) as ArrayBuffer | undefined
      return buf ? new Blob([buf], { type: mime ?? mimeOf(path) }) : null
    },
    async sizes(paths) {
      const db = await open()
      const store = db.transaction('files').objectStore('files')
      const found = await Promise.all(paths.map((p) => done(store.get(p)) as Promise<ArrayBuffer | undefined>))
      return found.map((b) => (b ? b.byteLength : -1))
    },
    async remove(paths) {
      if (!paths.length) return
      const db = await open()
      const tx = db.transaction('files', 'readwrite')
      for (const p of paths) {
        tx.objectStore('files').delete(p)
        forget(p)
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },
    async list(dir) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`
      const db = await open()
      const store = db.transaction('files').objectStore('files')
      const range = IDBKeyRange.bound(prefix, `${prefix}￿`)
      return new Promise((resolve, reject) => {
        const out: FileEntry[] = []
        const req = store.openCursor(range)
        req.onsuccess = () => {
          const cur = req.result
          if (!cur) return resolve(out)
          const name = (cur.key as string).slice(prefix.length)
          if (!name.includes('/')) out.push({ name, size: (cur.value as ArrayBuffer).byteLength })
          cur.continue()
        }
        req.onerror = () => reject(req.error)
      })
    }
  }
}
