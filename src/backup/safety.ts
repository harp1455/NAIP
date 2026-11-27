/**
 * 복원 전 자동 백업 — 복원을 시작하기 전에 지금 상태의 가벼운 백업(.naipbackup)을 앱 전용 폴더에 남겨,
 * 복원 결과가 마음에 들지 않으면 그대로 되돌릴 수 있게 한다 (히스토리는 담지 않는다 — 양이 많아서).
 *
 * 큰 파일을 한 번에 네이티브 다리(base64)로 넘기지 않도록 4MB 조각 파일로 나눠 쓰고, 읽을 때도 필요한 조각만 읽는다:
 *   backups/<이름>.naipbackup.p000, .p001 …   조각 (마지막 조각만 4MB 보다 작다)
 *   backups/<이름>.json                       { name, createdAt, size, parts, note } — 다 쓴 뒤 마지막에 쓴다.
 *                                             이것이 있어야 완성된 백업이다 (쓰다가 꺼지면 조각만 남고, 정리에서 지운다)
 */
import { concatBytes, fromUtf8 } from './bytes'
import type { ByteSink, ByteSource } from './io'
import type { FileStore } from '../storage/files'

export const SAFETY_DIR = 'backups'
export const SAFETY_PART = 4 << 20
/** 남겨 두는 자동 백업 수 (오래된 것부터 지운다) */
export const SAFETY_KEEP = 3

export interface SafetyBackup {
  name: string
  createdAt: string
  size: number
  parts: number
  /** 조각 크기 (마지막 조각만 이보다 작다) */
  partSize: number
  /** 무엇 전에 만들었는지 (예: "백업 파일 복원 전") */
  note?: string
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** before-restore-20261127-193005 */
export function safetyName(date = new Date()): string {
  return `before-restore-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

const partPath = (name: string, i: number): string => `${SAFETY_DIR}/${name}.naipbackup.p${String(i).padStart(3, '0')}`
const indexPath = (name: string): string => `${SAFETY_DIR}/${name}.json`

/** 조각 파일로 쓰는 출력. close 하면 목록(json)을 남기고, abort 하면 쓴 조각을 지운다 */
export function safetySink(
  files: FileStore,
  name: string,
  note?: string,
  partSize = SAFETY_PART
): ByteSink & { readonly info: SafetyBackup | null } {
  let pending: Uint8Array[] = []
  let pendingSize = 0
  let parts = 0
  let size = 0
  let info: SafetyBackup | null = null
  const writePart = async (bytes: Uint8Array): Promise<void> => {
    const path = partPath(name, parts)
    const written = await files.write(path, new Blob([bytes as BlobPart], { type: 'application/octet-stream' }))
    if (written !== bytes.byteLength) throw new Error(`자동 백업 조각을 다 쓰지 못했습니다 (${written}/${bytes.byteLength})`)
    parts++
    size += bytes.byteLength
  }
  return {
    get info() {
      return info
    },
    async write(chunk) {
      if (!chunk.byteLength) return
      pending.push(chunk.slice())
      pendingSize += chunk.byteLength
      while (pendingSize >= partSize) {
        const all = concatBytes(pending, pendingSize)
        await writePart(all.subarray(0, partSize))
        const rest = all.slice(partSize)
        pending = rest.byteLength ? [rest] : []
        pendingSize = rest.byteLength
      }
    },
    async close() {
      if (pendingSize || !parts) await writePart(concatBytes(pending, pendingSize))
      pending = []
      pendingSize = 0
      const meta: SafetyBackup = { name, createdAt: new Date().toISOString(), size, parts, partSize, ...(note ? { note } : {}) }
      await files.write(indexPath(name), new Blob([JSON.stringify(meta)], { type: 'application/json' }))
      info = meta
    },
    async abort() {
      pending = []
      pendingSize = 0
      await files.remove(Array.from({ length: parts }, (_, i) => partPath(name, i))).catch(() => {})
    }
  }
}

/** 완성된 자동 백업 목록 (최신순). 조각이 빠진 것은 빼고 보여 주지 않는다 */
export async function listSafetyBackups(files: FileStore): Promise<SafetyBackup[]> {
  const entries = await files.list(SAFETY_DIR).catch(() => [])
  const names = new Set(entries.map((e) => e.name))
  const out: SafetyBackup[] = []
  for (const e of entries) {
    if (!e.name.endsWith('.json')) continue
    try {
      const blob = await files.read(`${SAFETY_DIR}/${e.name}`, 'application/json')
      if (!blob) continue
      const meta = JSON.parse(fromUtf8(new Uint8Array(await blob.arrayBuffer()))) as SafetyBackup
      if (typeof meta.name !== 'string' || `${meta.name}.json` !== e.name || typeof meta.size !== 'number' || typeof meta.parts !== 'number') continue
      if (typeof meta.partSize !== 'number' || meta.partSize <= 0) meta.partSize = SAFETY_PART
      let complete = true
      for (let i = 0; i < meta.parts; i++) if (!names.has(partPath(meta.name, i).slice(SAFETY_DIR.length + 1))) complete = false
      if (complete) out.push(meta)
    } catch {
      /* 읽을 수 없는 목록은 건너뛴다 */
    }
  }
  // 같은 시각이면 이름(만든 시각이 들어 있다) 순으로
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name))
}

/** 자동 백업을 임의 위치로 읽는 입력 (필요한 조각만, 마지막으로 읽은 조각 하나를 기억) */
export function safetySource(files: FileStore, b: SafetyBackup): ByteSource {
  let cache: { index: number; bytes: Uint8Array } | null = null
  const part = async (index: number): Promise<Uint8Array> => {
    if (cache?.index === index) return cache.bytes
    const blob = await files.read(partPath(b.name, index))
    if (!blob) throw new Error(`자동 백업 조각이 없습니다 (${index + 1}/${b.parts})`)
    cache = { index, bytes: new Uint8Array(await blob.arrayBuffer()) }
    return cache.bytes
  }
  return {
    size: b.size,
    async read(offset, length) {
      const end = Math.min(b.size, offset + length)
      const out: Uint8Array[] = []
      for (let at = offset; at < end; ) {
        const index = Math.floor(at / b.partSize)
        const bytes = await part(index)
        const from = at - index * b.partSize
        const take = Math.min(bytes.byteLength - from, end - at)
        if (take <= 0) break
        out.push(bytes.subarray(from, from + take))
        at += take
      }
      return out.length === 1 ? out[0] : concatBytes(out)
    }
  }
}

export async function removeSafetyBackup(files: FileStore, b: Pick<SafetyBackup, 'name' | 'parts'>): Promise<void> {
  // 목록을 먼저 지운다 — 도중에 멈춰도 "완성된 백업"으로 보이지 않게
  await files.remove([indexPath(b.name)])
  await files.remove(Array.from({ length: b.parts }, (_, i) => partPath(b.name, i)))
}

/** 오래된 자동 백업과, 쓰다 만(목록 없는) 조각을 지운다. keep 개는 남긴다 */
export async function pruneSafetyBackups(files: FileStore, keep = SAFETY_KEEP): Promise<number> {
  const list = await listSafetyBackups(files)
  let removed = 0
  for (const b of list.slice(keep)) {
    await removeSafetyBackup(files, b)
    removed++
  }
  const kept = new Set(list.slice(0, keep).map((b) => b.name))
  const leftovers = (await files.list(SAFETY_DIR).catch(() => []))
    .map((e) => e.name)
    .filter((n) => {
      const m = /^(.+)\.(?:naipbackup\.p\d{3}|json)$/.exec(n)
      return !m || !kept.has(m[1])
    })
    .map((n) => `${SAFETY_DIR}/${n}`)
  if (leftovers.length) await files.remove(leftovers).catch(() => {})
  return removed
}
