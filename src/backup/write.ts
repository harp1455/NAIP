/** .naipbackup 쓰기 — 섹션 JSON·그림·히스토리를 항목 스트림으로 만들어 ZIP 에 한 개씩 흘려 넣는다 */
import { utf8 } from './bytes'
import { stripCredentials } from './credentials'
import {
  CHECKSUMS_PATH,
  countSection,
  extractAssets,
  HISTORY_PAGE_SIZE,
  historyPagePath,
  MANIFEST_PATH,
  originalPath,
  sectionPath
} from './format'
import type { HistoryExportPort, HistoryLine } from './history'
import type { ByteSink } from './io'
import { BufferedSink } from './io'
import {
  BackupError,
  DATA_SECTION_IDS,
  MODE_SECTIONS,
  NAIP_FORMAT,
  NAIP_FORMAT_VERSION,
  SECTION_IDS,
  throwIfAborted,
  type BackupData,
  type BackupMode,
  type Checksums,
  type DataSectionId,
  type NaipManifest,
  type ProgressCallback,
  type SectionId
} from './types'
import { ZipWriter, type ZipEntryInput, type ZipWriterOptions } from './zip/writer'

export interface WriteBackupOptions {
  mode: BackupMode
  /** custom 일 때 고른 섹션 (historyOriginals 를 고르면 history 도 따라온다) */
  sections?: readonly SectionId[]
  appVersion: string
  createdAt?: string
  history?: HistoryExportPort
  historyPageSize?: number
  onProgress?: ProgressCallback
  signal?: AbortSignal
  zip?: Pick<ZipWriterOptions, 'level' | 'forceZip64'>
  /** 네이티브로 넘기는 쓰기 단위 (기본 1MB) */
  chunkSize?: number
}

export interface WriteBackupResult {
  manifest: NaipManifest
  bytes: number
  entries: number
  /** 원본 파일이 사라져 기록만 담은 히스토리 */
  skippedOriginals: number
  /** 지운 자격 증명의 위치 (값은 담지 않는다) */
  removedCredentials: string[]
}

/** 모드·선택 → 실제로 담을 섹션 (SECTION_IDS 순서) */
export function selectedSections(mode: BackupMode, custom?: readonly SectionId[]): SectionId[] {
  const picked = new Set<SectionId>(mode === 'custom' ? (custom ?? []) : MODE_SECTIONS[mode])
  if (picked.has('historyOriginals')) picked.add('history')
  return SECTION_IDS.filter((id) => picked.has(id))
}

function jsonBytes(value: unknown): Uint8Array {
  return utf8(`${JSON.stringify(value)}\n`)
}

interface EntryState {
  counts: Partial<Record<SectionId, number>>
  sections: SectionId[]
  skippedOriginals: number
  removedCredentials: string[]
  done: number
  total: number | null
}

/**
 * 백업 항목 스트림 (manifest·checksums 제외). 히스토리 원본은 포트에서 한 장씩 읽는다 —
 * 소비하는 쪽이 앞 항목을 다 쓴 뒤에야 다음 장을 읽는다.
 */
export async function* backupEntries(
  data: BackupData,
  opts: WriteBackupOptions,
  state: EntryState
): AsyncGenerator<ZipEntryInput & { phase: 'sections' | 'history' | 'originals'; units: number }> {
  const wanted = new Set(selectedSections(opts.mode, opts.sections))
  for (const id of DATA_SECTION_IDS) {
    if (!wanted.has(id) || data[id] == null) continue
    throwIfAborted(opts.signal)
    const stripped = stripCredentials(data[id], id)
    state.removedCredentials.push(...stripped.removed)
    const { json, assets } = extractAssets(id, stripped.value)
    // 그림을 먼저, 섹션 JSON 을 나중에 (NAIS3 archive.ts 와 같은 순서)
    for (const a of assets) yield { path: a.path, data: a.bytes(), compress: false, phase: 'sections', units: 0 }
    yield { path: sectionPath(id), data: jsonBytes(json), compress: true, phase: 'sections', units: 1 }
    state.counts[id] = countSection(id, stripped.value)
    state.sections.push(id)
  }

  const port = opts.history
  if (!port || !wanted.has('history')) return
  const withOriginals = wanted.has('historyOriginals')
  const pageSize = opts.historyPageSize ?? HISTORY_PAGE_SIZE
  let records = 0
  let originals = 0
  let page = 0
  const seen = new Set<number>()
  for await (const batch of port.pages(pageSize)) {
    throwIfAborted(opts.signal)
    const lines: string[] = []
    let withoutOriginal = 0
    for (const raw of batch) {
      // 같은 기록이 두 번 오면 (저장소가 페이지를 겹쳐 주는 경우) 한 번만 담는다
      if (seen.has(raw.id)) continue
      seen.add(raw.id)
      const { value: record, removed } = stripCredentials(raw, `history[${raw.id}]`)
      state.removedCredentials.push(...removed)
      let original: string | null = null
      if (withOriginals) {
        const bytes = await port.original(raw)
        if (bytes) {
          original = originalPath(raw.id, raw.mime, bytes)
          yield { path: original, data: bytes, compress: false, phase: 'originals', units: 1 }
          originals++
        } else {
          state.skippedOriginals++
          withoutOriginal++
        }
      }
      const line: HistoryLine = { record, original }
      lines.push(JSON.stringify(line))
      records++
    }
    if (!lines.length) continue
    page++
    // 원본을 담으면 진행률은 원본 한 장씩, 아니면 기록 페이지 단위로 센다
    yield {
      path: historyPagePath(page),
      data: utf8(`${lines.join('\n')}\n`),
      compress: true,
      phase: 'history',
      units: withOriginals ? withoutOriginal : lines.length
    }
  }
  state.counts.history = records
  state.sections.push('history')
  if (withOriginals) {
    state.counts.historyOriginals = originals
    state.sections.push('historyOriginals')
  }
}

/** 백업 하나를 sink 에 끝까지 쓴다. 실패하거나 취소하면 sink.abort() 로 쓰다 만 파일을 지운다 */
export async function writeNaipBackup(data: BackupData, sink: ByteSink, opts: WriteBackupOptions): Promise<WriteBackupResult> {
  const out = new BufferedSink(sink, opts.chunkSize)
  const zip = new ZipWriter(out, { ...opts.zip, signal: opts.signal, date: opts.createdAt ? new Date(opts.createdAt) : undefined })
  const state: EntryState = { counts: {}, sections: [], skippedOriginals: 0, removedCredentials: [], done: 0, total: null }
  const checksums: Checksums = {}
  try {
    const wanted = selectedSections(opts.mode, opts.sections)
    // 진행 단위: 섹션 하나 = 1, 히스토리 한 장 = 1
    const historyCount = opts.history && wanted.includes('history') ? (await opts.history.stats()).count : 0
    state.total = historyCount + DATA_SECTION_IDS.filter((id) => wanted.includes(id) && data[id] != null).length
    for await (const entry of backupEntries(data, opts, state)) {
      const r = await zip.add(entry)
      checksums[r.path] = { sha256: r.sha256, size: r.size }
      state.done += entry.units
      opts.onProgress?.({ phase: entry.phase, done: state.done, total: state.total, bytes: zip.bytesWritten, current: entry.path })
    }
    const manifest: NaipManifest = {
      format: NAIP_FORMAT,
      formatVersion: NAIP_FORMAT_VERSION,
      app: 'NAIP',
      appVersion: opts.appVersion,
      createdAt: opts.createdAt ?? new Date().toISOString(),
      mode: opts.mode,
      sections: state.sections,
      counts: state.counts
    }
    await zip.add({ path: CHECKSUMS_PATH, data: utf8(`${JSON.stringify(checksums, null, 1)}\n`) })
    await zip.add({ path: MANIFEST_PATH, data: utf8(`${JSON.stringify(manifest, null, 2)}\n`) })
    const bytes = await zip.finish()
    opts.onProgress?.({ phase: 'finish', done: state.done, total: state.total, bytes })
    await out.close()
    return {
      manifest,
      bytes,
      entries: zip.entryCount,
      skippedOriginals: state.skippedOriginals,
      removedCredentials: state.removedCredentials
    }
  } catch (error) {
    await out.abort().catch(() => {})
    if (error instanceof BackupError) throw error
    throw new BackupError('write-failed', `백업을 쓰지 못했습니다: ${(error as Error).message}`)
  }
}

export interface SizeEstimate {
  /** 압축 전 기준의 대략적인 최대 크기 (JSON 은 실제로 훨씬 작아진다) */
  bytes: number
  entries: number
  sections: Partial<Record<SectionId, number>>
}

const ENTRY_OVERHEAD = 30 + 46 + 16
const META_BYTES_GUESS = 4 * 1024

/** 쓰기 전에 크기를 어림한다 (저장 공간 확인·진행률 표시용) */
export async function estimateBackupSize(
  data: BackupData,
  opts: Pick<WriteBackupOptions, 'mode' | 'sections' | 'history'>
): Promise<SizeEstimate> {
  const wanted = new Set(selectedSections(opts.mode, opts.sections))
  const sections: Partial<Record<SectionId, number>> = {}
  let bytes = 0
  let entries = 2
  for (const id of DATA_SECTION_IDS) {
    if (!wanted.has(id) || data[id] == null) continue
    const { json, assets } = extractAssets(id as DataSectionId, data[id])
    let size = utf8(JSON.stringify(json)).byteLength + ENTRY_OVERHEAD * 2
    for (const a of assets) size += a.size + ENTRY_OVERHEAD + a.path.length * 2
    sections[id] = size
    bytes += size
    entries += 1 + assets.length
  }
  if (opts.history && wanted.has('history')) {
    const s = await opts.history.stats()
    const meta = s.metaBytes ?? s.count * META_BYTES_GUESS
    sections.history = meta + Math.ceil(s.count / HISTORY_PAGE_SIZE) * ENTRY_OVERHEAD
    bytes += sections.history
    entries += Math.ceil(s.count / HISTORY_PAGE_SIZE)
    if (wanted.has('historyOriginals')) {
      sections.historyOriginals = (s.originalBytes ?? s.count * 1.5 * 1024 * 1024) + s.count * (ENTRY_OVERHEAD + 80)
      bytes += sections.historyOriginals
      entries += s.count
    }
  }
  return { bytes: Math.round(bytes), entries, sections }
}
