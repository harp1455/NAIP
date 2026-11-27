/// <reference types="node" />
/**
 * NAIS3 의 실제 .nais 읽기 코드 — NAIS3 (© sunanakgo, GPL-3.0) src/main/backup/archive.ts 의
 * readNaisArchive 와 src/main/backup/repo.ts 의 validateRows 를 거의 그대로 옮겼다 (JSZip + Node crypto).
 * NAIP 가 내보낸 .nais 를 NAIS3 가 정말 받아들이는지 시험에서 확인하는 데만 쓴다.
 */
import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { NAIS3_COLUMNS, NAIS3_TABLES, type Nais3Table } from '../../src/backup/nais3/types'

const MAX_ARCHIVE_ENTRIES = 100_000
const MAX_ENTRY_BYTES = 256 * 1024 * 1024
const MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024

type BackupRow = Record<string, string | number | null | Buffer>
interface Checksums {
  [path: string]: { sha256: string; bytes: number }
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function assertSafeArchivePath(value: string): void {
  if (
    !value ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.startsWith('/') ||
    /^[a-zA-Z]:/.test(value) ||
    value.split('/').some((part) => part === '..')
  ) {
    throw new Error(`Unsafe archive path: ${value}`)
  }
}

function isAssetReference(value: unknown): value is { __asset: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value)
  return entries.length === 1 && entries[0][0] === '__asset' && typeof entries[0][1] === 'string'
}

function parseJsonObject<T>(data: Buffer, label: string): T {
  const parsed = JSON.parse(data.toString('utf-8')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} root value must be an object`)
  return parsed as T
}

function isBackupTableName(value: unknown): value is Nais3Table {
  return typeof value === 'string' && (NAIS3_TABLES as readonly string[]).includes(value)
}

export async function nais3ReadNaisArchive(input: Buffer): Promise<{
  includedTables: Nais3Table[]
  tables: Partial<Record<Nais3Table, BackupRow[]>>
  mainParams: string | null
  files: { table: Nais3Table; rowId: number; extension: string; data: Buffer }[]
}> {
  const zip = await JSZip.loadAsync(input)
  const entries = Object.values(zip.files)
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error('Archive contains too many entries')
  for (const entry of entries) {
    assertSafeArchivePath((entry as unknown as { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name)
    assertSafeArchivePath(entry.name)
  }
  async function readRaw(path: string): Promise<Buffer> {
    assertSafeArchivePath(path)
    const entry = zip.file(path)
    if (!entry) throw new Error(`Archive entry is missing: ${path}`)
    const data = await entry.async('nodebuffer')
    if (data.byteLength > MAX_ENTRY_BYTES) throw new Error(`Archive entry is too large: ${path}`)
    return data
  }
  const manifest = parseJsonObject<{ format: string; app: string; formatVersion: number; tables: unknown[]; tableCounts: Record<string, number> }>(
    await readRaw('manifest.json'),
    'manifest.json'
  )
  if (manifest.format !== 'NAIS' || manifest.app !== 'NAIS3') throw new Error('This is not a NAIS3 archive')
  if (manifest.formatVersion !== 1) throw new Error(`Unsupported NAIS archive version: ${String(manifest.formatVersion)}`)
  if (!Array.isArray(manifest.tables) || !manifest.tables.every(isBackupTableName)) throw new Error('manifest.json contains an invalid table list')
  if (new Set(manifest.tables).size !== manifest.tables.length) throw new Error('manifest.json contains duplicate tables')
  const checksums = parseJsonObject<Checksums>(await readRaw('checksums.json'), 'checksums.json')
  let totalBytes = 0
  async function readChecked(path: string): Promise<Buffer> {
    const expected = checksums[path]
    if (!expected || typeof expected.sha256 !== 'string' || typeof expected.bytes !== 'number' || expected.bytes < 0) {
      throw new Error(`Checksum metadata is missing or invalid: ${path}`)
    }
    const data = await readRaw(path)
    totalBytes += data.byteLength
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Archive expands beyond the allowed size')
    if (data.byteLength !== expected.bytes || sha256(data) !== expected.sha256) throw new Error(`Archive checksum mismatch: ${path}`)
    return data
  }
  const settings = parseJsonObject<{ mainParams?: unknown }>(await readChecked('data/settings.json'), 'data/settings.json')
  if (settings.mainParams !== null && typeof settings.mainParams !== 'string') throw new Error('data/settings.json contains invalid mainParams')
  const tables: Partial<Record<Nais3Table, BackupRow[]>> = {}
  const files: { table: Nais3Table; rowId: number; extension: string; data: Buffer }[] = []
  for (const table of manifest.tables as Nais3Table[]) {
    const path = `data/tables/${table}.json`
    const parsed = JSON.parse((await readChecked(path)).toString('utf-8')) as unknown
    if (!Array.isArray(parsed)) throw new Error(`${path} must contain an array`)
    if (manifest.tableCounts?.[table] !== parsed.length) throw new Error(`${path} row count does not match manifest.json`)
    const rows: BackupRow[] = []
    for (const value of parsed) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} contains an invalid row`)
      const decoded: BackupRow = {}
      for (const [column, columnValue] of Object.entries(value)) {
        if (isAssetReference(columnValue)) {
          if (!columnValue.__asset.startsWith('assets/')) throw new Error(`Invalid asset reference in ${path}`)
          const data = await readChecked(columnValue.__asset)
          if (column === 'file_path') {
            const rowId = (value as Record<string, unknown>).id
            if (typeof rowId !== 'number') throw new Error(`${path} row is missing a numeric id`)
            files.push({ table, rowId, extension: /\.[a-z0-9]{1,10}$/.exec(columnValue.__asset)?.[0] ?? '.bin', data })
            decoded[column] = ''
          } else {
            decoded[column] = data
          }
        } else if (columnValue === null || typeof columnValue === 'string' || typeof columnValue === 'number') {
          decoded[column] = columnValue
        } else {
          throw new Error(`${path} contains an invalid value for ${column}`)
        }
      }
      rows.push(decoded)
    }
    tables[table] = rows
  }
  return { includedTables: [...(manifest.tables as Nais3Table[])], tables, mainParams: (settings.mainParams as string | null) ?? null, files }
}

/** NAIS3 repo.ts validateRows — 모르는 열, 잘못된 값, 숫자 id 없는 행을 거부한다 (열 목록은 migrations.ts) */
export function nais3ValidateRows(db: Awaited<ReturnType<typeof nais3ReadNaisArchive>>): void {
  for (const table of db.includedTables) {
    const rows = db.tables[table]
    if (!Array.isArray(rows)) throw new Error(`Backup database is missing table: ${table}`)
    const allowed = new Set(NAIS3_COLUMNS[table])
    for (const row of rows) {
      for (const [column, value] of Object.entries(row)) {
        if (!allowed.has(column)) throw new Error(`Unknown ${table} column: ${column}`)
        if (value !== null && typeof value !== 'string' && typeof value !== 'number' && !Buffer.isBuffer(value)) {
          throw new Error(`Invalid ${table}.${column} value`)
        }
      }
      if (typeof row.id !== 'number') throw new Error(`${table} row is missing a numeric id`)
    }
  }
}
