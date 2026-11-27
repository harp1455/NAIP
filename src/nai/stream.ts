import { decode as msgpackDecode } from '@msgpack/msgpack'

/**
 * generate-image-stream 응답 파서 — NAIS3 src/main/nai/stream.ts 를 웹뷰용(Uint8Array)으로 옮긴 것.
 * 포맷: [4바이트 길이(빅엔디언)][msgpack 메시지] 반복.
 * 이벤트: intermediate(step_ix, image) → 진행 미리보기, final(image) → 완성본.
 *
 * 바꾼 점: 받은 조각을 매번 통째로 이어 붙이지 않고 늘어나는 버퍼 하나에 쌓아(앞부분은 읽은 위치만 옮김)
 * 긴 스트림에서도 복사량이 늘지 않게 했다.
 */
export interface StreamHandlers {
  /** 중간 단계 (image는 미리보기 그림 바이트 — 없을 수도 있다) */
  onProgress?: (stepIx: number, image?: Uint8Array) => void
  signal?: AbortSignal
}

/** 스트림 응답을 받기 시작한 뒤에 끊긴 경우 — 서버가 이미 생성했을 수 있어 자동 재시도하지 않는다 */
export class StreamInterruptedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StreamInterruptedError'
  }
}

const MAX_MESSAGE_BYTES = 50_000_000

export async function readImageStream(
  body: ReadableStream<Uint8Array>,
  handlers: StreamHandlers = {}
): Promise<Uint8Array> {
  const reader = body.getReader()
  let buf = new Uint8Array(1 << 20)
  let start = 0
  let end = 0
  let finalImage: Uint8Array | null = null

  const append = (chunk: Uint8Array): void => {
    if (end + chunk.length > buf.length) {
      const live = end - start
      // 앞에 읽고 남은 자리를 먼저 쓰고, 그래도 모자라면 두 배로 늘린다
      const next = live + chunk.length > buf.length ? new Uint8Array(Math.max(buf.length * 2, live + chunk.length)) : buf
      if (next === buf) buf.copyWithin(0, start, end)
      else next.set(buf.subarray(start, end), 0)
      buf = next
      start = 0
      end = live
    }
    buf.set(chunk, end)
    end += chunk.length
  }

  try {
    for (;;) {
      if (handlers.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await reader.read()
      } catch (e) {
        if (handlers.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        throw new StreamInterruptedError(`스트림이 중간에 끊겼습니다 (${(e as Error).message})`)
      }
      const { done, value } = result
      if (value?.length) {
        append(value)
        while (end - start >= 4) {
          const length = ((buf[start] << 24) | (buf[start + 1] << 16) | (buf[start + 2] << 8) | buf[start + 3]) >>> 0
          if (length === 0 || length > MAX_MESSAGE_BYTES) {
            throw new StreamInterruptedError(`스트림 메시지 길이가 올바르지 않습니다 (${length})`)
          }
          if (end - start < 4 + length) break
          // decode 결과의 image는 버퍼를 가리킬 수 있으므로 메시지를 떼어 복사해 둔다
          const message = buf.slice(start + 4, start + 4 + length)
          start += 4 + length
          const decoded = msgpackDecode(message) as Record<string, unknown>
          const eventType = decoded.event_type ?? decoded.event
          if (decoded.error || (decoded.message && eventType !== 'intermediate' && eventType !== 'final')) {
            throw new Error(`NovelAI 스트림 오류: ${String(decoded.error ?? decoded.message)}`)
          }
          const image = decoded.image instanceof Uint8Array ? decoded.image : undefined
          if (eventType === 'intermediate' && typeof decoded.step_ix === 'number') {
            handlers.onProgress?.(decoded.step_ix, image)
          } else if (eventType === 'final' && image) {
            finalImage = image
          }
        }
        if (start === end) start = end = 0
      }
      if (done) break
    }
  } catch (e) {
    try {
      await reader.cancel()
    } catch {
      // 이미 닫힘
    }
    throw e
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // 이미 해제됨
    }
  }
  if (!finalImage) throw new StreamInterruptedError('스트림이 완성 이미지 없이 끝났습니다')
  return finalImage
}
