import { done, openIdb, txDone, type HistoryMeta } from '../lib/db'
import { chunk, marks } from './driver'
import { dataUrlMime } from './files'
import { insertStatements, originalPath, thumbPathFor } from './history-repo'
import type { Storage } from './index'

/**
 * 예전 히스토리(IndexedDB의 meta·blobs·text)를 SQLite + 파일로 옮긴다.
 *
 * 안전 규칙:
 * - 옛 데이터는 모든 장을 옮기고 검증(장수 + 장마다 파일 크기)이 끝난 뒤에만 비운다.
 * - id로 이어서 한다 — 이미 옮겨진 장(행이 있고 파일 크기가 맞음)은 건너뛰므로 중간에 앱이 죽어도 다시 시작하면 된다.
 * - 파일을 먼저 쓰고(임시 파일 → 이름 바꾸기) 크기를 확인한 뒤에 행을 넣는다. 행만 있고 파일이 없는 상태는 생기지 않는다.
 * - 시작 전에 남은 공간을 확인하고, 옮기는 중에도 공간이 떨어지면 멈춘다 (옛 데이터는 그대로).
 */
export interface LegacySource {
  count(): Promise<number>
  /** 오름차순 */
  ids(): Promise<number[]>
  /** afterId보다 큰 id부터 limit개 (오름차순) */
  metas(afterId: number | null, limit: number): Promise<HistoryMeta[]>
  blob(id: number): Promise<ArrayBuffer | null>
  clear(): Promise<void>
}

export function idbLegacySource(): LegacySource {
  return {
    async count() {
      const db = await openIdb()
      return done(db.transaction('meta').objectStore('meta').count())
    },
    async ids() {
      const db = await openIdb()
      return ((await done(db.transaction('meta').objectStore('meta').getAllKeys())) as number[]).sort((a, b) => a - b)
    },
    async metas(afterId, limit) {
      const db = await openIdb()
      const range = afterId === null ? undefined : IDBKeyRange.lowerBound(afterId, true)
      return (await done(db.transaction('meta').objectStore('meta').getAll(range, limit))) as HistoryMeta[]
    },
    async blob(id) {
      const db = await openIdb()
      const v = (await done(db.transaction('blobs').objectStore('blobs').get(id))) as ArrayBuffer | Blob | undefined
      if (!v) return null
      return v instanceof Blob ? v.arrayBuffer() : v
    },
    async clear() {
      const db = await openIdb()
      const tx = db.transaction(['meta', 'blobs', 'text'], 'readwrite')
      tx.objectStore('meta').clear()
      tx.objectStore('blobs').clear()
      tx.objectStore('text').clear()
      await txDone(tx)
    }
  }
}

export interface MigrationProgress {
  phase: 'copy' | 'verify' | 'clean'
  done: number
  total: number
  bytes: number
}

export type MigrationResult =
  | { status: 'none' }
  | { status: 'done'; count: number; bytes: number; missing: number }
  | { status: 'nospace'; need: number; free: number; done: number; total: number }
  | { status: 'failed'; error: string; done: number; total: number }

/** 옮길 때 남겨 둘 여유 공간 */
const MARGIN = 64 * 1024 * 1024
const THUMB_BYTES = 40 * 1024
const LANES = 3

export const MIGRATION_KEY = 'legacy_migration'

export async function migrateLegacy(opts: {
  storage: Pick<Storage, 'driver' | 'files'>
  source: LegacySource
  freeSpace: () => Promise<number | null>
  onProgress?: (p: MigrationProgress) => void
}): Promise<MigrationResult> {
  const { driver, files } = opts.storage
  const { source } = opts
  const total = await source.count()
  if (!total) return { status: 'none' }
  const ids = await source.ids()
  let doneCount = 0
  let bytes = 0
  let missing = 0
  const report = (phase: MigrationProgress['phase']): void => opts.onProgress?.({ phase, done: doneCount, total, bytes })

  // ── 이미 옮겨진 장 (행이 있고 원본 파일 크기가 맞으면) 은 건너뛴다
  const present = new Set<number>()
  for (const part of chunk(ids)) {
    const rows = await driver.query<{ id: number; file: string | null; bytes: number }>(
      `SELECT id, file, bytes FROM images WHERE id IN (${marks(part.length)})`,
      part
    )
    const withFile = rows.filter((r) => r.file)
    const sizes = await files.sizes(withFile.map((r) => r.file!))
    withFile.forEach((r, i) => {
      if (sizes[i] === Number(r.bytes)) present.add(Number(r.id))
    })
    for (const r of rows) if (!r.file) present.add(Number(r.id))
  }
  doneCount = present.size
  const todo = ids.filter((id) => !present.has(id))
  report('copy')

  // ── 필요한 공간 추정: 고르게 뽑은 몇 장의 평균 크기 × 남은 장수
  if (todo.length) {
    const step = Math.max(1, Math.floor(todo.length / 16))
    const sample: number[] = []
    for (let i = 0; i < todo.length && sample.length < 16; i += step) {
      const b = await source.blob(todo[i])
      if (b) sample.push(b.byteLength)
    }
    const avg = sample.length ? sample.reduce((a, b) => a + b, 0) / sample.length : 0
    const need = Math.ceil(avg * todo.length * 1.05 + THUMB_BYTES * todo.length + MARGIN)
    const free = await opts.freeSpace()
    if (free !== null && free < need) return { status: 'nospace', need, free, done: doneCount, total }
  }

  // ── 옮기기
  const want = new Set(todo)
  let after: number | null = null
  let sinceCheck = 0
  try {
    for (;;) {
      const metas = await source.metas(after, 24)
      if (!metas.length) break
      after = metas[metas.length - 1].id
      const batch = metas.filter((m) => want.has(m.id))
      if (!batch.length) continue
      const statements: { sql: string; params?: (string | number | null)[] }[] = []
      let next = 0
      const lane = async (): Promise<void> => {
        while (next < batch.length) {
          const meta = batch[next++]
          const buf = await source.blob(meta.id)
          let file: string | null = null
          let size = 0
          if (buf) {
            file = originalPath(meta.id, meta.mime)
            size = await files.write(file, new Blob([buf], { type: meta.mime }))
            if (size !== buf.byteLength) throw new Error(`${meta.id}: 원본 크기가 맞지 않습니다 (${size}/${buf.byteLength})`)
          } else missing++
          let thumb: string | null = null
          if (typeof meta.thumb === 'string' && meta.thumb.startsWith('data:')) {
            const path = thumbPathFor(meta.id, dataUrlMime(meta.thumb) ?? 'image/jpeg')
            thumb = await files.write(path, meta.thumb).then(
              () => path,
              () => null
            )
          }
          // 예전 판에서는 저장 기록이 없으면 미저장으로 표시했다 (v3 인덱스와 같은 규칙)
          const normalized: HistoryMeta = { ...meta, ...(meta.saved || meta.unsaved ? {} : { unsaved: 1 }) }
          statements.push(...insertStatements(normalized, file, size, thumb))
          bytes += size
          doneCount++
          sinceCheck++
        }
      }
      await Promise.all(Array.from({ length: Math.min(LANES, batch.length) }, lane))
      await driver.batch(statements)
      report('copy')
      // 옮기는 중에도 공간을 본다 — 모자라면 여기서 멈추고 다음에 이어서
      if (sinceCheck >= 48) {
        sinceCheck = 0
        const free = await opts.freeSpace()
        if (free !== null && free < MARGIN) return { status: 'nospace', need: MARGIN, free, done: doneCount, total }
      }
    }
  } catch (e) {
    return { status: 'failed', error: (e as Error).message, done: doneCount, total }
  }

  // ── 검증: 옛 장수만큼 행이 있고, 원본이 있는 장은 파일 크기가 기록과 같아야 한다
  report('verify')
  let verified = 0
  const problems: string[] = []
  for (const part of chunk(ids)) {
    const rows = await driver.query<{ id: number; file: string | null; bytes: number }>(
      `SELECT id, file, bytes FROM images WHERE id IN (${marks(part.length)})`,
      part
    )
    if (rows.length !== part.length) problems.push(`${part.length - rows.length}장의 기록이 없습니다`)
    const withFile = rows.filter((r) => r.file)
    const sizes = await files.sizes(withFile.map((r) => r.file!))
    withFile.forEach((r, i) => {
      if (sizes[i] !== Number(r.bytes)) problems.push(`${r.id}: 파일 크기 ${sizes[i]} ≠ ${r.bytes}`)
    })
    verified += rows.length
  }
  if (problems.length || verified !== total) {
    return { status: 'failed', error: `검증 실패 — ${problems.slice(0, 3).join(', ')}`, done: verified, total }
  }

  // ── 다 맞으면 기록을 남기고 나서 옛 데이터를 비운다 (kv는 그대로)
  report('clean')
  await driver.exec('INSERT OR REPLACE INTO app_kv (key, value) VALUES (?, ?)', [
    MIGRATION_KEY,
    JSON.stringify({ count: total, bytes, missing, at: Date.now() })
  ])
  await source.clear()
  return { status: 'done', count: total, bytes, missing }
}
