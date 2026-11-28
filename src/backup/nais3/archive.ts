/**
 * NAIS3 .nais 읽기·쓰기 — NAIS3 (© sunanakgo, GPL-3.0) src/main/backup/archive.ts 의 readNaisArchive /
 * writeNaisArchive 를 옮겼다. 같은 검사(형식·버전·표 목록·체크섬·행 개수·값 모양·자산 경로)를 하되,
 * - ZIP 은 임의 접근으로 읽어 전체를 메모리에 올리지 않고 zip-slip·zip-bomb 검사를 먼저 한다 (zip/reader.ts)
 * - 그림은 필요할 때 한 개씩 읽는다 (라이브러리 그림처럼 가져오지 않을 것은 아예 읽지 않는다)
 * - 체크섬이 틀린 표·그림은 전체를 실패시키지 않고 항목별 문제로 모은다 (가져오기 보고서에 남는다)
 * 레거시 NAIS3 JSON 백업(_app:'NAIS3') 도 같은 모양으로 연다 (src/main/backup/legacy.ts).
 */
import { fromBase64, utf8 } from '../bytes'
import { Sha256 } from '../hash'
import type { ByteSink, ByteSource } from '../io'
import { BufferedSink } from '../io'
import { parseJson } from '../read'
import { BackupError, type EntryProblem } from '../types'
import { unsafePathReason } from '../zip/paths'
import { ZipReader, type ZipLimits } from '../zip/reader'
import { ZipWriter } from '../zip/writer'
import {
  isNais3Table,
  NAIS3_FILE_TABLES,
  NAIS3_FORMAT_VERSION,
  NAIS3_TABLES,
  type Nais3AssetRef,
  type Nais3Manifest,
  type Nais3Row,
  type Nais3Table
} from './types'

export interface Nais3Archive {
  manifest: Nais3Manifest
  /** 읽어 낸 표 (손상된 표는 빠지고 problems 에 남는다). BLOB·파일 열은 Nais3AssetRef */
  tables: Partial<Record<Nais3Table, Nais3Row[]>>
  mainParams: string | null
  problems: EntryProblem[]
  /** 그림·BLOB 을 체크섬을 확인하며 읽는다. 없거나 손상되면 null (문제는 problems 에) */
  readAsset(path: string): Promise<Uint8Array | null>
}

export function isNais3AssetRef(value: unknown): value is Nais3AssetRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value)
  return entries.length === 1 && entries[0][0] === '__asset' && typeof entries[0][1] === 'string'
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** NAIS3 manifest 검사 (archive.ts readNaisArchive 와 같은 조건) */
export function validateNais3Manifest(raw: unknown): Nais3Manifest {
  if (!isObj(raw)) throw new BackupError('invalid-manifest', 'manifest.json 형식이 잘못됐습니다')
  if (raw.format === 'NAIP') throw new BackupError('not-naip', 'NAIP 백업입니다. "백업 불러오기"로 여세요')
  if (raw.format !== 'NAIS' || raw.app !== 'NAIS3') throw new BackupError('not-naip', 'NAIS3 백업(.nais)이 아닙니다')
  if (raw.formatVersion !== NAIS3_FORMAT_VERSION) {
    const v = raw.formatVersion
    throw new BackupError(
      'unsupported-version',
      typeof v === 'number' && v > NAIS3_FORMAT_VERSION
        ? `더 새로운 NAIS3 백업 형식(버전 ${v})이라 읽을 수 없습니다 (지원: 버전 ${NAIS3_FORMAT_VERSION})`
        : `지원하지 않는 NAIS3 백업 형식 버전입니다: ${JSON.stringify(v)}`
    )
  }
  if (!Array.isArray(raw.tables) || !raw.tables.every(isNais3Table)) {
    throw new BackupError('invalid-manifest', 'manifest.json 의 표 목록이 잘못됐습니다')
  }
  if (new Set(raw.tables).size !== raw.tables.length) throw new BackupError('invalid-manifest', 'manifest.json 에 같은 표가 두 번 있습니다')
  const tableCounts: Partial<Record<Nais3Table, number>> = {}
  if (isObj(raw.tableCounts)) {
    for (const [k, n] of Object.entries(raw.tableCounts)) if (isNais3Table(k) && typeof n === 'number') tableCounts[k] = n
  }
  return {
    format: 'NAIS',
    formatVersion: NAIS3_FORMAT_VERSION,
    app: 'NAIS3',
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    scope: 'workspace',
    tables: [...(raw.tables as Nais3Table[])],
    tableCounts
  }
}

export async function readNaisArchive(source: ByteSource, opts: { limits?: Partial<ZipLimits>; signal?: AbortSignal } = {}): Promise<Nais3Archive> {
  const zip = await ZipReader.open(source, opts.limits)
  if (!zip.has('manifest.json')) throw new BackupError('not-naip', 'NAIS3 백업(.nais)이 아닙니다 (manifest.json 없음)')
  const manifest = validateNais3Manifest(parseJson(await zip.read('manifest.json', { maxSize: 1 << 20 }), 'manifest.json'))
  if (!zip.has('checksums.json')) throw new BackupError('missing-entry', '체크섬 목록(checksums.json)이 없습니다', 'checksums.json')
  const rawChecksums = parseJson(await zip.read('checksums.json', { maxSize: 64 << 20 }), 'checksums.json')
  if (!isObj(rawChecksums)) throw new BackupError('invalid-manifest', 'checksums.json 형식이 잘못됐습니다')
  const checksums = rawChecksums as Record<string, unknown>
  const problems: EntryProblem[] = []

  async function readChecked(path: string): Promise<Uint8Array | null> {
    const reason = unsafePathReason(path)
    if (reason) {
      problems.push({ path, kind: 'corrupt', detail: `안전하지 않은 경로 (${reason})` })
      return null
    }
    const expected = checksums[path]
    if (!isObj(expected) || typeof expected.sha256 !== 'string' || typeof expected.bytes !== 'number' || expected.bytes < 0) {
      problems.push({ path, kind: 'unlisted', detail: '체크섬 정보가 없거나 잘못됐습니다' })
      return null
    }
    if (!zip.has(path)) {
      problems.push({ path, kind: 'missing', detail: '아카이브에 없습니다' })
      return null
    }
    try {
      const data = await zip.read(path, { signal: opts.signal })
      if (data.byteLength !== expected.bytes || new Sha256().update(data).digestHex() !== expected.sha256) {
        problems.push({ path, kind: 'checksum-mismatch', detail: '체크섬이 맞지 않습니다 (손상되었거나 바뀐 파일)' })
        return null
      }
      return data
    } catch (error) {
      if (error instanceof BackupError && error.code === 'aborted') throw error
      problems.push({ path, kind: 'corrupt', detail: (error as Error).message })
      return null
    }
  }

  let mainParams: string | null = null
  const settingsBytes = await readChecked('data/settings.json')
  if (settingsBytes) {
    try {
      const settings = parseJson(settingsBytes, 'data/settings.json')
      if (!isObj(settings) || (settings.mainParams !== null && settings.mainParams !== undefined && typeof settings.mainParams !== 'string')) {
        throw new Error('mainParams 가 잘못됐습니다')
      }
      mainParams = (settings.mainParams as string | null | undefined) ?? null
    } catch (error) {
      problems.push({ path: 'data/settings.json', kind: 'invalid-json', detail: (error as Error).message })
    }
  }

  const tables: Nais3Archive['tables'] = {}
  for (const table of manifest.tables) {
    const path = `data/tables/${table}.json`
    const bytes = await readChecked(path)
    if (!bytes) continue
    let parsed: unknown
    try {
      parsed = parseJson(bytes, path)
    } catch (error) {
      problems.push({ path, kind: 'invalid-json', detail: (error as Error).message })
      continue
    }
    if (!Array.isArray(parsed)) {
      problems.push({ path, kind: 'invalid-json', detail: '행 배열이 아닙니다' })
      continue
    }
    if (manifest.tableCounts[table] !== parsed.length) {
      problems.push({ path, kind: 'corrupt', detail: `행 수가 manifest 와 다릅니다 (${parsed.length} ≠ ${String(manifest.tableCounts[table])})` })
      continue
    }
    const rows: Nais3Row[] = []
    const seen = new Set<number>()
    for (const [i, value] of parsed.entries()) {
      if (!isObj(value)) {
        problems.push({ path, kind: 'invalid-json', detail: `${i + 1}번째 행이 객체가 아닙니다` })
        continue
      }
      const row: Nais3Row = {}
      let bad: string | null = null
      for (const [column, v] of Object.entries(value)) {
        if (isNais3AssetRef(v)) {
          if (!v.__asset.startsWith('assets/') || unsafePathReason(v.__asset)) bad = `${column} 의 자산 경로가 잘못됐습니다`
          row[column] = { __asset: v.__asset }
        } else if (v === null || typeof v === 'string' || typeof v === 'number') {
          row[column] = v
        } else {
          bad = `${column} 값이 잘못됐습니다`
        }
      }
      if (typeof row.id !== 'number') bad ??= '숫자 id 가 없습니다'
      // NAIS3 는 id 가 겹치는 표를 받지 않는다 (PRIMARY KEY) — 두 행이 한 NAIP 항목으로 합쳐지지 않게 뒤의 것은 건너뛴다
      else if (seen.has(row.id)) bad ??= `id ${row.id} 인 행이 이미 있습니다 — 건너뜁니다`
      if (bad) {
        problems.push({ path, kind: 'invalid-json', detail: `${i + 1}번째 행: ${bad}` })
        continue
      }
      seen.add(row.id as number)
      rows.push(row)
    }
    tables[table] = rows
  }

  return { manifest, tables, mainParams, problems, readAsset: readChecked }
}

// ── 레거시 NAIS3 JSON ───────────────────────────────────────────────────

const LEGACY_TABLES = NAIS3_TABLES.filter((t) => t !== 'library_stacks' && t !== 'library_images')

/** NAIS3 의 예전 JSON 백업 (_app:'NAIS3', tables, __blob / __image) — .nais 와 같은 모양으로 */
export function nais3ArchiveFromLegacyJson(raw: unknown): Nais3Archive {
  if (!isObj(raw) || raw._app !== 'NAIS3') throw new BackupError('not-naip', 'NAIS3 JSON 백업이 아닙니다')
  if (typeof raw._version === 'number' && raw._version > 1) {
    throw new BackupError('unsupported-version', `더 새로운 NAIS3 JSON 백업(버전 ${raw._version})입니다`)
  }
  if (!isObj(raw.tables)) throw new BackupError('invalid-manifest', 'NAIS3 JSON 백업에 표가 없습니다')
  const assets = new Map<string, Uint8Array>()
  const problems: EntryProblem[] = []
  const tables: Nais3Archive['tables'] = {}
  const included: Nais3Table[] = []
  for (const table of LEGACY_TABLES) {
    const src = raw.tables[table]
    if (!Array.isArray(src)) continue
    included.push(table)
    const rows: Nais3Row[] = []
    const seen = new Set<number>()
    for (const value of src) {
      if (!isObj(value) || typeof value.id !== 'number') {
        problems.push({ path: `tables.${table}`, kind: 'invalid-json', detail: '잘못된 행을 건너뜁니다' })
        continue
      }
      if (seen.has(value.id)) {
        problems.push({ path: `tables.${table}`, kind: 'invalid-json', detail: `id ${value.id} 인 행이 이미 있습니다 — 건너뜁니다` })
        continue
      }
      seen.add(value.id)
      const row: Nais3Row = {}
      for (const [column, v] of Object.entries(value)) {
        if (column === '__image') continue
        if (isObj(v) && typeof v.__blob === 'string' && Object.keys(v).length === 1) {
          const path = `assets/blobs/${table}/${value.id}-${column}.bin`
          assets.set(path, fromBase64(v.__blob))
          row[column] = { __asset: path }
        } else if (v === null || typeof v === 'string' || typeof v === 'number') {
          row[column] = v
        }
      }
      if (NAIS3_FILE_TABLES.has(table)) {
        const ext = (typeof value.file_path === 'string' && /\.[a-z0-9]{1,10}$/i.exec(value.file_path)?.[0]) || '.bin'
        const path = `assets/files/${table}/${value.id}${ext.toLowerCase()}`
        if (typeof value.__image === 'string') {
          assets.set(path, fromBase64(value.__image))
          row.file_path = { __asset: path }
        } else {
          row.file_path = ''
          problems.push({ path, kind: 'missing', detail: '예전 백업에 원본 그림이 없습니다' })
        }
      }
      rows.push(row)
    }
    tables[table] = rows
  }
  const mainParams = typeof raw.mainParams === 'string' ? raw.mainParams : null
  return {
    manifest: {
      format: 'NAIS',
      formatVersion: NAIS3_FORMAT_VERSION,
      app: 'NAIS3',
      appVersion: '',
      createdAt: '',
      scope: 'workspace',
      tables: included,
      tableCounts: Object.fromEntries(included.map((t) => [t, tables[t]?.length ?? 0]))
    },
    tables,
    mainParams,
    problems,
    readAsset: async (path) => assets.get(path) ?? null
  }
}

// ── 쓰기 ───────────────────────────────────────────────────────────────

/** file_path 열에 넣을 원본 (확장자 포함, 예: '.png', '.nais3vibe') */
export interface Nais3OutFile {
  file: Uint8Array
  ext: string
}

export type Nais3OutValue = string | number | null | Uint8Array | Nais3OutFile
export type Nais3OutRow = Record<string, Nais3OutValue>

export interface Nais3Output {
  includedTables: Nais3Table[]
  tables: Partial<Record<Nais3Table, Nais3OutRow[]>>
  mainParams: string | null
}

function safeSegment(value: string | number): string {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_') || 'item'
}

function safeExtension(value: string): string {
  const extension = (value.startsWith('.') ? value : `.${value}`).toLowerCase()
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '.bin'
}

function jsonBytes(value: unknown): Uint8Array {
  return utf8(`${JSON.stringify(value, null, 2)}\n`)
}

function isOutFile(v: unknown): v is Nais3OutFile {
  return !!v && typeof v === 'object' && !(v instanceof Uint8Array) && (v as Nais3OutFile).file instanceof Uint8Array
}

/**
 * NAIS3 가 읽을 수 있는 .nais 를 쓴다 (writeNaisArchive 와 같은 배치·순서: 표마다 그림 → 표 JSON,
 * 끝에 data/settings.json · manifest.json · checksums.json).
 */
export async function writeNaisArchive(
  out: Nais3Output,
  sink: ByteSink,
  opts: { appVersion: string; createdAt?: string; signal?: AbortSignal }
): Promise<{ bytes: number; tableCounts: Partial<Record<Nais3Table, number>> }> {
  const buffered = new BufferedSink(sink)
  const createdAt = opts.createdAt ?? new Date().toISOString()
  const zip = new ZipWriter(buffered, { date: new Date(createdAt), signal: opts.signal })
  const checksums: Record<string, { sha256: string; bytes: number }> = {}
  const tableCounts: Partial<Record<Nais3Table, number>> = {}
  const add = async (path: string, data: Uint8Array, compress: boolean): Promise<void> => {
    const r = await zip.add({ path, data, compress })
    checksums[path] = { sha256: r.sha256, bytes: r.size }
  }
  try {
    for (const table of out.includedTables) {
      const rows = out.tables[table]
      if (!Array.isArray(rows)) throw new Error(`표가 없습니다: ${table}`)
      const encodedRows: Record<string, unknown>[] = []
      for (const row of rows) {
        const rowId = row.id
        if (typeof rowId !== 'number') throw new Error(`${table} 행에 숫자 id 가 없습니다`)
        const encoded: Record<string, unknown> = {}
        for (const [column, value] of Object.entries(row)) {
          if (isOutFile(value)) {
            const path = `assets/files/${table}/${safeSegment(rowId)}${safeExtension(value.ext)}`
            await add(path, value.file, false)
            encoded[column] = { __asset: path }
          } else if (value instanceof Uint8Array) {
            const path = `assets/blobs/${table}/${safeSegment(rowId)}-${safeSegment(column)}.bin`
            await add(path, value, false)
            encoded[column] = { __asset: path }
          } else {
            encoded[column] = value
          }
        }
        encodedRows.push(encoded)
      }
      tableCounts[table] = encodedRows.length
      await add(`data/tables/${table}.json`, jsonBytes(encodedRows), true)
    }
    await add('data/settings.json', jsonBytes({ mainParams: out.mainParams }), true)
    const manifest: Nais3Manifest = {
      format: 'NAIS',
      formatVersion: NAIS3_FORMAT_VERSION,
      app: 'NAIS3',
      appVersion: opts.appVersion,
      createdAt,
      scope: 'workspace',
      tables: [...out.includedTables],
      tableCounts
    }
    await zip.add({ path: 'manifest.json', data: jsonBytes(manifest), compress: true })
    await zip.add({ path: 'checksums.json', data: jsonBytes(checksums), compress: true })
    const bytes = await zip.finish()
    await buffered.close()
    return { bytes, tableCounts }
  } catch (error) {
    await buffered.abort().catch(() => {})
    if (error instanceof BackupError) throw error
    throw new BackupError('write-failed', `.nais 를 쓰지 못했습니다: ${(error as Error).message}`)
  }
}
