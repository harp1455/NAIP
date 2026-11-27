/**
 * 백업 파일 고르기·쓰기·읽기 — Android 는 저장소 접근 프레임워크(SAF) 플러그인 NaipFiles
 * (android/.../NaipFilesPlugin.java), 브라우저는 다운로드 / 파일 선택으로 대신한다.
 *
 * 큰 파일을 JS 쪽에 통째로 들고 있지 않는다:
 * - 쓰기: 조각(기본 1MB)마다 네이티브로 넘겨 문서 스트림에 바로 쓴다. 실패·취소하면 만든 문서를 지운다.
 * - 읽기: ZIP 리더가 필요한 구간만 readChunk 로 읽는다 (탐색이 안 되는 클라우드 문서는 네이티브가
 *   앱 캐시의 임시 파일로 복사해 두고 읽으며, 닫거나 실패하면 지운다).
 * 브라우저 쓰기는 Blob 조각으로 모았다가 내려받기 (개발용 — 브라우저가 디스크로 내릴 수 있다).
 */
import { Capacitor, registerPlugin, type Plugin } from '@capacitor/core'
import { fromBase64, toBase64 } from './bytes'
import { blobSource, type ByteSink, type ByteSource } from './io'

interface NaipFilesPlugin extends Plugin {
  createDocument(opts: { fileName: string; mimeType: string }): Promise<{ cancelled?: boolean; handle?: string; uri?: string; name?: string }>
  appendChunk(opts: { handle: string; data: string }): Promise<{ written: number }>
  closeDocument(opts: { handle: string }): Promise<{ size: number }>
  abortDocument(opts: { handle: string }): Promise<void>
  openDocument(opts: { mimeTypes?: string[] }): Promise<{ cancelled?: boolean; handle?: string; uri?: string; name?: string; size?: number }>
  readChunk(opts: { handle: string; offset: number; length: number }): Promise<{ data: string; bytesRead: number }>
  closeReader(opts: { handle: string }): Promise<void>
}

const NaipFiles = registerPlugin<NaipFilesPlugin>('NaipFiles')

/** 네이티브 한 번에 읽는 최대 크기 (base64 로 다리를 건너므로 너무 크게 잡지 않는다) */
const MAX_READ = 4 * 1024 * 1024

export interface WritableFile extends ByteSink {
  readonly name: string
}

export interface ReadableFile extends ByteSource {
  readonly name: string
  close(): Promise<void>
}

/** 저장할 곳을 고르게 하고 쓰기용 sink 를 돌려준다. 사용자가 취소하면 null */
export async function createFile(fileName: string, mimeType = 'application/octet-stream'): Promise<WritableFile | null> {
  if (Capacitor.isNativePlatform()) {
    const r = await NaipFiles.createDocument({ fileName, mimeType })
    if (r.cancelled || !r.handle) return null
    const handle = r.handle
    let done = false
    return {
      name: r.name ?? fileName,
      async write(chunk) {
        await NaipFiles.appendChunk({ handle, data: toBase64(chunk) })
      },
      async close() {
        done = true
        await NaipFiles.closeDocument({ handle })
      },
      async abort() {
        if (done) return
        done = true
        await NaipFiles.abortDocument({ handle })
      }
    }
  }
  const parts: BlobPart[] = []
  return {
    name: fileName,
    async write(chunk) {
      parts.push(chunk.slice())
    },
    async close() {
      const url = URL.createObjectURL(new Blob(parts, { type: mimeType }))
      parts.length = 0
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    },
    async abort() {
      parts.length = 0
    }
  }
}

/**
 * 파일을 고르게 하고 임의 위치를 읽을 수 있는 입력을 돌려준다. 취소하면 null.
 * accept: 브라우저 파일 선택의 확장자 (예: ['.naipbackup', '.nais', '.json']).
 * Android 의 SAF 는 확장자로 거르지 못해 모든 파일을 보여 준다 (MIME 은 대부분 octet-stream).
 */
export async function pickFile(opts: { accept?: string[]; mimeTypes?: string[] } = {}): Promise<ReadableFile | null> {
  if (Capacitor.isNativePlatform()) {
    const r = await NaipFiles.openDocument({ mimeTypes: opts.mimeTypes ?? ['*/*'] })
    if (r.cancelled || !r.handle) return null
    const handle = r.handle
    return {
      name: r.name ?? '',
      size: r.size ?? 0,
      async read(offset, length) {
        const res = await NaipFiles.readChunk({ handle, offset, length: Math.min(length, MAX_READ) })
        return res.bytesRead ? fromBase64(res.data) : new Uint8Array(0)
      },
      async close() {
        await NaipFiles.closeReader({ handle })
      }
    }
  }
  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (opts.accept?.length) input.accept = opts.accept.join(',')
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
  if (!file) return null
  return { name: file.name, ...blobSource(file), size: file.size, close: async () => {} }
}
