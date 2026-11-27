/**
 * NAIP 백업 모듈 공개 API.
 *
 * 내보내기:  data = collectStoreData()  (stores.ts, 또는 직접 만든 BackupData)
 *            estimateBackupSize(data, { mode, history })            → 크기 어림
 *            sink = await createFile(backupFileName(), BACKUP_MIME)  (files.ts; 취소하면 null)
 *            await writeNaipBackup(data, sink, { mode, appVersion, history, onProgress, signal })
 * 불러오기:  file = await pickFile({ accept: BACKUP_ACCEPT })
 *            opened = await openAnyBackup(file)                     → naip / nais3 / naip-json / nais3-json
 *            naip:  { data, problems } = await opened.reader.readData()
 *            nais3: { data, report } = await importNais3(opened.archive, { processImage, newId: uid })
 *            preview = previewRestore(collectStoreData(), data)
 *            plan = planRestore(current, data, { mode, sections, newId: uid, hasHistory, hasOriginals })
 *            applyRestorePlan(plan)  (stores.ts) + restoreHistory(reader, historyPort, plan.history)
 * NAIS3로:  naipToNais3(data) 로 잃는 것 확인 → exportNais3(data, sink, { appVersion })
 */
import { fromUtf8 } from './bytes'
import type { ByteSource } from './io'
import { fromLegacyNaipJson, isLegacyNaipJson } from './legacy'
import { nais3ArchiveFromLegacyJson, readNaisArchive, type Nais3Archive } from './nais3/archive'
import { openNaipBackup, type NaipBackupReader, type OpenBackupOptions } from './read'
import { BACKUP_EXTENSION, BackupError, type BackupData } from './types'

export * from './types'
export * from './io'
export * from './credentials'
export * from './format'
export * from './history'
export * from './report'
export { selectedSections, writeNaipBackup, estimateBackupSize, backupEntries, type WriteBackupOptions, type WriteBackupResult, type SizeEstimate } from './write'
export { openNaipBackup, validateManifest, type NaipBackupReader, type IntegrityReport, type OpenBackupOptions } from './read'
export { planRestore, previewRestore, deepEqual, RESTORE_SCHEMA, type RestorePlan, type SectionPlan, type SectionPreview, type PlanOptions, type PlanChange, type RestoreMode, type SectionAction, type SectionSchema, type CollectionSchema, type RefSchema } from './plan'
export { restoreHistory, type RestoreHistoryOptions } from './history-restore'
export { fromLegacyNaipJson, isLegacyNaipJson } from './legacy'
export { ZipReader, DEFAULT_ZIP_LIMITS, type ZipLimits, type ZipEntry } from './zip/reader'
export { ZipWriter, writeZip, type ZipEntryInput, type ZipEntryResult } from './zip/writer'
export { readNaisArchive, writeNaisArchive, nais3ArchiveFromLegacyJson, type Nais3Archive, type Nais3Output } from './nais3/archive'
export { importNais3, NAIP_DEFAULT_PARAMS, type Nais3ImportOptions } from './nais3/import'
export { naipToNais3, exportNais3, DEFAULT_NAIS3_EXPORT, type Nais3ExportPlan, type Nais3ExportSection } from './nais3/export'
export { createFile, pickFile, type ReadableFile, type WritableFile } from './files'

/** 불러오기 파일 선택에서 받을 확장자 */
export const BACKUP_ACCEPT = [BACKUP_EXTENSION, '.nais', '.json', '.zip']

/** naip-backup-2026-11-27.naipbackup */
export function backupFileName(date = new Date(), prefix = 'naip-backup'): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${prefix}-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}${BACKUP_EXTENSION}`
}

export type OpenedBackup =
  | { kind: 'naip'; reader: NaipBackupReader }
  | { kind: 'nais3'; archive: Nais3Archive }
  | { kind: 'naip-json'; data: BackupData }
  | { kind: 'nais3-json'; archive: Nais3Archive }

const MAX_JSON = 512 * 1024 * 1024

/** 파일 내용으로 종류를 가려 연다: .naipbackup / .nais / 예전 NAIP JSON / NAIS3 JSON */
export async function openAnyBackup(source: ByteSource, opts: OpenBackupOptions = {}): Promise<OpenedBackup> {
  const head = await source.read(0, Math.min(4, source.size))
  if (head[0] === 0x50 && head[1] === 0x4b) {
    try {
      return { kind: 'naip', reader: await openNaipBackup(source, opts) }
    } catch (error) {
      if (!(error instanceof BackupError) || error.code !== 'is-nais3') throw error
      return { kind: 'nais3', archive: await readNaisArchive(source, opts) }
    }
  }
  if (source.size > MAX_JSON) throw new BackupError('entry-too-large', '파일이 너무 큽니다')
  const parts: Uint8Array[] = []
  for (let at = 0; at < source.size; ) {
    const chunk = await source.read(at, Math.min(4 << 20, source.size - at))
    if (!chunk.byteLength) break
    parts.push(chunk)
    at += chunk.byteLength
  }
  let json: unknown
  try {
    const total = parts.reduce((n, c) => n + c.byteLength, 0)
    const all = new Uint8Array(total)
    let at = 0
    for (const c of parts) {
      all.set(c, at)
      at += c.byteLength
    }
    json = JSON.parse(fromUtf8(all).replace(/^﻿/, ''))
  } catch {
    throw new BackupError('not-naip', '백업 파일이 아닙니다 (ZIP 도 JSON 도 아님)')
  }
  if (isLegacyNaipJson(json)) return { kind: 'naip-json', data: fromLegacyNaipJson(json) }
  if (json && typeof json === 'object' && (json as Record<string, unknown>)._app === 'NAIS3') {
    return { kind: 'nais3-json', archive: nais3ArchiveFromLegacyJson(json) }
  }
  if (json && typeof json === 'object' && Object.keys(json).some((k) => k.startsWith('nais2-'))) {
    throw new BackupError('not-naip', 'NAIS2 백업은 지원하지 않습니다 — NAIS3 에서 가져온 뒤 .nais 로 내보내 여세요')
  }
  throw new BackupError('not-naip', '알 수 없는 백업 형식입니다')
}
