import { planReferenceBucket } from '../nai/reference'

/** 캔버스 기반 이미지 유틸 (NAIS3가 sharp로 하던 전처리를 WebView에서 수행) */

export function loadImage(src: string | Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = typeof src === 'string' ? src : URL.createObjectURL(src)
    const img = new Image()
    img.onload = () => {
      if (typeof src !== 'string') URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      if (typeof src !== 'string') URL.revokeObjectURL(url)
      reject(new Error('이미지를 읽을 수 없습니다'))
    }
    img.src = url
  })
}

export function canvasOf(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return [c, c.getContext('2d')!]
}

export function stripDataUrl(s: string): string {
  return s.replace(/^data:[^,]+,/, '')
}

export function pngDataUrl(base64: string): string {
  return base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(stripDataUrl(r.result as string))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

/** 긴 변이 maxSide를 넘으면 축소해서 PNG base64로 */
export async function toPngBase64(src: string | Blob, maxSide = 4096): Promise<{
  base64: string
  width: number
  height: number
}> {
  const img = await loadImage(src)
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(1, Math.round(img.naturalWidth * scale))
  const h = Math.max(1, Math.round(img.naturalHeight * scale))
  const [c, ctx] = canvasOf(w, h)
  ctx.drawImage(img, 0, 0, w, h)
  return { base64: stripDataUrl(c.toDataURL('image/png')), width: w, height: h }
}

/** 지정 해상도로 강제 리사이즈(fit: fill) — i2i 소스를 요청 해상도에 맞춘다 */
export async function resizeToPngBase64(src: string, width: number, height: number): Promise<string> {
  const img = await loadImage(pngDataUrl(src))
  if (img.naturalWidth === width && img.naturalHeight === height) return stripDataUrl(src)
  const [c, ctx] = canvasOf(width, height)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, width, height)
  return stripDataUrl(c.toDataURL('image/png'))
}

export async function makeThumb(src: string | Blob, side = 320): Promise<string> {
  const img = await loadImage(src)
  const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(1, Math.round(img.naturalWidth * scale))
  const h = Math.max(1, Math.round(img.naturalHeight * scale))
  const [c, ctx] = canvasOf(w, h)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, w, h)
  return c.toDataURL('image/jpeg', 0.8)
}

/**
 * 캐릭터 레퍼런스 전처리 — 1024×1536 / 1536×1024 / 1472×1472 캔버스에
 * 검정 패딩(contain)으로 맞춘다 (NAIS3 processCharRefImage).
 */
export async function processCharRefImage(src: string): Promise<string> {
  const img = await loadImage(pngDataUrl(src))
  const ratio = img.naturalWidth / img.naturalHeight
  const cv = ratio > 1.2 ? { w: 1536, h: 1024 } : ratio < 1 / 1.2 ? { w: 1024, h: 1536 } : { w: 1472, h: 1472 }
  const [c, ctx] = canvasOf(cv.w, cv.h)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, cv.w, cv.h)
  const s = Math.min(cv.w / img.naturalWidth, cv.h / img.naturalHeight)
  const w = img.naturalWidth * s
  const h = img.naturalHeight * s
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, (cv.w - w) / 2, (cv.h - h) / 2, w, h)
  return stripDataUrl(c.toDataURL('image/png'))
}

/**
 * V5 레퍼런스 전처리 — 종횡비가 가장 가까운 V5 크기 칸을 덮도록 그리고 가운데를 잘라 낸다
 * (검정 여백 없이). 공식 웹과 같은 표·식이며 NAIS3처럼 무손실 PNG로 보낸다.
 */
export async function processCharRefImageV5(src: string): Promise<string> {
  const img = await loadImage(pngDataUrl(src))
  const plan = planReferenceBucket(img.naturalWidth, img.naturalHeight)
  const [c, ctx] = canvasOf(plan.width, plan.height)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, plan.width, plan.height)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, -plan.left, -plan.top, plan.resizeWidth, plan.resizeHeight)
  return stripDataUrl(c.toDataURL('image/png'))
}

/**
 * 인페인트 마스크 정규화 (NAIS3 normalizeInpaintMask):
 * 1/8로 평균 축소 → 블록 평균 > 25면 흰색 → 8배 확대(nearest). 8×8 잠재 블록에 정렬된
 * 순수 흑백 RGB PNG. 칠한 영역이 없으면 null.
 */
export async function normalizeInpaintMask(
  maskDataUrl: string,
  width: number,
  height: number
): Promise<string | null> {
  const img = await loadImage(maskDataUrl)
  const mw = Math.max(1, Math.round(width / 8))
  const mh = Math.max(1, Math.round(height / 8))
  const [sc, sctx] = canvasOf(mw, mh)
  sctx.fillStyle = '#000'
  sctx.fillRect(0, 0, mw, mh)
  sctx.imageSmoothingEnabled = true
  sctx.imageSmoothingQuality = 'high'
  sctx.drawImage(img, 0, 0, mw, mh)
  const small = sctx.getImageData(0, 0, mw, mh)
  let any = false
  for (let i = 0; i < small.data.length; i += 4) {
    const v = small.data[i] > 25 ? 255 : 0
    if (v) any = true
    small.data[i] = small.data[i + 1] = small.data[i + 2] = v
    small.data[i + 3] = 255
  }
  if (!any) return null
  sctx.putImageData(small, 0, 0)
  const [c, ctx] = canvasOf(width, height)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(sc, 0, 0, mw, mh, 0, 0, mw * 8, mh * 8)
  return stripDataUrl(c.toDataURL('image/png'))
}

export function pickImageFiles(multiple = false, accept = 'image/*'): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.onchange = () => resolve(Array.from(input.files ?? []))
    input.oncancel = () => resolve([])
    input.click()
  })
}

/**
 * NAI 메타데이터를 지운 PNG로 다시 만든다. NAI는 생성 정보를 두 군데에 넣는다:
 * - PNG 텍스트 청크(tEXt: Comment, Description, Source …) — 캔버스로 다시 인코딩하면 사라진다
 * - 알파 채널 최하위 비트(stealth pnginfo) — 알파 값을 정리해 지운다.
 *   불투명 그림은 전부 255로, 투명 배경 그림은 투명도를 유지한 채 최하위 비트만 고정한다
 */
export async function stripMetadataOnMainThread(blob: Blob): Promise<Blob> {
  const img = await loadImage(blob)
  const [c, ctx] = canvasOf(img.naturalWidth, img.naturalHeight)
  ctx.drawImage(img, 0, 0)
  const data = ctx.getImageData(0, 0, c.width, c.height)
  scrubAlpha(data.data)
  ctx.putImageData(data, 0, 0)
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('이미지를 다시 만들지 못했습니다'))), 'image/png')
  )
}

/** RGBA 배열의 알파에서 숨은 비트를 지운다 (불투명 그림은 전부 255, 투명 배경 그림은 최하위 비트만 고정) */
export function scrubAlpha(d: Uint8ClampedArray): void {
  let opaque = true
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] < 254) {
      opaque = false
      break
    }
  }
  if (opaque) {
    for (let i = 3; i < d.length; i += 4) d[i] = 255
    return
  }
  for (let i = 3; i < d.length; i += 4) {
    const a = d[i]
    d[i] = a >= 254 ? 255 : a <= 1 ? 0 : a | 1
  }
}
