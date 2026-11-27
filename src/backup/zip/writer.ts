/**
 * 스트리밍 ZIP 쓰기 — 항목을 하나씩 받아 바로 내보내고, 끝에 중앙 디렉터리를 쓴다.
 * 메모리에는 항목 하나(원본 그림 한 장)와 중앙 디렉터리 기록만 남는다.
 *
 * 압축은 fflate(Deflate, MIT)만 쓰고 ZIP 컨테이너는 직접 쓴다:
 * - JSZip(이미 의존성)은 쓰기 전에 모든 항목을, 읽을 때 아카이브 전체를 메모리에 올려야 해서
 *   원본 그림이 든 수 GB 백업에 맞지 않는다.
 * - fflate 의 Zip 스트리머는 ZIP64 를 지원하지 않는다. 4GB 를 넘는 전체 백업은 ZIP64 가 필요하다.
 * 항목 하나는 4GB 미만이어야 하고(원본 그림·JSON 조각이라 충분), 오프셋·항목 수가 넘치면 ZIP64 로 쓴다.
 */
import { Deflate, deflateSync } from 'fflate'
import { utf8 } from '../bytes'
import { Crc32, Sha256 } from '../hash'
import type { ByteSink } from '../io'
import { BackupError, throwIfAborted } from '../types'
import { assertSafePath } from './paths'

export interface ZipEntryInput {
  path: string
  /** 바이트 또는 조각 스트림 (스트림이면 크기를 모른 채 데이터 디스크립터로 쓴다) */
  data: Uint8Array | AsyncIterable<Uint8Array>
  /** 이미 압축된 그림은 false (기본 true) */
  compress?: boolean
}

export interface ZipEntryResult {
  path: string
  /** 압축 전 크기와 SHA-256 — checksums.json 에 그대로 쓴다 */
  size: number
  sha256: string
  compressedSize: number
  crc32: number
}

interface CentralRecord {
  name: Uint8Array
  flags: number
  method: number
  crc: number
  compressedSize: number
  size: number
  offset: number
}

const U32 = 0xffffffff
const MAX_ENTRY = U32 - 1
const FLAG_DESCRIPTOR = 0x0008
const FLAG_UTF8 = 0x0800

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, Math.min(2107, d.getFullYear()))
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  }
}

function setU64(view: DataView, at: number, value: number): void {
  view.setUint32(at, value % 0x100000000, true)
  view.setUint32(at + 4, Math.floor(value / 0x100000000), true)
}

export interface ZipWriterOptions {
  date?: Date
  /** deflate 강도 (기본 6) */
  level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
  /** 시험용: 작은 아카이브도 ZIP64 레코드로 쓴다 */
  forceZip64?: boolean
  signal?: AbortSignal
}

export class ZipWriter {
  private offset = 0
  private readonly records: CentralRecord[] = []
  private readonly names = new Set<string>()
  private readonly time: number
  private readonly date: number
  private finished = false

  constructor(
    private readonly sink: ByteSink,
    private readonly opts: ZipWriterOptions = {}
  ) {
    const dt = dosDateTime(opts.date ?? new Date())
    this.time = dt.time
    this.date = dt.date
  }

  get bytesWritten(): number {
    return this.offset
  }

  get entryCount(): number {
    return this.records.length
  }

  private async out(chunk: Uint8Array): Promise<void> {
    if (!chunk.byteLength) return
    await this.sink.write(chunk)
    this.offset += chunk.byteLength
  }

  private localHeader(name: Uint8Array, flags: number, method: number, crc: number, csize: number, size: number): Uint8Array {
    const h = new Uint8Array(30 + name.length)
    const v = new DataView(h.buffer)
    v.setUint32(0, 0x04034b50, true)
    v.setUint16(4, 20, true)
    v.setUint16(6, flags, true)
    v.setUint16(8, method, true)
    v.setUint16(10, this.time, true)
    v.setUint16(12, this.date, true)
    v.setUint32(14, crc, true)
    v.setUint32(18, csize, true)
    v.setUint32(22, size, true)
    v.setUint16(26, name.length, true)
    v.setUint16(28, 0, true)
    h.set(name, 30)
    return h
  }

  async add(entry: ZipEntryInput): Promise<ZipEntryResult> {
    if (this.finished) throw new Error('ZIP 을 이미 마쳤습니다')
    throwIfAborted(this.opts.signal)
    assertSafePath(entry.path)
    if (this.names.has(entry.path)) throw new BackupError('duplicate-entry', `같은 항목을 두 번 쓰려 했습니다: ${entry.path}`, entry.path)
    this.names.add(entry.path)
    const name = utf8(entry.path)
    const offset = this.offset
    const compress = entry.compress !== false
    const level = this.opts.level ?? 6

    if (entry.data instanceof Uint8Array) {
      const data = entry.data
      if (data.byteLength > MAX_ENTRY) throw new BackupError('entry-too-large', `항목이 4GB를 넘습니다: ${entry.path}`, entry.path)
      const crc = new Crc32().update(data).digest()
      const sha256 = new Sha256().update(data).digestHex()
      let body = data
      let method = 0
      if (compress && data.byteLength > 0) {
        const packed = deflateSync(data, { level })
        // 압축해도 안 줄면 그대로 넣는다 (이미 압축된 그림)
        if (packed.byteLength < data.byteLength) {
          body = packed
          method = 8
        }
      }
      await this.out(this.localHeader(name, FLAG_UTF8, method, crc, body.byteLength, data.byteLength))
      await this.out(body)
      this.records.push({ name, flags: FLAG_UTF8, method, crc, compressedSize: body.byteLength, size: data.byteLength, offset })
      return { path: entry.path, size: data.byteLength, sha256, compressedSize: body.byteLength, crc32: crc }
    }

    // 크기를 모르는 스트림 — 로컬 헤더에는 0을 쓰고 뒤에 데이터 디스크립터를 붙인다
    const flags = FLAG_UTF8 | FLAG_DESCRIPTOR
    const method = compress ? 8 : 0
    await this.out(this.localHeader(name, flags, method, 0, 0, 0))
    const crc = new Crc32()
    const sha = new Sha256()
    let size = 0
    let csize = 0
    const pending: Uint8Array[] = []
    const deflate = compress ? new Deflate({ level }, (chunk) => pending.push(chunk)) : null
    const drain = async (): Promise<void> => {
      while (pending.length) {
        const c = pending.shift()!
        csize += c.byteLength
        await this.out(c)
      }
    }
    for await (const chunk of entry.data) {
      throwIfAborted(this.opts.signal)
      if (!chunk.byteLength) continue
      size += chunk.byteLength
      if (size > MAX_ENTRY) throw new BackupError('entry-too-large', `항목이 4GB를 넘습니다: ${entry.path}`, entry.path)
      crc.update(chunk)
      sha.update(chunk)
      if (deflate) {
        deflate.push(chunk)
        await drain()
      } else {
        csize += chunk.byteLength
        await this.out(chunk)
      }
    }
    if (deflate) {
      deflate.push(new Uint8Array(0), true)
      await drain()
    }
    const crcValue = crc.digest()
    const desc = new Uint8Array(16)
    const dv = new DataView(desc.buffer)
    dv.setUint32(0, 0x08074b50, true)
    dv.setUint32(4, crcValue, true)
    dv.setUint32(8, csize, true)
    dv.setUint32(12, size, true)
    await this.out(desc)
    this.records.push({ name, flags, method, crc: crcValue, compressedSize: csize, size, offset })
    return { path: entry.path, size, sha256: sha.digestHex(), compressedSize: csize, crc32: crcValue }
  }

  /** 중앙 디렉터리와 끝 레코드를 쓴다. 전체 바이트 수를 돌려준다 (sink.close 는 부르지 않는다) */
  async finish(): Promise<number> {
    if (this.finished) return this.offset
    this.finished = true
    const force = !!this.opts.forceZip64
    const cdStart = this.offset
    for (const r of this.records) {
      const bigOffset = force || r.offset >= U32
      const extra = bigOffset ? 12 : 0
      const h = new Uint8Array(46 + r.name.length + extra)
      const v = new DataView(h.buffer)
      v.setUint32(0, 0x02014b50, true)
      v.setUint16(4, 45, true)
      v.setUint16(6, bigOffset ? 45 : 20, true)
      v.setUint16(8, r.flags, true)
      v.setUint16(10, r.method, true)
      v.setUint16(12, this.time, true)
      v.setUint16(14, this.date, true)
      v.setUint32(16, r.crc, true)
      v.setUint32(20, r.compressedSize, true)
      v.setUint32(24, r.size, true)
      v.setUint16(28, r.name.length, true)
      v.setUint16(30, extra, true)
      v.setUint16(32, 0, true)
      v.setUint16(34, 0, true)
      v.setUint16(36, 0, true)
      v.setUint32(38, 0, true)
      v.setUint32(42, bigOffset ? U32 : r.offset, true)
      h.set(r.name, 46)
      if (bigOffset) {
        const at = 46 + r.name.length
        v.setUint16(at, 0x0001, true)
        v.setUint16(at + 2, 8, true)
        setU64(v, at + 4, r.offset)
      }
      await this.out(h)
    }
    const cdSize = this.offset - cdStart
    const count = this.records.length
    const zip64 = force || count >= 0xffff || cdStart >= U32 || cdSize >= U32
    if (zip64) {
      const recordAt = this.offset
      const rec = new Uint8Array(56 + 20)
      const v = new DataView(rec.buffer)
      v.setUint32(0, 0x06064b50, true)
      setU64(v, 4, 44)
      v.setUint16(12, 45, true)
      v.setUint16(14, 45, true)
      v.setUint32(16, 0, true)
      v.setUint32(20, 0, true)
      setU64(v, 24, count)
      setU64(v, 32, count)
      setU64(v, 40, cdSize)
      setU64(v, 48, cdStart)
      // ZIP64 end of central directory locator
      v.setUint32(56, 0x07064b50, true)
      v.setUint32(60, 0, true)
      setU64(v, 64, recordAt)
      v.setUint32(72, 1, true)
      await this.out(rec)
    }
    const end = new Uint8Array(22)
    const ev = new DataView(end.buffer)
    ev.setUint32(0, 0x06054b50, true)
    ev.setUint16(4, 0, true)
    ev.setUint16(6, 0, true)
    ev.setUint16(8, zip64 ? 0xffff : count, true)
    ev.setUint16(10, zip64 ? 0xffff : count, true)
    ev.setUint32(12, zip64 ? U32 : cdSize, true)
    ev.setUint32(16, zip64 ? U32 : cdStart, true)
    ev.setUint16(20, 0, true)
    await this.out(end)
    return this.offset
  }
}

/** 항목 스트림을 받아 ZIP 하나를 끝까지 쓴다 (실패하면 sink.abort 로 쓰다 만 파일을 지운다) */
export async function writeZip(
  entries: AsyncIterable<ZipEntryInput> | Iterable<ZipEntryInput>,
  sink: ByteSink,
  opts: ZipWriterOptions & { onEntry?: (r: ZipEntryResult, bytesWritten: number) => void } = {}
): Promise<{ entries: ZipEntryResult[]; bytes: number }> {
  const zip = new ZipWriter(sink, opts)
  const results: ZipEntryResult[] = []
  try {
    for await (const e of entries) {
      const r = await zip.add(e)
      results.push(r)
      opts.onEntry?.(r, zip.bytesWritten)
    }
    const bytes = await zip.finish()
    await sink.close()
    return { entries: results, bytes }
  } catch (error) {
    await sink.abort().catch(() => {})
    throw error
  }
}
