/**
 * 히스토리 포트 — Phase 3 저장소(SQLite 행 + 앱 전용 폴더의 원본·썸네일 파일) 위의
 * HistoryExportPort / HistoryImportPort.
 *
 * - 기록은 행을 HistoryMeta 로 되돌린 것 그대로(snap·sent(cast 포함)·parentId·saved·unsaved·requestId 와
 *   extra 열에 든 앞으로 늘어날 필드까지). 썸네일은 저장된 파일을 data URL 로 담는다 (주소는 기기마다 달라서).
 * - 원본은 한 장씩만 읽는다 (백업 쓰기가 앞 장을 다 쓴 뒤에야 다음 장을 부른다).
 * - 넣을 때 썸네일이 없으면 원본으로 새로 만든다(makeThumb). 원본 없이 기록만 넣으면 같은 id 의
 *   지금 원본 파일을 계속 가리킨다 (기록만 바꾸고 그림은 지우지 않는다).
 * - "바꾸기" 복원은 restoreHistorySafely 로: 지금 기록을 먼저 지우지 않는다.
 * - 지운 기록은 이전 히스토리 옮기기가 끝나기 전이면 예전 저장소에서도 지운다 (forgetLegacy — 히스토리 화면에서
 *   지울 때와 같게). 그러지 않으면 다음 실행의 옮기기가 지운 그림을 되살린다. 아직 옮기지 않은 장은 건드리지 않는다.
 */
import type { HistoryMeta } from '../lib/db'
import { chunk, marks, type SqlDriver } from '../storage/driver'
import { dataUrlMime, type FileStore } from '../storage/files'
import { createHistoryRepo, insertStatements, originalPath, rowToMeta, thumbPathFor, type ImageRow } from '../storage/history-repo'
import { forgetLegacy, legacyPending } from '../storage/legacy'
import { sniffImage, toBase64 } from './bytes'
import { HISTORY_PAGE_RE } from './format'
import type { HistoryExportPort, HistoryImportPort, HistoryRecord, HistoryRestoreResult } from './history'
import { restoreHistory, type RestoreHistoryOptions } from './history-restore'
import type { NaipBackupReader } from './read'
import type { EntryProblem } from './types'

export interface HistoryStore {
  driver: SqlDriver
  files: FileStore
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

function thumbMime(path: string, blob: Blob): string {
  if (blob.type.startsWith('image/')) return blob.type
  return path.endsWith('.webp') ? 'image/webp' : path.endsWith('.png') ? 'image/png' : 'image/jpeg'
}

export function historyExportPort(s: HistoryStore): HistoryExportPort {
  // 지금 페이지의 원본 경로 (original() 이 행을 다시 읽지 않도록 한 페이지만 기억)
  let pageFiles = new Map<number, string | null>()
  const thumbData = async (row: ImageRow): Promise<string> => {
    if (!row.thumb) return ''
    try {
      const blob = await s.files.read(row.thumb)
      if (!blob || !blob.size) return ''
      return `data:${thumbMime(row.thumb, blob)};base64,${toBase64(await blobBytes(blob))}`
    } catch {
      return ''
    }
  }
  return {
    async stats() {
      const [row] = await s.driver.query<{ n: number; b: number }>(
        'SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN file IS NULL THEN 0 ELSE bytes END), 0) AS b FROM images'
      )
      const count = Number(row?.n ?? 0)
      const thumbs = await s.files.list('thumbs').catch(() => [])
      const thumbBytes = thumbs.reduce((a, f) => a + f.size, 0)
      // 기록 = 썸네일(base64 로 4/3) + 프롬프트·설정 JSON (장당 약 3KB)
      return { count, originalBytes: Number(row?.b ?? 0), metaBytes: Math.round((thumbBytes * 4) / 3) + count * 3072 }
    },
    async *pages(size) {
      let after = Number.MIN_SAFE_INTEGER
      for (;;) {
        const rows = await s.driver.query<ImageRow>('SELECT * FROM images WHERE id > ? ORDER BY id ASC LIMIT ?', [after, size])
        if (!rows.length) return
        pageFiles = new Map()
        const out: HistoryRecord[] = []
        for (const r of rows) {
          pageFiles.set(Number(r.id), r.file)
          out.push(rowToMeta(r, await thumbData(r)) as unknown as HistoryRecord)
        }
        after = Number(rows[rows.length - 1].id)
        yield out
        if (rows.length < size) return
      }
    },
    async original(record) {
      const path = pageFiles.has(record.id)
        ? pageFiles.get(record.id)
        : (await s.driver.query<{ file: string | null }>('SELECT file FROM images WHERE id = ?', [record.id]))[0]?.file
      if (!path) return null
      const blob = await s.files.read(path).catch(() => null)
      return blob ? blobBytes(blob) : null
    }
  }
}

export interface HistoryImportOptions {
  /** 원본으로 썸네일(data URL) 만들기 — 앱은 lib/image 의 makeThumb. 없으면 썸네일 없이 넣고 화면이 볼 때 만든다 */
  makeThumb?: (original: Blob) => Promise<string>
}

export interface AppHistoryImportPort extends HistoryImportPort {
  /** 지금 있는 모든 기록 id */
  allIds(): Promise<number[]>
  /** 기록과 그 원본·썸네일 파일을 지운다 (이전 히스토리 옮기기가 끝나기 전이면 예전 저장소에서도) */
  remove(ids: number[]): Promise<void>
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** 백업의 기록(믿을 수 없는 JSON) → 저장소가 받는 HistoryMeta. 모르는 필드는 extra 열로 그대로 간다 */
export function recordToMeta(record: HistoryRecord, original: Uint8Array | null): HistoryMeta {
  const r = record as Record<string, unknown>
  const id = r.id
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new Error(`기록 id 가 잘못됐습니다: ${String(id)}`)
  // 원본이 있으면 내용으로 형식을 정한다 (파일 이름 확장자가 여기에 따라 정해진다)
  const sniffed = original ? sniffImage(original)?.mime : undefined
  const mime = sniffed === 'image/png' || sniffed === 'image/webp' ? sniffed : r.mime === 'image/webp' ? 'image/webp' : 'image/png'
  return {
    ...(r as object),
    id,
    ts: num(r.ts, id),
    thumb: '',
    width: num(r.width, 0),
    height: num(r.height, 0),
    seed: num(r.seed, 0),
    model: str(r.model),
    kind: (typeof r.kind === 'string' && r.kind ? r.kind : 't2i') as HistoryMeta['kind'],
    prompt: str(r.prompt),
    negative: str(r.negative),
    mime
  } as HistoryMeta
}

export function historyImportPort(s: HistoryStore, opts: HistoryImportOptions = {}): AppHistoryImportPort {
  const repo = createHistoryRepo(s.driver, s.files)
  return {
    async existingIds(ids) {
      const found = new Set<number>()
      for (const part of chunk(ids)) {
        const rows = await s.driver.query<{ id: number }>(`SELECT id FROM images WHERE id IN (${marks(part.length)})`, part)
        for (const r of rows) found.add(Number(r.id))
      }
      return found
    },
    async clear() {
      // 옮기기가 끝나기 전이면 지금 히스토리에 있는(옮겨진) 장만 예전 저장소에서도 지운다. 아직 옮기지 않은 장은 남긴다
      const moved = (await legacyPending()) ? await repo.ids({}) : []
      await repo.clear()
      if (moved.length) await forgetLegacy(moved).catch((e: unknown) => console.warn('이전 히스토리에서 지우지 못했습니다', e))
    },
    async put(record, original) {
      const meta = recordToMeta(record, original)
      const prev = await repo.row(meta.id)
      let thumbData = typeof record.thumb === 'string' && record.thumb.startsWith('data:image/') ? record.thumb : ''
      if (original) {
        const blob = new Blob([original as BlobPart], { type: meta.mime })
        if (!thumbData && opts.makeThumb) thumbData = await opts.makeThumb(blob).catch(() => '')
        // 원본 파일 → 썸네일 → 행 (INSERT OR REPLACE)
        await repo.add({ ...meta, thumb: thumbData }, blob)
        // 같은 id 의 예전 파일이 다른 이름(확장자)이었으면 남지 않게
        const stale = [prev?.file, prev?.thumb].filter(
          (p): p is string => !!p && p !== originalPath(meta.id, meta.mime) && p !== (thumbData ? thumbPathFor(meta.id, dataUrlMime(thumbData) ?? 'image/jpeg') : null)
        )
        if (stale.length) await s.files.remove(stale).catch(() => {})
        return
      }
      // 원본 없이 기록만 — 같은 id 의 지금 원본·썸네일이 있으면 계속 가리킨다
      let thumb: string | null = prev?.thumb ?? null
      if (thumbData) {
        const path = thumbPathFor(meta.id, dataUrlMime(thumbData) ?? 'image/jpeg')
        await s.files.write(path, thumbData)
        thumb = path
      }
      await s.driver.batch(insertStatements(meta, prev?.file ?? null, prev ? Number(prev.bytes) : 0, thumb))
    },
    async allIds() {
      const rows = await s.driver.query<{ id: number }>('SELECT id FROM images ORDER BY id')
      return rows.map((r) => Number(r.id))
    },
    async remove(ids) {
      if (!ids.length) return
      await repo.remove(ids)
      // 다음 옮기기에서 되살아나지 않게 — 지운 장만 (useHistory.remove 와 같게)
      await forgetLegacy(ids).catch((e: unknown) => console.warn('이전 히스토리에서 지우지 못했습니다', e))
    }
  }
}

export interface SafeHistoryResult extends HistoryRestoreResult {
  problems: EntryProblem[]
  /** 바꾸기에서 지운 지금 기록 (백업에 없던 것) */
  removed: number
  /** 지운 기록의 id — 프로젝트 조합에서도 빼야 한다 */
  removedIds?: number[]
  /** 바꾸기였지만 문제가 있어 지금 기록을 지우지 않고 남겨 둔 수 */
  keptBecauseOfProblems: number
}

/**
 * 히스토리 복원. merge 는 restoreHistory 그대로(같은 id 는 건너뜀).
 * replace 는 지금 기록을 먼저 비우지 않는다: 백업 기록을 모두 넣고(같은 id 는 백업 것으로 바뀜),
 * 손상·실패가 하나도 없을 때만 백업에 없던 지금 기록을 지운다. 문제가 있거나 취소하면 아무것도 지우지 않는다
 * (합쳐진 상태로 남고, 결과에 남긴 수를 알린다).
 */
export async function restoreHistorySafely(
  reader: NaipBackupReader,
  port: AppHistoryImportPort,
  opts: RestoreHistoryOptions
): Promise<SafeHistoryResult> {
  if (opts.mode === 'merge') return { ...(await restoreHistory(reader, port, opts)), removed: 0, keptBecauseOfProblems: 0 }
  const before = await port.allIds()
  const seen = new Set<number>()
  const deferred: HistoryImportPort = {
    existingIds: async () => new Set(),
    // 비우기는 끝까지 미룬다
    clear: async () => {},
    put: async (record, original) => {
      await port.put(record, original)
      seen.add(record.id)
    }
  }
  const result = await restoreHistory(reader, deferred, opts)
  const stale = before.filter((id) => !seen.has(id))
  // 기록 페이지가 통째로 없으면 읽기에서는 문제로 드러나지 않는다 (없는 항목은 돌지 않으므로) —
  // 체크섬 목록에만 있는 페이지, 또는 manifest 에 적힌 기록 수보다 적게 읽은 경우도 문제로 보고 지우지 않는다
  const problems = [...result.problems, ...reader.structuralProblems.filter((p) => p.kind === 'missing' && HISTORY_PAGE_RE.test(p.path))]
  const expected = reader.manifest.counts.history
  if (typeof expected === 'number' && seen.size + result.failed < expected) {
    problems.push({ path: 'history', kind: 'missing', detail: `백업에 적힌 기록 ${expected}장 중 ${seen.size + result.failed}장만 읽었습니다` })
  }
  if (result.failed || problems.length) return { ...result, problems, removed: 0, keptBecauseOfProblems: stale.length }
  await port.remove(stale)
  return { ...result, removed: stale.length, removedIds: stale, keptBecauseOfProblems: 0 }
}
