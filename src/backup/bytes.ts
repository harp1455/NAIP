/** 바이트 다루기 — 브라우저·웹뷰·Node(테스트) 공용, DOM 의존 없음 */

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export function utf8(text: string): Uint8Array {
  return encoder.encode(text)
}

/** 잘못된 UTF-8 이면 예외 (손상된 JSON을 조용히 통과시키지 않는다) */
export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

export function concatBytes(chunks: readonly Uint8Array[], total?: number): Uint8Array {
  const size = total ?? chunks.reduce((n, c) => n + c.byteLength, 0)
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

/** 큰 배열도 스택을 넘기지 않도록 조각내서 btoa */
export function toBase64(bytes: Uint8Array): string {
  let out = ''
  const STEP = 0x8000
  for (let i = 0; i < bytes.length; i += STEP) {
    out += String.fromCharCode(...bytes.subarray(i, i + STEP))
  }
  return btoa(out)
}

export function fromBase64(base64: string): Uint8Array {
  const bin = atob(base64.replace(/^data:[^,]*,/, '').replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** base64 문자열을 디코딩하지 않고 바이트 수만 계산 */
export function base64ByteLength(base64: string): number {
  const body = base64.replace(/^data:[^,]*,/, '')
  const pad = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((body.length * 3) / 4) - pad)
}

/** 내용으로 그림 형식을 판별 (확장자·MIME를 믿지 않는다) */
export function sniffImage(bytes: Uint8Array): { mime: string; ext: string } | null {
  const b = bytes
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: 'image/png', ext: 'png' }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' }
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return { mime: 'image/webp', ext: 'webp' }
  }
  return null
}

export function extForMime(mime: string | undefined): string {
  if (mime === 'image/png') return 'png'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'image/jpeg') return 'jpg'
  return 'bin'
}

/** 경로 조각으로 안전한 이름 (NAIS3 archive.ts safeSegment 와 같은 규칙) */
export function safeSegment(value: string | number): string {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_') || 'item'
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}
