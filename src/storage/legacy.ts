import { done, openIdb, txDone, type HistoryMeta } from '../lib/db'
import { chunk, marks, type SqlStatement } from './driver'
import { base64ToBytes, dataUrlMime } from './files'
import { insertStatements, originalPath, thumbPathFor } from './history-repo'
import type { Storage } from './index'

/**
 * 예전 히스토리(IndexedDB의 meta·blobs·text)를 SQLite + 파일로 옮긴다.
 *
 * 안전 규칙:
 * - 옛 데이터는 모든 장을 옮기고 검증(장수 + 장마다 파일 크기)이 끝난 뒤에만 비운다.
 * - id로 이어서 한다 — 이미 옮겨진 장(행이 있고 파일 크기가 맞음)은 건너뛰므로 중간에 앱이 죽어도 다시 시작하면 된다.
 * - 파일을 먼저 쓰고(임시 파일 → 이름 바꾸기) 크기를 확인한 뒤에 행을 넣는다. 행만 있고 파일이 없는 상태는 생기지 않는다.
 *   원본이 없는 장(예전 저장소에 원본이 없거나, 확인하고 원본 없이 옮기는 장)은 썸네일이 남는 그림의 전부라
 *   썸네일도 쓰고 크기를 확인한 뒤에만 행을 넣는다 (못 쓰면 그 장은 옮기지 않고 옛 데이터를 비우지 않는다).
 * - 시작 전에 남은 공간을 확인하고, 옮기는 중에도 공간이 떨어지면 멈춘다 (옛 데이터는 그대로).
 * - 한 장이 실패해도 그 묶음에서 다 옮긴 장의 행은 남긴다 (행 없는 원본 파일이 생기지 않게).
 * - 원본이 읽히지 않는 장은 건너뛰고 나머지를 옮긴다. 그런 장이 있으면 실패로 알리고 옛 데이터는 비우지 않는다.
 *   읽히는 장을 모두 옮기고 검증까지 맞았는데 읽히지 않는 장만 남았으면 그 id를 알린다(unreadable).
 *   사용자가 그 원본 없이 마치기로 확인한 뒤에만(skipUnreadable) 읽히는 장을 정상 경로와 똑같이 다시 검증하고,
 *   그 장은 원본 없는 장(missing)처럼 기록(썸네일·프롬프트·시드·설정)만 옮겨 확인한 뒤에 비운다.
 *   확인한 적 없는 장이 읽히지 않거나 검증이 틀리면 비우지 않는다.
 * - 옮긴 뒤 지운 장은 forgetLegacy로 옛 데이터에서도 지운다 (다음 옮기기에서 되살아나지 않게).
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
  | {
      status: 'done'
      /** 옮기고 검증한 장수 */
      count: number
      bytes: number
      missing: number
      /** 원본을 읽을 수 없어 사용자가 확인하고 기록만 옮긴 장수 (missing·count 에도 든다) */
      skipped?: number
    }
  | { status: 'nospace'; need: number; free: number; done: number; total: number }
  | {
      status: 'failed'
      error: string
      done: number
      total: number
      /**
       * 실패 이유가 "읽을 수 없는 장"뿐일 때 그 id (오름차순) — 읽히는 장은 모두 옮겼고 검증도 맞았다.
       * 이때만 사용자에게 그 장을 원본 없이 옮기고 마칠지 묻는다 (migrateLegacy 의 skipUnreadable)
       */
      unreadable?: number[]
    }

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
  /**
   * 사용자가 원본 없이 옮기기로 확인한, 원본을 읽을 수 없는 장 (지난 실패의 unreadable). 이번에도 읽히지 않는 장이 모두
   * 여기 있을 때만 그 장을 원본 없는 기록으로 옮기고 검증한 뒤 옛 데이터를 비운다. 그 사이 읽히게 된 장은 그대로 옮긴다
   */
  skipUnreadable?: readonly number[]
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
      // 읽지 못하는 장은 추정에서 빼고, 옮기기에서 따로 다룬다
      const b = await source.blob(todo[i]).catch(() => null)
      if (b) sample.push(b.byteLength)
    }
    const avg = sample.length ? sample.reduce((a, b) => a + b, 0) / sample.length : 0
    const need = Math.ceil(avg * todo.length * 1.05 + THUMB_BYTES * todo.length + MARGIN)
    const free = await opts.freeSpace()
    if (free !== null && free < need) return { status: 'nospace', need, free, done: doneCount, total }
  }

  // ── 옮기기
  const want = new Set(todo)
  /** 두 번 읽어도 원본이 읽히지 않은 장 — 건너뛰고 나머지를 옮긴다. 하나라도 있으면 옛 데이터를 비우지 않는다 */
  const unreadable: number[] = []
  /** 그 장의 기록 — 사용자가 확인하면 원본 없이 옮긴다 */
  const unreadableMetas = new Map<number, HistoryMeta>()
  let unreadableError = ''
  const readBlob = async (id: number): Promise<ArrayBuffer | null | undefined> => {
    try {
      return await source.blob(id)
    } catch {
      try {
        return await source.blob(id)
      } catch (e) {
        unreadableError ||= (e as Error)?.message ?? String(e)
        return undefined
      }
    }
  }
  /**
   * 한 장을 옮길 문장 — 원본(buf)이 있으면 파일을 먼저 쓰고 크기를 확인한다. buf 가 null 이면 원본 없는 기록.
   * 원본이 있는 장의 썸네일은 쓸 수 있을 때만 (못 쓰면 화면이 원본에서 다시 만든다).
   * 원본이 없는 장은 썸네일이 남는 그림의 전부라, 쓰지 못하거나 크기가 맞지 않으면 이 장을 옮기지 않는다
   * (행을 넣지 않으니 옛 데이터를 비우지 않고 다음에 다시 한다). 풀 수 없는 썸네일(깨진 base64)은 잃을 것이 없으니 없이 옮긴다
   */
  const copyOne = async (meta: HistoryMeta, buf: ArrayBuffer | null): Promise<{ statements: SqlStatement[]; size: number }> => {
    let file: string | null = null
    let size = 0
    if (buf) {
      file = originalPath(meta.id, meta.mime)
      size = await files.write(file, new Blob([buf], { type: meta.mime }))
      if (size !== buf.byteLength) throw new Error(`${meta.id}: 원본 크기가 맞지 않습니다 (${size}/${buf.byteLength})`)
    }
    let thumb: string | null = null
    if (typeof meta.thumb === 'string' && meta.thumb.startsWith('data:')) {
      const mime = dataUrlMime(meta.thumb) ?? 'image/jpeg'
      const path = thumbPathFor(meta.id, mime)
      if (buf) {
        thumb = await files.write(path, meta.thumb).then(
          () => path,
          () => null
        )
      } else {
        const bytes = decodedThumb(meta.thumb)
        if (bytes) {
          const n = await files.write(path, new Blob([bytes as BlobPart], { type: mime })).catch((e: unknown) => {
            throw new Error(`${meta.id}: 원본 없는 장의 썸네일을 쓰지 못했습니다 (${(e as Error)?.message ?? String(e)})`)
          })
          if (n !== bytes.byteLength) throw new Error(`${meta.id}: 원본 없는 장의 썸네일 크기가 맞지 않습니다 (${n}/${bytes.byteLength})`)
          thumb = path
        }
      }
    }
    // 예전 판에서는 저장 기록이 없으면 미저장으로 표시했다 (v3 인덱스와 같은 규칙)
    const normalized: HistoryMeta = { ...meta, ...(meta.saved || meta.unsaved ? {} : { unsaved: 1 }) }
    return { statements: insertStatements(normalized, file, size, thumb), size }
  }
  let after: number | null = null
  let sinceCheck = 0
  try {
    for (;;) {
      const metas = await source.metas(after, 24)
      if (!metas.length) break
      after = metas[metas.length - 1].id
      const batch = metas.filter((m) => want.has(m.id))
      if (!batch.length) continue
      const statements: SqlStatement[] = []
      let next = 0
      let failure = null as Error | null
      const lane = async (): Promise<void> => {
        // 한 장이 실패하면 새 장은 시작하지 않고 쓰던 장만 마저 끝낸다
        while (next < batch.length && !failure) {
          const meta = batch[next++]
          try {
            const buf = await readBlob(meta.id)
            if (buf === undefined) {
              unreadable.push(meta.id)
              unreadableMetas.set(meta.id, meta)
              continue
            }
            const one = await copyOne(meta, buf)
            statements.push(...one.statements)
            if (!buf) missing++
            bytes += one.size
            doneCount++
            sinceCheck++
          } catch (e) {
            failure ??= e instanceof Error ? e : new Error(String(e))
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(LANES, batch.length) }, lane))
      // 실패한 묶음이라도 다 옮긴 장의 기록은 남긴다 — 파일만 있고 기록이 없는 장(기록 없는 원본)이 생기지 않게
      await driver.batch(statements)
      report('copy')
      if (failure) throw failure
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
  unreadable.sort((a, b) => a - b)
  const skip = new Set(unreadable)

  // ── 검증: 옛 장수만큼 행이 있고, 원본이 있는 장은 파일 크기가 기록과 같아야 한다.
  // 읽을 수 없는 장이 있으면 그 장만 빼고 같은 검증을 한다 — 남은 문제가 그것뿐인지 알아야 두고 갈지 물을 수 있다
  report('verify')
  let verified = 0
  const problems: string[] = []
  for (const part of chunk(ids.filter((id) => !skip.has(id)))) {
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
  if (problems.length || verified !== total - unreadable.length) {
    return { status: 'failed', error: `검증 실패 — ${problems.slice(0, 3).join(', ')}`, done: verified, total }
  }
  if (unreadable.length) {
    const confirmed = new Set(opts.skipUnreadable ?? [])
    if (!unreadable.every((id) => confirmed.has(id))) {
      // 읽히는 장은 모두 옮기고 검증했다. 읽히지 않는 장이 있으니 옛 데이터는 그대로 두고, 다시 시도하면 그 장만 다시 읽는다
      const shown = unreadable.slice(0, 5).join(', ') + (unreadable.length > 5 ? ' …' : '')
      return {
        status: 'failed',
        error: `${unreadable.length}장의 원본을 읽지 못했습니다 (id ${shown}): ${unreadableError}`,
        done: doneCount,
        total,
        unreadable
      }
    }
  }

  // ── 원본을 읽을 수 없는 장 — 여기까지 오는 것은 사용자가 그 원본 없이 마치기로 확인한 때뿐이다.
  // 원본 없는 장(missing)처럼 기록(썸네일·프롬프트·시드·설정)은 옮기고, 들어간 것을 확인한 뒤에만 비운다
  const skipped = unreadable.length
  if (skipped) {
    const statements: SqlStatement[] = []
    try {
      // 썸네일을 모두 쓰고 크기를 확인한 뒤에만 행을 넣는다 — 한 장이라도 못 쓰면 아무 행도 넣지 않고 옛 데이터는 그대로
      for (const id of unreadable) statements.push(...(await copyOne(unreadableMetas.get(id)!, null)).statements)
    } catch (e) {
      return { status: 'failed', error: (e as Error).message, done: verified, total }
    }
    await driver.batch(statements)
    let kept = 0
    for (const part of chunk(unreadable)) {
      const [row] = await driver.query<{ n: number }>(`SELECT COUNT(*) AS n FROM images WHERE id IN (${marks(part.length)})`, part)
      kept += Number(row?.n ?? 0)
    }
    if (kept !== skipped) {
      return { status: 'failed', error: `검증 실패 — 원본 없이 옮긴 ${skipped}장 중 ${skipped - kept}장의 기록이 없습니다`, done: verified, total }
    }
    verified += kept
    missing += kept
  }

  // ── 다 맞으면 기록을 남기고 나서 옛 데이터를 비운다 (kv는 그대로)
  report('clean')
  await driver.exec('INSERT OR REPLACE INTO app_kv (key, value) VALUES (?, ?)', [
    MIGRATION_KEY,
    JSON.stringify({ count: verified, bytes, missing, ...(skipped ? { skipped } : {}), at: Date.now() })
  ])
  await source.clear()
  return { status: 'done', count: verified, bytes, missing, ...(skipped ? { skipped } : {}) }
}

/** 썸네일 dataURL 의 바이트 — 풀 수 없거나 비었으면 null */
function decodedThumb(dataUrl: string): Uint8Array | null {
  try {
    const bytes = base64ToBytes(dataUrl)
    return bytes.byteLength ? bytes : null
  } catch {
    return null
  }
}

/** 아직 옮기지 않은 예전 히스토리가 남아 있는지 (읽을 수 없으면 false) */
export async function legacyPending(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false
  try {
    return (await idbLegacySource().count()) > 0
  } catch {
    return false
  }
}

/**
 * 새 저장소에서 지운 장을 예전 저장소(meta·blobs·text)에서도 지운다.
 * 옮기기가 끝나기 전("나중에")에 지운 그림이 다음 옮기기에서 되살아나지 않게 한다.
 * 사용자가 지우기로 한 장만 받는다 — 아직 옮기지 않은 장을 여기서 함부로 지우지 않는다.
 */
export async function forgetLegacy(ids: number[]): Promise<void> {
  if (!ids.length || !(await legacyPending())) return
  const db = await openIdb()
  const tx = db.transaction(['meta', 'blobs', 'text'], 'readwrite')
  for (const id of ids) {
    tx.objectStore('meta').delete(id)
    tx.objectStore('blobs').delete(id)
    tx.objectStore('text').delete(id)
  }
  await txDone(tx)
}
