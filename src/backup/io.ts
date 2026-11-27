/**
 * 아카이브를 쓰고 읽는 곳의 추상화. 실제 구현은 files.ts (Android SAF / 브라우저 다운로드·파일 선택),
 * 테스트는 아래의 메모리 구현을 쓴다.
 */
import { concatBytes } from './bytes'

/** 순서대로 덧붙여 쓰는 출력 */
export interface ByteSink {
  write(chunk: Uint8Array): Promise<void>
  /** 다 썼다 — 결과 파일이 완성된다 */
  close(): Promise<void>
  /** 실패·취소 — 쓰다 만 파일을 지운다 */
  abort(): Promise<void>
}

/** 임의 위치를 읽을 수 있는 입력 (ZIP 은 끝의 중앙 디렉터리부터 읽는다) */
export interface ByteSource {
  readonly size: number
  read(offset: number, length: number): Promise<Uint8Array>
}

export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.byteLength,
    read: async (offset, length) => bytes.subarray(offset, Math.min(bytes.byteLength, offset + length))
  }
}

/** File/Blob — 전체를 메모리에 올리지 않고 필요한 구간만 읽는다 */
export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer())
  }
}

/** 메모리에 모으는 출력 (테스트·작은 파일용) */
export function memorySink(): ByteSink & { bytes(): Uint8Array; closed: boolean; aborted: boolean } {
  const chunks: Uint8Array[] = []
  const sink = {
    closed: false,
    aborted: false,
    async write(chunk: Uint8Array) {
      chunks.push(chunk.slice())
    },
    async close() {
      sink.closed = true
    },
    async abort() {
      sink.aborted = true
      chunks.length = 0
    },
    bytes: () => concatBytes(chunks)
  }
  return sink
}

/**
 * 작은 쓰기를 모아 한 번에 넘긴다 — 네이티브 다리를 건너는 호출 수를 줄인다.
 * 쓴 총 바이트(written)를 센다.
 */
export class BufferedSink implements ByteSink {
  written = 0
  private parts: Uint8Array[] = []
  private size = 0
  constructor(
    private readonly inner: ByteSink,
    private readonly chunkSize = 1 << 20
  ) {}

  async write(chunk: Uint8Array): Promise<void> {
    if (!chunk.byteLength) return
    this.written += chunk.byteLength
    // 큰 덩어리는 모으지 않고 바로 (원본 그림)
    if (chunk.byteLength >= this.chunkSize) {
      await this.flush()
      for (let at = 0; at < chunk.byteLength; at += this.chunkSize) {
        await this.inner.write(chunk.subarray(at, at + this.chunkSize))
      }
      return
    }
    // 호출한 쪽이 버퍼를 다시 쓸 수 있으니 복사해 둔다
    this.parts.push(chunk.slice())
    this.size += chunk.byteLength
    if (this.size >= this.chunkSize) await this.flush()
  }

  async flush(): Promise<void> {
    if (!this.size) return
    const data = concatBytes(this.parts, this.size)
    this.parts = []
    this.size = 0
    await this.inner.write(data)
  }

  async close(): Promise<void> {
    await this.flush()
    await this.inner.close()
  }

  async abort(): Promise<void> {
    this.parts = []
    this.size = 0
    await this.inner.abort()
  }
}
