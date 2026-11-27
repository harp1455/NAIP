/// <reference types="node" />
/**
 * 시험용 ZIP 손 조립 — 앱의 ZipWriter 는 위험한 이름·거짓 크기를 쓰지 않으므로,
 * zip-slip·zip-bomb·겹침·중복 같은 악성 아카이브는 여기서 바이트를 직접 짜 만든다.
 */
import { deflateRawSync } from 'node:zlib'
import { crc32 } from '../../src/backup/hash'
import { ZipReader } from '../../src/backup/zip/reader'
import { ZipWriter } from '../../src/backup/zip/writer'
import { bytesSource, memorySink } from '../../src/backup/io'

export interface CraftEntry {
  name: string
  data: Uint8Array
  /** 8 = deflate (data 를 압축해서 넣는다) */
  method?: 0 | 8
  /** 중앙 디렉터리에 적을 압축 전 크기 (거짓말용) */
  declaredSize?: number
  /** 중앙 디렉터리에 적을 CRC (거짓말용) */
  crc?: number
  /** 다른 항목의 로컬 헤더를 가리키게 (겹침) */
  pointTo?: number
  flags?: number
}

export function craftZip(entries: CraftEntry[]): Uint8Array {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  const offsets: number[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const method = e.method ?? 0
    const body = method === 8 ? deflateRawSync(e.data) : Buffer.from(e.data)
    const crc = e.crc ?? crc32(e.data)
    const size = e.declaredSize ?? e.data.byteLength
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(e.flags ?? 0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.byteLength, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.byteLength, 26)
    offsets.push(offset)
    const at = e.pointTo !== undefined ? offsets[e.pointTo] : offset
    if (e.pointTo === undefined) {
      chunks.push(local, name, body)
      offset += 30 + name.byteLength + body.byteLength
    }
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(e.flags ?? 0x0800, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(body.byteLength, 20)
    cd.writeUInt32LE(size, 24)
    cd.writeUInt16LE(name.byteLength, 28)
    cd.writeUInt32LE(at, 42)
    central.push(cd, name)
  }
  const cdBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cdBuf.byteLength, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...chunks, cdBuf, end]))
}

/** 아카이브의 항목을 풀어서 mutate 를 거쳐 다시 쓴다 (체크섬 목록은 그대로 두고 내용만 바꾸는 데 쓴다) */
export async function rewriteZip(
  bytes: Uint8Array,
  mutate: (path: string, data: Uint8Array) => Uint8Array | null
): Promise<Uint8Array> {
  const zip = await ZipReader.open(bytesSource(bytes))
  const sink = memorySink()
  const w = new ZipWriter(sink)
  for (const path of zip.paths()) {
    const next = mutate(path, await zip.read(path))
    if (next) await w.add({ path, data: next })
  }
  await w.finish()
  return sink.bytes()
}

export async function readAllEntries(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const zip = await ZipReader.open(bytesSource(bytes))
  const out = new Map<string, Uint8Array>()
  for (const path of zip.paths()) out.set(path, await zip.read(path))
  return out
}
