/**
 * 백업·복원 화면(components/BackupSheet)과 앱을 잇는 곳 — 스토어, Phase 3 히스토리 저장소, 파일 고르기·쓰기를 묶는다.
 * 이 모듈과 src/backup 전체는 설정에서 백업 화면을 열 때 동적 import 로만 불린다 (첫 화면 번들에 넣지 않는다).
 *
 * 지키는 것:
 * - 토큰(NovelAI·GitHub)은 백업에 들어가지 않는다 (모을 때·쓸 때·읽을 때 모두 지운다).
 * - 생성 대기열은 백업하지 않는다 (섹션 자체가 없다 — types.ts).
 * - 복원은 계획을 보여 주고 확인을 받은 뒤에만, 기본으로 지금 상태의 자동 백업(safety.ts)을 먼저 남기고 한다.
 * - 히스토리 "바꾸기"는 지금 기록을 먼저 지우지 않는다 (ports.ts restoreHistorySafely).
 */
import { makeThumb, pngDataUrl, toPngBase64 } from '../lib/image'
import { uid } from '../lib/util'
import { freeSpace, getStorage } from '../storage'
import { forgetLegacy } from '../storage/legacy'
import { useProjects } from '../project/store'
import { useHistory } from '../stores/history'
import { useSettings } from '../stores/settings'
import { createFile, pickFile, type ReadableFile } from './files'
import { countSection } from './format'
import { BACKUP_ACCEPT, backupFileName, openAnyBackup, type OpenedBackup } from './index'
import type { ByteSource } from './io'
import { exportNais3, naipToNais3, type Nais3ExportPlan, type Nais3ExportSection } from './nais3/export'
import { importNais3 } from './nais3/import'
import { planRestore, previewRestore, type RestoreMode, type RestorePlan, type SectionAction, type SectionPreview, type SectionStats } from './plan'
import { historyExportPort, historyImportPort, restoreHistorySafely, type SafeHistoryResult } from './ports'
import type { NaipBackupReader } from './read'
import { reportText } from './report'
import { listSafetyBackups, pruneSafetyBackups, removeSafetyBackup, safetyName, safetySink, safetySource, type SafetyBackup } from './safety'
import { applyRestorePlan, collectStoreData, normalizeBackupData, waitHydrated } from './stores'
import {
  BACKUP_MIME,
  BackupError,
  DATA_SECTION_IDS,
  SECTION_LABELS,
  type BackupData,
  type BackupMode,
  type DataSectionId,
  type EntryProblem,
  type NaipManifest,
  type ProgressCallback,
  type SectionId
} from './types'
import { estimateBackupSize, selectedSections, writeNaipBackup, type SizeEstimate, type WriteBackupResult } from './write'

export const APP_VERSION: string = __APP_VERSION__

export interface CurrentData {
  data: BackupData
  /** 이 기기에서 불러오지 못해 data 에서 뺀 섹션 (IndexedDB 오류) */
  unavailable: DataSectionId[]
}

/**
 * 지금 앱의 데이터 (IndexedDB 에서 살아나는 스토어를 기다린 뒤).
 * - 아직 불러오는 중이면 멈춘다 — 그대로 모으면 바이브·레퍼런스·마스크가 빈 채로 백업(자동 백업 포함)되고,
 *   복원 계획도 빈 목록을 지금 데이터로 보고 세워져 복원이 지금 것을 덮어쓴다.
 * - 불러오기에 실패한 섹션(이번 실행 내내 빈 채다)은 빼고 모은다: 기다려도 나아지지 않으므로 백업·복원을
 *   통째로 막지 않는다. 백업은 그 섹션 없이 만들고(빈 목록으로 담지 않는다), 복원은 그 섹션을 건너뛴다(planFor).
 */
export async function currentData(timeoutMs = 15_000): Promise<CurrentData> {
  const { pending, failed } = await waitHydrated(timeoutMs)
  if (pending.length) {
    throw new Error('바이브·레퍼런스·마스크를 아직 불러오는 중입니다 — 잠시 뒤 다시 시도하세요')
  }
  const data = collectStoreData()
  for (const id of failed) delete data[id]
  return { data, unavailable: failed }
}

/** 불러오지 못한 섹션 안내 */
export function unavailableText(ids: readonly DataSectionId[]): string {
  return `이 기기의 ${ids.map((id) => SECTION_LABELS[id]).join('·')}을(를) 저장소에서 불러오지 못했습니다 (앱을 다시 시작하면 다시 불러옵니다)`
}

function without(data: BackupData, ids: readonly DataSectionId[]): BackupData {
  const out = { ...data }
  for (const id of ids) delete out[id]
  return out
}

async function ports() {
  const s = await getStorage()
  return {
    files: s.files,
    exportPort: historyExportPort(s),
    importPort: historyImportPort(s, { makeThumb: (blob) => makeThumb(blob) })
  }
}

// ── 백업 만들기 ─────────────────────────────────────────────────────────

export interface BackupChoice {
  mode: BackupMode
  /** custom 일 때 고른 섹션 */
  sections?: SectionId[]
}

export interface BackupEstimate {
  estimate: SizeEstimate
  /** 기기 남은 공간 (모르면 null) */
  free: number | null
  historyCount: number
  /** 섹션별 지금 항목 수 (고르기 화면용) */
  counts: Partial<Record<SectionId, number>>
  /** 고른 섹션 중 이 기기에서 불러오지 못해 백업에 넣지 못하는 것 */
  unavailable: DataSectionId[]
}

export async function estimateBackup(choice: BackupChoice): Promise<BackupEstimate> {
  const [{ data, unavailable }, p] = await Promise.all([currentData(), ports()])
  const [estimate, free, stats] = await Promise.all([
    estimateBackupSize(data, { ...choice, history: p.exportPort }),
    freeSpace(true),
    p.exportPort.stats()
  ])
  const counts: Partial<Record<SectionId, number>> = { history: stats.count, historyOriginals: stats.count }
  for (const id of DATA_SECTION_IDS) if (data[id] != null) counts[id] = countSection(id, data[id])
  const wanted = selectedSections(choice.mode, choice.sections)
  return { estimate, free, historyCount: stats.count, counts, unavailable: unavailable.filter((id) => wanted.includes(id)) }
}

/** 저장할 곳을 고르게 하고 백업을 쓴다. 고르기를 취소하면 null. 쓰다가 취소·실패하면 만든 파일을 지우고 BackupError */
export async function createBackupFile(
  choice: BackupChoice,
  opts: { onProgress?: ProgressCallback; signal?: AbortSignal; onFileChosen?: (name: string) => void } = {}
): Promise<{ fileName: string; result: WriteBackupResult; unavailable: DataSectionId[] } | null> {
  // 불러오지 못한 섹션은 빼고 쓴다 — 빈 목록으로 담으면 그 백업을 덮어쓰기로 복원할 때 지금 것이 지워진다
  const [{ data, unavailable }, p] = await Promise.all([currentData(), ports()])
  const file = await createFile(backupFileName(), BACKUP_MIME)
  if (!file) return null
  opts.onFileChosen?.(file.name)
  const result = await writeNaipBackup(data, file, {
    ...choice,
    appVersion: APP_VERSION,
    history: p.exportPort,
    onProgress: opts.onProgress,
    signal: opts.signal
  })
  const wanted = selectedSections(choice.mode, choice.sections)
  return { fileName: file.name, result, unavailable: unavailable.filter((id) => wanted.includes(id)) }
}

// ── 자동 백업 (복원 전) ──────────────────────────────────────────────────

export async function createSafetyBackup(note: string): Promise<SafetyBackup> {
  // 불러오지 못한 섹션은 담지 않는다 — 복원도 그 섹션을 건너뛰므로(planFor) 되돌릴 것이 없다
  const [{ data }, { files }] = await Promise.all([currentData(), ports()])
  const sink = safetySink(files, safetyName(), note)
  await writeNaipBackup(data, sink, { mode: 'light', appVersion: APP_VERSION })
  await pruneSafetyBackups(files).catch(() => 0)
  return sink.info!
}

export async function listSafety(): Promise<SafetyBackup[]> {
  return listSafetyBackups((await ports()).files)
}

export async function removeSafety(b: SafetyBackup): Promise<void> {
  await removeSafetyBackup((await ports()).files, b)
}

export async function safetyFile(b: SafetyBackup): Promise<{ name: string; source: ByteSource }> {
  return { name: `${b.name}.naipbackup`, source: safetySource((await ports()).files, b) }
}

/** 자동 백업을 기기의 다른 곳(다운로드 등)에 파일로 저장. 고르기를 취소하면 false */
export async function exportSafety(b: SafetyBackup): Promise<boolean> {
  const { source } = await safetyFile(b)
  const file = await createFile(`naip-${b.name}.naipbackup`, BACKUP_MIME)
  if (!file) return false
  try {
    for (let at = 0; at < source.size; ) {
      const chunk = await source.read(at, Math.min(1 << 20, source.size - at))
      if (!chunk.byteLength) throw new Error('자동 백업을 끝까지 읽지 못했습니다')
      await file.write(chunk)
      at += chunk.byteLength
    }
    await file.close()
    return true
  } catch (error) {
    await file.abort().catch(() => {})
    throw error
  }
}

// ── 복원할 파일 열기 ─────────────────────────────────────────────────────

export interface RestoreSource {
  kind: OpenedBackup['kind']
  fileName: string
  data: BackupData
  /** 무결성 문제 (체크섬이 틀린 항목·빠진 항목·.nais 그림 손상 등) */
  problems: EntryProblem[]
  /** 백업에 있었지만 손상돼 읽지 못한 섹션 (복원하지 않는다) */
  damaged: DataSectionId[]
  /** 이 앱이 모르는 섹션 (더 새로운 앱 또는 예전 생성 대기열) — 건너뛴다 */
  unknownSections: string[]
  /** NAIS3 변환 보고서 (.nais) */
  report: string[] | null
  manifest: NaipManifest | null
  reader: NaipBackupReader | null
  /** 백업 안의 히스토리 (.naipbackup 만) */
  history: { records: number; originals: number; originalBytes: number; damaged: boolean } | null
  close(): Promise<void>
}

export async function pickRestoreFile(): Promise<ReadableFile | null> {
  return pickFile({ accept: BACKUP_ACCEPT })
}

/** NAIS3 바이브·레퍼런스 그림 → NAIP 가 저장하는 모양 (refs 스토어와 같은 크기 제한) */
async function processNais3Image(bytes: Uint8Array, mime: string, kind: 'vibe' | 'charRef'): Promise<{ base64: string; thumb: string }> {
  const { base64 } = await toPngBase64(new Blob([bytes as BlobPart], { type: mime }), kind === 'vibe' ? 1536 : 2048)
  return { base64, thumb: await makeThumb(pngDataUrl(base64), 256) }
}

function dedupe(problems: EntryProblem[]): EntryProblem[] {
  const seen = new Set<string>()
  return problems.filter((p) => {
    const k = `${p.path}\u0000${p.kind}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * 파일 종류를 가려 열고, 복원 미리보기에 필요한 것을 모두 읽는다:
 * .naipbackup 은 모든 항목의 체크섬을 끝까지 확인(verify)하고 섹션을 읽는다(손상된 섹션은 빠진다),
 * .nais 는 NAIS3 변환 보고서를 만든다. 어느 쪽이든 캐릭터는 Phase 2 형식으로 옮긴다(normalizeBackupData).
 */
export async function openRestoreSource(
  file: { name: string; source: ByteSource; close?: () => Promise<void> },
  opts: { onProgress?: ProgressCallback; signal?: AbortSignal } = {}
): Promise<RestoreSource> {
  const close = async (): Promise<void> => {
    await file.close?.().catch(() => {})
  }
  try {
    const opened = await openAnyBackup(file.source, { signal: opts.signal })
    const base = { kind: opened.kind, fileName: file.name, unknownSections: [] as string[], report: null, manifest: null, reader: null, history: null, close }
    if (opened.kind === 'naip') {
      const reader = opened.reader
      const integrity = await reader.verify({ onProgress: opts.onProgress, signal: opts.signal })
      const { data, problems } = await reader.readData()
      const all = dedupe([...integrity.problems, ...problems])
      const damaged = DATA_SECTION_IDS.filter((id) => reader.manifest.sections.includes(id) && data[id] == null)
      let originalBytes = 0
      for (const path of reader.zip.paths()) if (path.startsWith('history/originals/')) originalBytes += reader.zip.entry(path).size
      const hasHistory = reader.manifest.sections.includes('history')
      return {
        ...base,
        data: normalizeBackupData(data),
        problems: all,
        damaged,
        unknownSections: reader.unknownSections,
        manifest: reader.manifest,
        reader,
        history: hasHistory
          ? {
              records: reader.manifest.counts.history ?? 0,
              originals: reader.manifest.sections.includes('historyOriginals') ? (reader.manifest.counts.historyOriginals ?? 0) : 0,
              originalBytes,
              damaged: all.some((p) => p.path.startsWith('history/'))
            }
          : null
      }
    }
    if (opened.kind === 'naip-json') {
      await close()
      return { ...base, data: normalizeBackupData(opened.data), problems: [], damaged: [] }
    }
    const { data, report } = await importNais3(opened.archive, { processImage: processNais3Image, newId: uid, signal: opts.signal })
    await close()
    return { ...base, data: normalizeBackupData(data), problems: report.problems, damaged: [], report: reportText(report) }
  } catch (error) {
    await close()
    throw error
  }
}

// ── 복원 계획 ───────────────────────────────────────────────────────────

export type HistoryChoice = 'skip' | 'merge' | 'replace'

export interface RestoreChoice {
  mode: RestoreMode
  /** selective 에서 섹션별 동작 */
  sections: Partial<Record<DataSectionId, SectionAction>>
  history: HistoryChoice
  /** 히스토리 원본 그림도 넣기 (백업에 있을 때) */
  originals: boolean
}

/** 미리보기 — 이 기기에서 불러오지 못한 섹션은 복원하지 않으므로 보여 주지 않는다 (planFor 가 경고를 단다) */
export async function previewFor(src: RestoreSource): Promise<SectionPreview[]> {
  const { data, unavailable } = await currentData()
  return previewRestore(data, without(src.data, unavailable))
}

/** 지금 데이터로 계획을 세운다 (확인 화면에 보여 주고, 그 계획 그대로 적용한다) */
export async function planFor(src: RestoreSource, choice: RestoreChoice): Promise<RestorePlan> {
  const sections: Partial<Record<SectionId, SectionAction>> = choice.mode === 'selective' ? { ...choice.sections } : {}
  const hasHistory = !!src.history && !!src.reader && choice.history !== 'skip'
  sections.history = choice.history === 'replace' ? 'overwrite' : choice.history === 'merge' ? 'merge' : 'skip'
  if (!choice.originals) sections.historyOriginals = 'skip'
  const { data, unavailable } = await currentData()
  // 불러오지 못한 섹션은 지금 것이 무엇인지 모른다 — 합치기·덮어쓰기 모두 저장된 것을 바꿔 쓰게 되므로 건너뛴다
  const blocked = unavailable.filter((id) => src.data[id] != null)
  const plan = planRestore(data, without(src.data, blocked), {
    mode: choice.mode,
    sections,
    newId: uid,
    hasHistory,
    hasOriginals: hasHistory && (src.history?.originals ?? 0) > 0,
    // 불러오지 못한 섹션을 가리키는 연결(프로젝트의 바이브·레퍼런스)은 끊지 않는다 — 백업에 그 섹션이 없어도
    unknown: unavailable
  })
  if (blocked.length) {
    plan.unavailable = blocked
    plan.warnings.unshift(`${unavailableText(blocked)} — 저장된 것을 덮어쓰지 않도록 백업의 그 항목은 복원하지 않습니다`)
  }
  return plan
}

/** 계획이 지금 데이터를 바꾸거나 지우는지 (자동 백업 경고용) */
/** 복원 뒤의 히스토리 보관 한도 (설정을 덮어쓰거나 합치면 그 결과의 값) — 0 = 제한 없음 */
export function historyLimitAfter(plan: RestorePlan): number {
  const v = plan.sections.settings?.result.historyLimit
  return typeof v === 'number' ? v : useSettings.getState().historyLimit
}

export function isDestructive(plan: RestorePlan): boolean {
  return (
    plan.history?.action === 'replace' ||
    Object.values(plan.sections).some((s) => s && s.action === 'overwrite' && s.stats.current > 0)
  )
}

// ── 복원 적용 ───────────────────────────────────────────────────────────

export interface RestoreSummary {
  safety: SafetyBackup | null
  applied: { section: DataSectionId; label: string; action: 'overwrite' | 'merge'; stats: SectionStats; notes: string[] }[]
  /** 백업에 있었지만 복원하지 않은 섹션과 이유 */
  skipped: { section: DataSectionId; label: string; reason: string }[]
  problems: EntryProblem[]
  history: SafeHistoryResult | null
  /** 히스토리 복원을 끝내지 못한 이유 (취소·오류) */
  historyError: string | null
  /** 복원한 프로젝트가 가리키는 그림 중 이 기기 히스토리에 없는 장수 */
  missingProjectImages: number
  warnings: string[]
}

export type RestorePhase = 'safety' | 'sections' | 'history' | 'finish'

/** 백업에서 들어온 프로젝트(합치기면 새로 더한 것만)가 가리키는 히스토리 id */
function projectImageIds(plan: RestorePlan): number[] {
  const out = new Set<number>()
  const section = plan.sections.projects
  const list = section?.result.projects
  if (!section || !Array.isArray(list)) return []
  const added = new Set(section.changes.filter((c) => c.kind === 'added' && c.collection === 'projects').map((c) => c.id))
  const incoming = section.action === 'overwrite' ? list : list.filter((p: { id?: unknown }) => added.has(p?.id as string))
  for (const p of incoming as { items?: Record<string, { images?: { id?: unknown }[] }> }[]) {
    for (const item of Object.values(p?.items ?? {})) {
      for (const img of item?.images ?? []) if (typeof img?.id === 'number') out.add(img.id)
    }
  }
  return [...out]
}

export async function applyRestore(
  src: RestoreSource,
  plan: RestorePlan,
  opts: { safety: boolean; onPhase?: (phase: RestorePhase) => void; onProgress?: ProgressCallback; signal?: AbortSignal }
): Promise<RestoreSummary> {
  const summary: RestoreSummary = {
    safety: null,
    applied: [],
    skipped: [],
    problems: [...src.problems],
    history: null,
    historyError: null,
    missingProjectImages: 0,
    warnings: [...plan.warnings]
  }
  // 1) 자동 백업 — 실패하면 아무것도 바꾸지 않고 멈춘다
  if (opts.safety) {
    opts.onPhase?.('safety')
    summary.safety = await createSafetyBackup(`${src.fileName} 복원 전`)
  }
  if (opts.signal?.aborted) throw new BackupError('aborted', '취소했습니다')

  // 2) 섹션 (빠르다 — 스토어에 한 번씩 넣는다)
  opts.onPhase?.('sections')
  const applied = new Set(applyRestorePlan(plan))
  for (const id of DATA_SECTION_IDS) {
    const s = plan.sections[id]
    if (s && applied.has(id)) summary.applied.push({ section: id, label: SECTION_LABELS[id], action: s.action, stats: s.stats, notes: s.notes })
    else if (src.data[id] != null)
      summary.skipped.push({
        section: id,
        label: SECTION_LABELS[id],
        reason: plan.unavailable?.includes(id) ? '이 기기의 지금 것을 불러오지 못함' : s ? '이 앱에 아직 넣을 곳이 없음' : '고르지 않음'
      })
  }
  for (const id of src.damaged) summary.skipped.push({ section: id, label: SECTION_LABELS[id], reason: '파일 손상 — 읽지 못함' })

  // 3) 히스토리 (오래 걸린다 — 기록은 페이지로, 원본은 한 장씩)
  const p = await ports()
  if (plan.history && src.reader) {
    opts.onPhase?.('history')
    try {
      summary.history = await restoreHistorySafely(src.reader, p.importPort, {
        mode: plan.history.action,
        originals: plan.history.originals,
        onProgress: opts.onProgress,
        signal: opts.signal
      })
      summary.problems.push(...summary.history.problems)
      // 바꾸기로 지운 그림은 프로젝트 조합에서도, 아직 옮기기가 끝나지 않은 이전 히스토리에서도 뺀다
      // (히스토리 화면에서 지울 때와 같게 — 그러지 않으면 다음 옮기기가 지운 그림을 다시 옮겨 온다)
      const removedIds = summary.history.removedIds ?? []
      if (removedIds.length) {
        await forgetLegacy(removedIds).catch((e: unknown) => console.warn('이전 히스토리에서 지우지 못했습니다', e))
        useProjects.getState().forgetImages(removedIds)
      }
    } catch (error) {
      summary.historyError =
        error instanceof BackupError && error.code === 'aborted'
          ? '히스토리 복원을 취소했습니다 — 그때까지 넣은 그림은 남고, 지금 히스토리는 지우지 않았습니다'
          : `히스토리 복원이 멈췄습니다: ${(error as Error).message} — 지금 히스토리는 지우지 않았습니다`
    }
  }

  // 4) 화면 새로 고침 + 프로젝트가 가리키는 그림 확인
  opts.onPhase?.('finish')
  await useHistory.getState().init().catch(() => {})
  // 보관 한도를 넘으면 다음 생성 때 오래된 그림이 지워진다 — 조용히 지워지지 않게 알린다
  const limit = useSettings.getState().historyLimit
  const total = useHistory.getState().total
  if (plan.history && limit > 0 && total > limit) {
    summary.warnings.push(
      `히스토리가 ${total.toLocaleString()}장으로 보관 한도(${limit.toLocaleString()}장)를 넘었습니다 — 다음 생성 때 즐겨찾기를 뺀 오래된 그림부터 앱에서 지워집니다. 지우지 않으려면 설정 → 저장 → 히스토리 보관 한도를 늘리세요.`
    )
  }
  const ids = projectImageIds(plan)
  if (ids.length) {
    try {
      const have = await p.importPort.existingIds(ids)
      summary.missingProjectImages = ids.length - have.size
    } catch {
      /* 확인만 못 했을 뿐 복원은 끝났다 */
    }
  }
  summary.problems = dedupe(summary.problems)
  await src.close().catch(() => {})
  return summary
}

// ── NAIS3 로 내보내기 ────────────────────────────────────────────────────

export async function nais3Plan(sections: readonly Nais3ExportSection[]): Promise<{ data: BackupData; plan: Nais3ExportPlan }> {
  const { data, unavailable } = await currentData()
  const plan = naipToNais3(data, { sections })
  const missed = unavailable.filter((id) => (sections as readonly string[]).includes(id))
  for (const id of missed) plan.lost.unshift({ scope: SECTION_LABELS[id], text: '이 기기에서 불러오지 못해 내보내지 않음 (앱을 다시 시작하면 다시 불러옵니다)' })
  return { data, plan }
}

export async function writeNais3File(
  data: BackupData,
  sections: readonly Nais3ExportSection[],
  signal?: AbortSignal
): Promise<{ fileName: string; bytes: number } | null> {
  const name = backupFileName(new Date(), 'naip-nais3').replace(/\.naipbackup$/, '.nais')
  const file = await createFile(name, 'application/octet-stream')
  if (!file) return null
  const r = await exportNais3(data, file, { appVersion: APP_VERSION, sections, signal })
  return { fileName: file.name, bytes: r.bytes }
}
