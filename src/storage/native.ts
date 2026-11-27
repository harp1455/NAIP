import { Capacitor, registerPlugin, type Plugin } from '@capacitor/core'
import type { ExecResult, SqlDriver, SqlStatement, SqlValue } from './driver'
import type { FileEntry, FileStore } from './files'

/** android/app/src/main/java/.../NaipStoragePlugin.java 와 짝 */
export interface StorageInfo {
  /** 기기 남은 공간 (앱 데이터가 있는 볼륨) */
  free: number
  total: number
  dbBytes: number
  imagesBytes: number
  thumbsBytes: number
  /** 앱 캐시 폴더 전체 (공유·클립보드 사본, 업데이트 APK, 웹뷰 캐시) */
  cacheBytes: number
}

interface NaipStoragePlugin extends Plugin {
  open(): Promise<{ filesDir: string; dbPath: string }>
  query(opts: { sql: string; params: SqlValue[] }): Promise<{ columns: string[]; rows: SqlValue[][] }>
  exec(opts: { sql: string; params: SqlValue[] }): Promise<{ changes: number }>
  batch(opts: { statements: { sql: string; params: SqlValue[] }[] }): Promise<void>
  writeFile(opts: { path: string; base64: string }): Promise<{ size: number }>
  fileSizes(opts: { paths: string[] }): Promise<{ sizes: number[] }>
  deleteFiles(opts: { paths: string[] }): Promise<void>
  listFiles(opts: { dir: string }): Promise<{ files: FileEntry[] }>
  freeBytes(): Promise<{ free: number }>
  storageInfo(): Promise<StorageInfo>
  clearCache(): Promise<{ freed: number }>
  saveFileToGallery(opts: { path: string; fileName: string; mimeType: string; folder?: string }): Promise<{ uri: string }>
  copyImageFile(opts: { path: string; mimeType: string }): Promise<void>
  prepareShare(opts: { items: { path: string; name: string }[] }): Promise<{ uris: string[] }>
}

export const NaipStorage = registerPlugin<NaipStoragePlugin>('NaipStorage')

let filesDirPromise: Promise<string> | null = null
let filesDir = ''

/** 앱 전용 폴더를 연다 (DB 파일도 이때 열린다) */
export function openNative(): Promise<string> {
  filesDirPromise ??= NaipStorage.open().then((r) => {
    filesDir = r.filesDir.replace(/\/+$/, '')
    return filesDir
  })
  return filesDirPromise
}

/** 상대 경로 → 파일 절대 경로 */
export function absolutePath(path: string): string {
  return `${filesDir}/${path}`
}

export function nativeDriver(): SqlDriver {
  return {
    kind: 'native',
    async exec(sql, params): Promise<ExecResult> {
      return NaipStorage.exec({ sql, params: params ?? [] })
    },
    async query<T>(sql: string, params?: SqlValue[]): Promise<T[]> {
      const { columns, rows } = await NaipStorage.query({ sql, params: params ?? [] })
      return rows.map((row) => {
        const o: Record<string, SqlValue> = {}
        for (let i = 0; i < columns.length; i++) o[columns[i]] = row[i] ?? null
        return o as T
      })
    },
    async batch(statements: SqlStatement[]): Promise<void> {
      if (!statements.length) return
      await NaipStorage.batch({ statements: statements.map((s) => ({ sql: s.sql, params: s.params ?? [] })) })
    }
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve((r.result as string).replace(/^data:[^,]*,/, ''))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

export function nativeFileStore(): FileStore {
  const urlOf = (path: string): string => Capacitor.convertFileSrc(absolutePath(path))
  return {
    kind: 'native',
    async write(path, data) {
      const base64 = typeof data === 'string' ? data.replace(/^data:[^,]*,/, '') : await blobToBase64(data)
      return (await NaipStorage.writeFile({ path, base64 })).size
    },
    async url(path) {
      return urlOf(path)
    },
    urlSync: urlOf,
    async read(path, mime) {
      // 웹뷰의 로컬 서버가 파일을 그대로 내준다 (base64 왕복 없음)
      const res = await fetch(urlOf(path))
      if (!res.ok) return null
      const buf = await res.arrayBuffer()
      return new Blob([buf], { type: mime ?? res.headers.get('content-type') ?? 'application/octet-stream' })
    },
    async sizes(paths) {
      if (!paths.length) return []
      return (await NaipStorage.fileSizes({ paths })).sizes
    },
    async remove(paths) {
      if (paths.length) await NaipStorage.deleteFiles({ paths })
    },
    async list(dir) {
      return (await NaipStorage.listFiles({ dir })).files
    }
  }
}
