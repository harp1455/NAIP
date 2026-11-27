/**
 * 마스크 픽셀 연산 (순수 함수 — 테스트 가능). 마스크는 칠한 곳 1, 안 칠한 곳 0인 Uint8Array(w×h).
 * NovelAI 인페인트는 흑백 마스크만 받고 서버가 합성하므로 경계 흐림(feather)은 쓰지 않는다.
 * 확장·축소는 8px 잠재 블록과 어울리는 정사각 커널을 쓴다.
 */

/** 각 줄에서 [x−r, x+r] 안에 칠한 픽셀이 하나라도 있으면 칠한다 (누적합으로 O(w)) */
function dilateRows(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(src.length)
  const prefix = new Int32Array(w + 1)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) prefix[x + 1] = prefix[x] + src[row + x]
    for (let x = 0; x < w; x++) {
      const a = Math.max(0, x - r)
      const b = Math.min(w, x + r + 1)
      out[row + x] = prefix[b] - prefix[a] > 0 ? 1 : 0
    }
  }
  return out
}

function transpose(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(src.length)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[x * h + y] = src[y * w + x]
  return out
}

export function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice()
  const rows = dilateRows(mask, w, h, r)
  return transpose(dilateRows(transpose(rows, w, h), h, w, r), h, w)
}

export function invert(mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length)
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? 0 : 1
  return out
}

/** 축소 = 반전 → 확장 → 반전 (가장자리 바깥은 칠하지 않은 것으로 본다) */
export function erode(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice()
  return invert(dilate(invert(mask), w, h, r))
}

/** RGBA 알파 → 0/1 */
export function alphaToMask(rgba: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(rgba.length / 4)
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4 + 3] > 127 ? 1 : 0
  return out
}

/** 0/1 → 흰색 RGBA (칠한 곳만 불투명) */
export function maskToRgba(mask: Uint8Array, target: Uint8ClampedArray): void {
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4
    const v = mask[i] ? 255 : 0
    target[o] = target[o + 1] = target[o + 2] = 255
    target[o + 3] = v
  }
}

export function maskCoverage(mask: Uint8Array): number {
  let n = 0
  for (let i = 0; i < mask.length; i++) n += mask[i]
  return mask.length ? n / mask.length : 0
}
