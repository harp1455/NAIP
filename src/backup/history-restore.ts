/** 히스토리 복원 — 기록은 페이지 단위로, 원본은 한 장씩 읽어 포트에 넣는다 (전체를 메모리에 올리지 않는다) */
import type { HistoryImportPort, HistoryRestoreMode, HistoryRestoreResult } from './history'
import type { NaipBackupReader } from './read'
import { BackupError, throwIfAborted, type EntryProblem, type ProgressCallback } from './types'

export interface RestoreHistoryOptions {
  mode: HistoryRestoreMode
  /** 원본 그림도 넣을지 (백업에 있을 때만 의미) */
  originals: boolean
  onProgress?: ProgressCallback
  signal?: AbortSignal
}

/**
 * replace: 포트를 비우고 백업 기록을 모두 넣는다.
 * merge: 이미 있는 id 는 건너뛴다 (히스토리 id 는 만든 시각이라 같은 id = 같은 그림).
 * 손상된 원본은 기록만 넣고 problems 에 남긴다.
 */
export async function restoreHistory(
  reader: NaipBackupReader,
  port: HistoryImportPort,
  opts: RestoreHistoryOptions
): Promise<HistoryRestoreResult & { problems: EntryProblem[] }> {
  const problems: EntryProblem[] = []
  const result: HistoryRestoreResult = { added: 0, skippedExisting: 0, missingOriginals: 0, failed: 0 }
  const total = reader.manifest.counts.history ?? null
  let done = 0
  let bytes = 0
  if (opts.mode === 'replace') await port.clear()
  for await (const page of reader.historyPages((p) => problems.push(p))) {
    throwIfAborted(opts.signal)
    const existing = opts.mode === 'merge' ? await port.existingIds(page.map((l) => l.record.id)) : new Set<number>()
    for (const line of page) {
      throwIfAborted(opts.signal)
      done++
      if (existing.has(line.record.id)) {
        result.skippedExisting++
        continue
      }
      let original: Uint8Array | null = null
      if (opts.originals && line.original) {
        try {
          original = await reader.readOriginal(line.original)
          bytes += original.byteLength
        } catch (error) {
          if (error instanceof BackupError && error.code === 'aborted') throw error
          problems.push({ path: line.original, kind: 'corrupt', detail: `원본을 읽지 못해 기록만 넣습니다: ${(error as Error).message}` })
        }
      }
      if (opts.originals && !original) result.missingOriginals++
      try {
        await port.put(line.record, original)
        result.added++
      } catch (error) {
        result.failed++
        problems.push({ path: `history#${line.record.id}`, kind: 'corrupt', detail: `기록을 넣지 못했습니다: ${(error as Error).message}` })
      }
      opts.onProgress?.({ phase: 'restore', done, total, bytes, current: String(line.record.id) })
    }
  }
  return { ...result, problems }
}
