/**
 * .naipbackup 읽기 — 구조 검사(zip-slip·zip-bomb·중복)는 ZipReader 가, 형식 버전·체크섬은 여기서.
 * 체크섬이 틀린 항목은 예외로 끝내지 않고 항목별 문제로 모은다: 손상된 섹션은 빼고, 손상된 그림은
 * 비운 채 어느 항목인지 알려 준다 (복원 미리보기에서 사용자가 보고 고른다).
 */
import { fromUtf8 } from './bytes'
import { stripCredentials } from './credentials'
import { CHECKSUMS_PATH, HISTORY_PAGE_RE, inlineAssets, MANIFEST_PATH, sectionPath } from './format'
import { Sha256 } from './hash'
import type { HistoryLine } from './history'
import type { ByteSource } from './io'
import {
  BackupError,
  DATA_SECTION_IDS,
  isSectionId,
  NAIP_FORMAT,
  NAIP_FORMAT_VERSION,
  SECTION_LABELS,
  throwIfAborted,
  type BackupData,
  type Checksums,
  type DataSectionId,
  type EntryProblem,
  type NaipManifest,
  type ProgressCallback,
  type SectionId
} from './types'
import { ZipReader, type ZipLimits } from './zip/reader'

const MAX_MANIFEST = 1024 * 1024
const MAX_CHECKSUMS = 64 * 1024 * 1024
/** 섹션 JSON·히스토리 페이지 한 개의 상한 (그림은 따로 빠져 있어 이보다 훨씬 작다) */
const MAX_JSON_ENTRY = 128 * 1024 * 1024

export interface OpenBackupOptions {
  limits?: Partial<ZipLimits>
  signal?: AbortSignal
}

export function parseJson(bytes: Uint8Array, path: string): unknown {
  try {
    return JSON.parse(fromUtf8(bytes)) as unknown
  } catch (error) {
    throw new BackupError('invalid-json', `${path} 를 읽을 수 없습니다: ${(error as Error).message}`, path)
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** manifest 검사 — 모르는(더 새로운) 형식 버전은 분명한 오류로 */
export function validateManifest(raw: unknown): { manifest: NaipManifest; unknownSections: string[] } {
  if (!isObject(raw)) throw new BackupError('invalid-manifest', 'manifest.json 형식이 잘못됐습니다')
  if (raw.format === 'NAIS') {
    throw new BackupError('is-nais3', 'NAIS3 백업(.nais)입니다. "NAIS3에서 가져오기"로 여세요')
  }
  if (raw.format !== NAIP_FORMAT) throw new BackupError('not-naip', 'NAIP 백업 파일이 아닙니다')
  const v = raw.formatVersion
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new BackupError('invalid-manifest', `백업 형식 버전을 알 수 없습니다: ${JSON.stringify(v)}`)
  }
  if (v > NAIP_FORMAT_VERSION) {
    throw new BackupError(
      'unsupported-version',
      `이 백업은 더 새로운 NAIP 에서 만든 형식(버전 ${v})입니다. 이 앱은 버전 ${NAIP_FORMAT_VERSION}까지 읽을 수 있습니다 — 앱을 업데이트한 뒤 다시 시도하세요`
    )
  }
  if (!Array.isArray(raw.sections) || !raw.sections.every((s) => typeof s === 'string')) {
    throw new BackupError('invalid-manifest', 'manifest.json 의 섹션 목록이 잘못됐습니다')
  }
  if (new Set(raw.sections).size !== raw.sections.length) {
    throw new BackupError('invalid-manifest', 'manifest.json 에 같은 섹션이 두 번 있습니다')
  }
  const sections = (raw.sections as string[]).filter(isSectionId)
  const unknownSections = (raw.sections as string[]).filter((s) => !isSectionId(s))
  const counts: Partial<Record<SectionId, number>> = {}
  if (isObject(raw.counts)) {
    for (const [k, n] of Object.entries(raw.counts)) if (isSectionId(k) && typeof n === 'number') counts[k] = n
  }
  const mode = raw.mode === 'light' || raw.mode === 'full' || raw.mode === 'custom' ? raw.mode : 'custom'
  return {
    manifest: {
      format: NAIP_FORMAT,
      formatVersion: v,
      app: 'NAIP',
      appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : '',
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
      mode,
      sections,
      counts
    },
    unknownSections
  }
}

function validateChecksums(raw: unknown): Checksums {
  if (!isObject(raw)) throw new BackupError('invalid-manifest', 'checksums.json 형식이 잘못됐습니다')
  const out: Checksums = {}
  for (const [path, v] of Object.entries(raw)) {
    if (!isObject(v) || typeof v.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.sha256) || typeof v.size !== 'number' || v.size < 0) {
      throw new BackupError('invalid-manifest', `checksums.json 의 ${path} 항목이 잘못됐습니다`, path)
    }
    out[path] = { sha256: v.sha256, size: v.size }
  }
  return out
}

export interface IntegrityReport {
  ok: boolean
  checked: number
  problems: EntryProblem[]
}

export interface NaipBackupReader {
  readonly manifest: NaipManifest
  /** 이 앱이 모르는 섹션 (더 새로운 버전에서 추가된 것) — 건너뛴다 */
  readonly unknownSections: string[]
  readonly checksums: Checksums
  readonly zip: ZipReader
  /** 열 때 찾은 구조 문제 (checksums 에 없는 항목, 목록에만 있고 없는 항목) */
  readonly structuralProblems: EntryProblem[]
  /** 섹션 데이터 읽기 — 손상된 섹션은 빠지고 problems 에 들어간다 */
  readData(sections?: readonly DataSectionId[]): Promise<{ data: BackupData; problems: EntryProblem[]; removedCredentials: string[] }>
  /** 히스토리 기록을 페이지 단위로 (손상된 페이지는 onProblem 으로 알리고 건너뛴다) */
  historyPages(onProblem?: (p: EntryProblem) => void): AsyncGenerator<HistoryLine[]>
  /** 체크섬을 확인한 원본 바이트 */
  readOriginal(path: string): Promise<Uint8Array>
  /** 모든 항목의 체크섬을 끝까지 확인 (항목별 결과) */
  verify(opts?: { onProgress?: ProgressCallback; signal?: AbortSignal }): Promise<IntegrityReport>
}

export async function openNaipBackup(source: ByteSource, opts: OpenBackupOptions = {}): Promise<NaipBackupReader> {
  const zip = await ZipReader.open(source, opts.limits)
  if (!zip.has(MANIFEST_PATH)) throw new BackupError('not-naip', 'NAIP 백업 파일이 아닙니다 (manifest.json 없음)')
  const { manifest, unknownSections } = validateManifest(parseJson(await zip.read(MANIFEST_PATH, { maxSize: MAX_MANIFEST }), MANIFEST_PATH))
  if (!zip.has(CHECKSUMS_PATH)) throw new BackupError('missing-entry', '체크섬 목록(checksums.json)이 없습니다', CHECKSUMS_PATH)
  const checksums = validateChecksums(parseJson(await zip.read(CHECKSUMS_PATH, { maxSize: MAX_CHECKSUMS }), CHECKSUMS_PATH))

  const structuralProblems: EntryProblem[] = []
  for (const path of zip.paths()) {
    if (path === MANIFEST_PATH || path === CHECKSUMS_PATH) continue
    if (!checksums[path]) structuralProblems.push({ path, kind: 'unlisted', detail: '체크섬 목록에 없는 항목 — 읽지 않습니다' })
  }
  for (const path of Object.keys(checksums)) {
    if (!zip.has(path)) structuralProblems.push({ path, kind: 'missing', detail: '체크섬 목록에는 있지만 파일에 없습니다' })
  }

  /** 체크섬을 확인하며 항목을 읽는다. 실패하면 문제를 돌려준다 */
  async function readVerified(path: string, signal?: AbortSignal, maxSize?: number): Promise<{ bytes: Uint8Array } | { problem: EntryProblem }> {
    const expected = checksums[path]
    if (!expected) return { problem: { path, kind: 'unlisted', detail: '체크섬 목록에 없는 항목' } }
    if (!zip.has(path)) return { problem: { path, kind: 'missing', detail: '파일에 없습니다' } }
    if (maxSize !== undefined && zip.entry(path).size > maxSize) {
      return { problem: { path, kind: 'corrupt', detail: `JSON 항목이 너무 큽니다 (${Math.round(zip.entry(path).size / 1048576)}MB)` } }
    }
    if (zip.entry(path).size !== expected.size) {
      return { problem: { path, kind: 'checksum-mismatch', detail: `크기가 다릅니다 (${zip.entry(path).size} ≠ ${expected.size})` } }
    }
    try {
      const bytes = await zip.read(path, { signal })
      const actual = new Sha256().update(bytes).digestHex()
      if (actual !== expected.sha256) return { problem: { path, kind: 'checksum-mismatch', detail: 'SHA-256 이 다릅니다 (손상되었거나 바뀐 파일)' } }
      return { bytes }
    } catch (error) {
      if (error instanceof BackupError && error.code === 'aborted') throw error
      return { problem: { path, kind: 'corrupt', detail: (error as Error).message } }
    }
  }

  return {
    manifest,
    unknownSections,
    checksums,
    zip,
    structuralProblems,

    async readData(wanted) {
      const problems: EntryProblem[] = []
      const removedCredentials: string[] = []
      const data: BackupData = {}
      const ids = DATA_SECTION_IDS.filter((id) => manifest.sections.includes(id) && (!wanted || wanted.includes(id)))
      for (const id of ids) {
        throwIfAborted(opts.signal)
        const path = sectionPath(id)
        const got = await readVerified(path, opts.signal, MAX_JSON_ENTRY)
        if ('problem' in got) {
          problems.push({ ...got.problem, detail: `${SECTION_LABELS[id]}: ${got.problem.detail} — 이 항목은 복원할 수 없습니다` })
          continue
        }
        let parsed: unknown
        try {
          parsed = parseJson(got.bytes, path)
        } catch (error) {
          problems.push({ path, kind: 'invalid-json', detail: `${SECTION_LABELS[id]}: ${(error as Error).message}` })
          continue
        }
        const stripped = stripCredentials(parsed, id)
        removedCredentials.push(...stripped.removed)
        const value = await inlineAssets(
          id,
          stripped.value,
          async (assetPath) => {
            const a = await readVerified(assetPath, opts.signal)
            if ('problem' in a) {
              problems.push(a.problem)
              return null
            }
            return a.bytes
          },
          ({ item, path: assetPath }) => {
            const label = typeof item?.name === 'string' ? `"${item.name}"` : `id ${String(item?.id)}`
            problems.push({ path: assetPath, kind: 'missing', detail: `${SECTION_LABELS[id]} ${label}의 그림을 읽지 못해 비워 둡니다` })
          }
        )
        ;(data as Record<string, unknown>)[id] = value
      }
      return { data, problems, removedCredentials }
    },

    async *historyPages(onProblem) {
      if (!manifest.sections.includes('history')) return
      const pages = zip
        .paths()
        .filter((p) => HISTORY_PAGE_RE.test(p))
        .sort()
      for (const path of pages) {
        throwIfAborted(opts.signal)
        const got = await readVerified(path, opts.signal, MAX_JSON_ENTRY)
        if ('problem' in got) {
          onProblem?.(got.problem)
          continue
        }
        const lines: HistoryLine[] = []
        let text: string
        try {
          text = fromUtf8(got.bytes)
        } catch {
          onProblem?.({ path, kind: 'invalid-json', detail: 'UTF-8 이 아닙니다' })
          continue
        }
        for (const [i, line] of text.split('\n').entries()) {
          if (!line.trim()) continue
          try {
            const v = JSON.parse(line) as HistoryLine
            if (!isObject(v) || !isObject(v.record) || typeof v.record.id !== 'number') throw new Error('기록 모양이 아닙니다')
            const original = typeof v.original === 'string' && v.original.startsWith('history/originals/') ? v.original : null
            lines.push({ record: stripCredentials(v.record).value, original })
          } catch (error) {
            onProblem?.({ path, kind: 'invalid-json', detail: `${i + 1}번째 줄: ${(error as Error).message}` })
          }
        }
        yield lines
      }
    },

    async readOriginal(path) {
      if (!path.startsWith('history/originals/')) throw new BackupError('unsafe-path', `원본 경로가 아닙니다: ${path}`, path)
      const got = await readVerified(path, opts.signal)
      if ('problem' in got) throw new BackupError('checksum-mismatch', `${path}: ${got.problem.detail}`, path)
      return got.bytes
    },

    async verify(vopts = {}) {
      const problems: EntryProblem[] = [...structuralProblems]
      const paths = Object.keys(checksums).filter((p) => zip.has(p))
      let bytes = 0
      let done = 0
      for (const path of paths) {
        throwIfAborted(vopts.signal)
        const expected = checksums[path]
        const sha = new Sha256()
        let size = 0
        try {
          for await (const chunk of zip.chunks(path, vopts.signal)) {
            sha.update(chunk)
            size += chunk.byteLength
          }
          if (size !== expected.size || sha.digestHex() !== expected.sha256) {
            problems.push({ path, kind: 'checksum-mismatch', detail: '체크섬이 맞지 않습니다 (손상되었거나 바뀐 파일)' })
          }
        } catch (error) {
          if (error instanceof BackupError && error.code === 'aborted') throw error
          problems.push({ path, kind: 'corrupt', detail: (error as Error).message })
        }
        bytes += size
        done++
        vopts.onProgress?.({ phase: 'verify', done, total: paths.length, bytes, current: path })
      }
      return { ok: problems.length === 0, checked: done, problems }
    }
  }
}
