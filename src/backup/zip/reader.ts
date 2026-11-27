/**
 * 임의 접근 ZIP 읽기 — 끝의 중앙 디렉터리만 읽어 목록을 만들고, 항목은 필요할 때 한 개씩
 * 조각으로 풀어 낸다 (아카이브 전체를 메모리에 올리지 않는다). ZIP64 지원.
 *
 * 압축을 풀기 전에 막는 것들:
 * - zip-slip: 절대 경로, `..`, 역슬래시, NUL, 제어 문자 (paths.ts)
 * - zip-bomb: 항목 수, 항목 크기, 전체 크기, 압축률, 겹치는 항목(같은 데이터를 여러 항목이 가리킴)
 * - 중복 항목, 암호화, 지원하지 않는 압축 방식, 중앙 디렉터리와 로컬 헤더의 이름 불일치
 * 풀면서 막는 것들: 선언보다 많이 풀리는 데이터(즉시 중단), 크기·CRC 불일치
 */
import { Inflate } from 'fflate'
import { bytesEqual, concatBytes, fromUtf8 } from '../bytes'
import { Crc32 } from '../hash'
import type { ByteSource } from '../io'
import { BackupError, throwIfAborted } from '../types'
import { unsafePathReason } from './paths'

export interface ZipLimits {
  maxEntries: number
  /** 항목 하나의 압축 전 최대 크기 */
  maxEntrySize: number
  /** 모든 항목의 압축 전 크기 합 */
  maxTotalSize: number
  /** 압축 전/후 비율 상한 (ratioMinSize 보다 큰 항목만 본다) */
  maxRatio: number
  ratioMinSize: number
  maxCentralDirectorySize: number
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 250_000,
  maxEntrySize: 512 * 1024 * 1024,
  maxTotalSize: 32 * 1024 * 1024 * 1024,
  maxRatio: 200,
  ratioMinSize: 1024 * 1024,
  maxCentralDirectorySize: 128 * 1024 * 1024
}

export interface ZipEntry {
  path: string
  method: number
  flags: number
  crc32: number
  compressedSize: number
  size: number
  /** 로컬 헤더 위치 */
  offset: number
  isDirectory: boolean
  /** 다음 항목(또는 중앙 디렉터리)이 시작하는 곳 — 이 항목의 데이터는 그 앞에서 끝나야 한다 */
  limit: number
  nameBytes: Uint8Array
}

const U32 = 0xffffffff
const READ_CHUNK = 512 * 1024
/** 한 번에 inflate 에 넣는 압축 조각 — 폭탄이어도 한 번에 풀리는 양을 수십 MB 로 묶어 둔다 */
const INFLATE_STEP = 32 * 1024

function corrupt(message: string, path?: string): BackupError {
  return new BackupError('zip-corrupt', `ZIP 파일이 손상됐습니다: ${message}`, path)
}

function u64(v: DataView, at: number): number {
  const lo = v.getUint32(at, true)
  const hi = v.getUint32(at + 4, true)
  if (hi > 0x1fffff) throw corrupt('크기 값이 너무 큽니다')
  return hi * 0x100000000 + lo
}

async function readExact(source: ByteSource, offset: number, length: number): Promise<Uint8Array> {
  if (offset < 0 || length < 0 || offset + length > source.size) throw corrupt('파일 범위를 벗어난 읽기')
  const parts: Uint8Array[] = []
  let got = 0
  while (got < length) {
    const chunk = await source.read(offset + got, length - got)
    if (!chunk.byteLength) throw corrupt('파일이 예상보다 짧습니다')
    parts.push(chunk)
    got += chunk.byteLength
  }
  return parts.length === 1 ? parts[0] : concatBytes(parts, got)
}

export class ZipReader {
  private constructor(
    private readonly source: ByteSource,
    readonly entries: ReadonlyMap<string, ZipEntry>
  ) {}

  static async open(source: ByteSource, limits: Partial<ZipLimits> = {}): Promise<ZipReader> {
    const L = { ...DEFAULT_ZIP_LIMITS, ...limits }
    if (source.size < 22) throw new BackupError('not-zip', 'ZIP 파일이 아닙니다 (너무 짧음)')
    const head = await readExact(source, 0, 4)
    // 빈 ZIP(끝 레코드만) 이거나 로컬 헤더로 시작해야 한다 — 앞에 다른 데이터가 붙은 파일은 받지 않는다
    if (!(head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5))) {
      throw new BackupError('not-zip', 'ZIP 파일이 아닙니다')
    }

    // 끝 레코드(EOCD) 찾기: 주석은 최대 65535 바이트
    const tailLen = Math.min(source.size, 22 + 0xffff + 20)
    const tailStart = source.size - tailLen
    const tail = await readExact(source, tailStart, tailLen)
    const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tv.getUint32(i, true) === 0x06054b50 && i + 22 + tv.getUint16(i + 20, true) === tail.length) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new BackupError('not-zip', 'ZIP 파일이 아니거나 끝이 잘렸습니다')
    if (tv.getUint16(eocd + 4, true) !== 0 || tv.getUint16(eocd + 6, true) !== 0) throw corrupt('여러 조각으로 나뉜 ZIP 은 지원하지 않습니다')
    let count = tv.getUint16(eocd + 10, true)
    let cdSize = tv.getUint32(eocd + 12, true)
    let cdOffset = tv.getUint32(eocd + 16, true)
    let cdEndLimit = tailStart + eocd

    // ZIP64 위치 레코드가 바로 앞에 있으면 ZIP64 끝 레코드의 값을 쓴다
    if (eocd >= 20 && tv.getUint32(eocd - 20, true) === 0x07064b50) {
      const recordAt = u64(tv, eocd - 20 + 8)
      if (recordAt + 56 > tailStart + eocd - 20) throw corrupt('ZIP64 레코드 위치가 잘못됐습니다')
      const rec = await readExact(source, recordAt, 56)
      const rv = new DataView(rec.buffer, rec.byteOffset, 56)
      if (rv.getUint32(0, true) !== 0x06064b50) throw corrupt('ZIP64 끝 레코드가 없습니다')
      count = u64(rv, 32)
      cdSize = u64(rv, 40)
      cdOffset = u64(rv, 48)
      cdEndLimit = recordAt
    } else if (count === 0xffff || cdSize === U32 || cdOffset === U32) {
      throw corrupt('ZIP64 정보가 없습니다')
    }

    if (count > L.maxEntries) {
      throw new BackupError('too-many-entries', `항목이 너무 많습니다 (${count.toLocaleString()}개, 최대 ${L.maxEntries.toLocaleString()}개)`)
    }
    if (cdSize > L.maxCentralDirectorySize) throw new BackupError('too-many-entries', '목록(중앙 디렉터리)이 너무 큽니다')
    if (cdOffset + cdSize > cdEndLimit) throw corrupt('목록 위치가 파일 범위를 벗어납니다')

    const cd = await readExact(source, cdOffset, cdSize)
    const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength)
    const list: ZipEntry[] = []
    const byPath = new Map<string, ZipEntry>()
    let total = 0
    let p = 0
    for (let n = 0; n < count; n++) {
      if (p + 46 > cd.length || cv.getUint32(p, true) !== 0x02014b50) throw corrupt('목록 항목이 잘렸습니다')
      const flags = cv.getUint16(p + 8, true)
      const method = cv.getUint16(p + 10, true)
      const crc = cv.getUint32(p + 16, true)
      let compressedSize = cv.getUint32(p + 20, true)
      let size = cv.getUint32(p + 24, true)
      const nameLen = cv.getUint16(p + 28, true)
      const extraLen = cv.getUint16(p + 30, true)
      const commentLen = cv.getUint16(p + 32, true)
      let offset = cv.getUint32(p + 42, true)
      const end = p + 46 + nameLen + extraLen + commentLen
      if (end > cd.length) throw corrupt('목록 항목이 잘렸습니다')
      const nameBytes = cd.slice(p + 46, p + 46 + nameLen)
      // ZIP64 확장 필드: 0xffffffff 로 표시된 값만 순서대로 들어 있다
      let e = p + 46 + nameLen
      const extraEnd = e + extraLen
      while (e + 4 <= extraEnd) {
        const id = cv.getUint16(e, true)
        const len = cv.getUint16(e + 2, true)
        if (e + 4 + len > extraEnd) throw corrupt('확장 필드가 잘렸습니다')
        if (id === 0x0001) {
          let q = e + 4
          const take = (): number => {
            if (q + 8 > e + 4 + len) throw corrupt('ZIP64 확장 필드가 짧습니다')
            const v = u64(cv, q)
            q += 8
            return v
          }
          if (size === U32) size = take()
          if (compressedSize === U32) compressedSize = take()
          if (offset === U32) offset = take()
        }
        e += 4 + len
      }
      p = end

      let path: string
      try {
        path = fromUtf8(nameBytes)
      } catch {
        throw corrupt('항목 이름을 읽을 수 없습니다')
      }
      const reason = unsafePathReason(path)
      if (reason) throw new BackupError('unsafe-path', `안전하지 않은 경로가 들어 있습니다 (${reason}): ${JSON.stringify(path)}`, path)
      if (byPath.has(path)) throw new BackupError('duplicate-entry', `같은 이름의 항목이 두 번 들어 있습니다: ${path}`, path)
      if (flags & 0x0041) throw new BackupError('encrypted', `암호화된 항목은 지원하지 않습니다: ${path}`, path)
      if (method !== 0 && method !== 8) {
        throw new BackupError('unsupported-compression', `지원하지 않는 압축 방식(${method}): ${path}`, path)
      }
      const isDirectory = path.endsWith('/')
      if (isDirectory && size !== 0) throw corrupt(`폴더 항목에 데이터가 있습니다: ${path}`, path)
      if (method === 0 && size !== compressedSize) throw corrupt(`무압축 항목의 크기가 맞지 않습니다: ${path}`, path)
      if (size > L.maxEntrySize) {
        throw new BackupError('entry-too-large', `항목이 너무 큽니다: ${path} (${Math.round(size / 1048576)}MB)`, path)
      }
      total += size
      if (total > L.maxTotalSize) throw new BackupError('total-too-large', '압축을 풀면 허용 크기를 넘습니다')
      if (size >= L.ratioMinSize && size > Math.max(compressedSize, 1) * L.maxRatio) {
        throw new BackupError('suspicious-ratio', `압축률이 비정상적으로 높습니다 (압축 폭탄 의심): ${path}`, path)
      }
      const entry: ZipEntry = { path, method, flags, crc32: crc, compressedSize, size, offset, isDirectory, limit: cdOffset, nameBytes }
      list.push(entry)
      byPath.set(path, entry)
    }

    // 겹치는 항목: 위치순으로 늘어놓고 각 항목의 최소 끝이 다음 항목 시작을 넘지 않아야 한다
    const sorted = [...list].sort((a, b) => a.offset - b.offset)
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i]
      const next = i + 1 < sorted.length ? sorted[i + 1].offset : cdOffset
      cur.limit = next
      if (cur.offset + 30 + cur.nameBytes.length + cur.compressedSize > next) {
        throw new BackupError('overlapping-entries', `항목이 서로 겹칩니다 (압축 폭탄 의심): ${cur.path}`, cur.path)
      }
    }
    return new ZipReader(source, byPath)
  }

  /** 파일 항목 경로 (폴더 항목 제외) */
  paths(): string[] {
    return [...this.entries.values()].filter((e) => !e.isDirectory).map((e) => e.path)
  }

  has(path: string): boolean {
    const e = this.entries.get(path)
    return !!e && !e.isDirectory
  }

  entry(path: string): ZipEntry {
    const e = this.entries.get(path)
    if (!e || e.isDirectory) throw new BackupError('missing-entry', `아카이브에 ${path} 가 없습니다`, path)
    return e
  }

  /** 항목을 조각으로 풀어 낸다 — 선언보다 많이 풀리면 즉시 중단, 끝에서 크기·CRC 확인 */
  async *chunks(path: string, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    const e = this.entry(path)
    const lh = await readExact(this.source, e.offset, 30)
    const lv = new DataView(lh.buffer, lh.byteOffset, 30)
    if (lv.getUint32(0, true) !== 0x04034b50) throw corrupt(`로컬 헤더가 없습니다: ${path}`, path)
    if (lv.getUint16(8, true) !== e.method) throw corrupt(`압축 방식이 목록과 다릅니다: ${path}`, path)
    const nameLen = lv.getUint16(26, true)
    const extraLen = lv.getUint16(28, true)
    const localName = await readExact(this.source, e.offset + 30, nameLen)
    if (!bytesEqual(localName, e.nameBytes)) throw corrupt(`로컬 헤더의 이름이 목록과 다릅니다: ${path}`, path)
    const start = e.offset + 30 + nameLen + extraLen
    if (start + e.compressedSize > e.limit) {
      throw new BackupError('overlapping-entries', `항목이 서로 겹칩니다 (압축 폭탄 의심): ${path}`, path)
    }

    const crc = new Crc32()
    let produced = 0
    const tooBig = (): BackupError =>
      new BackupError('size-mismatch', `선언한 크기보다 많이 풀립니다 (압축 폭탄 의심): ${path}`, path)
    const out: Uint8Array[] = []
    const inflate =
      e.method === 8
        ? new Inflate((chunk) => {
            produced += chunk.byteLength
            // 콜백 안에서 던지면 push 가 바로 멈춘다
            if (produced > e.size) throw tooBig()
            out.push(chunk)
          })
        : null

    let read = 0
    while (read < e.compressedSize) {
      throwIfAborted(signal)
      const len = Math.min(READ_CHUNK, e.compressedSize - read)
      const chunk = await readExact(this.source, start + read, len)
      read += len
      if (!inflate) {
        produced += chunk.byteLength
        crc.update(chunk)
        yield chunk
        continue
      }
      for (let at = 0; at < chunk.byteLength; at += INFLATE_STEP) {
        const piece = chunk.subarray(at, at + INFLATE_STEP)
        const final = read >= e.compressedSize && at + INFLATE_STEP >= chunk.byteLength
        try {
          inflate.push(piece, final)
        } catch (error) {
          if (error instanceof BackupError) throw error
          throw corrupt(`압축 데이터를 풀 수 없습니다 (${(error as Error).message}): ${path}`, path)
        }
        while (out.length) {
          const c = out.shift()!
          crc.update(c)
          yield c
        }
      }
    }
    if (inflate && e.compressedSize === 0) throw corrupt(`압축 데이터가 비었습니다: ${path}`, path)
    if (produced !== e.size) {
      throw new BackupError('size-mismatch', `풀린 크기가 목록과 다릅니다: ${path} (${produced} ≠ ${e.size})`, path)
    }
    if (crc.digest() !== e.crc32) throw new BackupError('crc-mismatch', `CRC 가 맞지 않습니다 (손상): ${path}`, path)
  }

  /** 항목 전체를 바이트로 (작은 항목용 — maxSize 를 넘으면 거부) */
  async read(path: string, opts: { maxSize?: number; signal?: AbortSignal } = {}): Promise<Uint8Array> {
    const e = this.entry(path)
    if (opts.maxSize !== undefined && e.size > opts.maxSize) {
      throw new BackupError('entry-too-large', `항목이 너무 큽니다: ${path}`, path)
    }
    const parts: Uint8Array[] = []
    for await (const c of this.chunks(path, opts.signal)) parts.push(c)
    return concatBytes(parts, e.size)
  }
}
