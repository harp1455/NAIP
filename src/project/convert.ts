/**
 * 내보내기용 이미지 일괄 변환 — PNG/JPEG/WebP, 크기·최대 가로세로, 비율 유지(contain/cover/fill),
 * 자르기(가운데/직접 지정)·여백(색), 품질, 목표 파일 크기(제한된 횟수의 탐색), 투명도 처리, 메타데이터 제거.
 *
 * - 원본 Blob은 건드리지 않고 새 Blob을 만든다.
 * - 캔버스로 다시 인코딩하므로 PNG 텍스트 청크·EXIF는 남지 않고, 알파 채널의 NAI 스텔스 정보도
 *   lib/image.ts scrubAlpha(stripMetadata와 같은 규칙)로 지운다.
 * - OffscreenCanvas가 있으면 그것만 써서 워커 안에서도 돌아간다 (convert.worker.ts, convertInWorker).
 * - 목표 크기 탐색은 최대 maxIterations번(기본 6, 최대 12)만 인코딩하고 품질 하한 아래로는 내려가지 않는다.
 *   못 맞추면 가장 작은 결과와 경고를 돌려준다.
 */
import { scrubAlpha } from '../lib/image'

export type ImageFormat = 'png' | 'jpeg' | 'webp'

export const FORMAT_MIME: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp'
}

export const FORMAT_EXT: Record<ImageFormat, string> = { png: 'png', jpeg: 'jpg', webp: 'webp' }

export function formatOfMime(mime: string): ImageFormat | null {
  if (mime === 'image/png') return 'png'
  if (mime === 'image/jpeg') return 'jpeg'
  if (mime === 'image/webp') return 'webp'
  return null
}

/** 원본에서 먼저 잘라 낼 영역 — center: 그 비율(가로/세로)로 가운데, rect: 원본 픽셀 좌표 */
export type CropSpec = { mode: 'center'; aspect: number } | { mode: 'rect'; x: number; y: number; width: number; height: number }

export interface ConvertOptions {
  format: ImageFormat
  /** 출력 크기. 둘 다 주면 fit으로 맞추고, 하나만 주면 비율대로. 키우는 것도 허용 */
  width?: number
  height?: number
  /** 이보다 크면 비율대로 줄인다 (키우지 않음) */
  maxWidth?: number
  maxHeight?: number
  /** width·height를 둘 다 줄 때: contain = 비율 유지 + 여백, cover = 비율 유지 + 가운데 잘라 채움, fill = 늘림 */
  fit?: 'contain' | 'cover' | 'fill'
  crop?: CropSpec | null
  /** 바깥 여백 (px, 출력 크기에 더해진다) */
  padding?: number
  /** 여백(contain의 남는 칸, padding) 색. 없으면 투명 — JPEG는 background */
  padColor?: string
  /** 0~1 (JPEG·WebP, 기본 0.92) */
  quality?: number
  /** 목표 파일 크기(바이트) */
  targetBytes?: number
  /** 목표 크기를 맞출 때의 품질 하한 (기본 0.6) */
  minQuality?: number
  /** 탐색 인코딩 횟수 상한 (기본 6, 1~12). 품질 탐색과 크기 줄이기 탐색이 각각 이 안에서 끝난다 */
  maxIterations?: number
  /** 품질로 못 맞추면(또는 PNG면) 크기를 줄여서라도 맞춘다 (기본 false) */
  allowDownscale?: boolean
  /** 그때 줄일 수 있는 하한 배율 (기본 0.5) */
  minScale?: number
  /** JPEG로 바꿀 때 투명한 부분을 채울 색 (기본 #ffffff) */
  background?: string
  /** 알파 채널 숨은 정보 지우기 (기본 true) */
  scrubAlpha?: boolean
}

export interface Geometry {
  /** 원본에서 쓸 영역 */
  sx: number
  sy: number
  sw: number
  sh: number
  /** 출력 캔버스 크기 */
  width: number
  height: number
  /** 캔버스에 그림을 그릴 자리 */
  dx: number
  dy: number
  dw: number
  dh: number
  /** 그림이 덮지 않는 칸(여백)이 있는가 */
  padded: boolean
}

function clampInt(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(v)))
}

function centerCrop(
  r: { sx: number; sy: number; sw: number; sh: number },
  aspect: number
): { sx: number; sy: number; sw: number; sh: number } {
  if (!(aspect > 0) || !Number.isFinite(aspect)) return r
  if (r.sw / r.sh > aspect) {
    const sw = Math.max(1, Math.round(r.sh * aspect))
    return { ...r, sx: r.sx + Math.floor((r.sw - sw) / 2), sw }
  }
  const sh = Math.max(1, Math.round(r.sw / aspect))
  return { ...r, sy: r.sy + Math.floor((r.sh - sh) / 2), sh }
}

/** 원본 크기와 옵션으로 자를 영역·출력 크기·그릴 자리를 정한다 (scale은 목표 크기용 추가 축소) */
export function planGeometry(srcW: number, srcH: number, opts: ConvertOptions, scale = 1): Geometry {
  let r = { sx: 0, sy: 0, sw: Math.max(1, srcW), sh: Math.max(1, srcH) }
  const crop = opts.crop
  if (crop?.mode === 'rect') {
    const sx = clampInt(crop.x, 0, r.sw - 1)
    const sy = clampInt(crop.y, 0, r.sh - 1)
    r = { sx, sy, sw: clampInt(crop.width, 1, r.sw - sx), sh: clampInt(crop.height, 1, r.sh - sy) }
  } else if (crop?.mode === 'center') {
    r = centerCrop(r, crop.aspect)
  }

  const fit = opts.fit ?? 'contain'
  const W0 = opts.width && opts.width > 0 ? Math.round(opts.width) : 0
  const H0 = opts.height && opts.height > 0 ? Math.round(opts.height) : 0
  let width: number
  let height: number
  let dx = 0
  let dy = 0
  let dw: number
  let dh: number
  if (W0 && H0) {
    width = W0
    height = H0
    if (fit === 'fill') {
      dw = W0
      dh = H0
    } else if (fit === 'cover') {
      r = centerCrop(r, W0 / H0)
      dw = W0
      dh = H0
    } else {
      const s = Math.min(W0 / r.sw, H0 / r.sh)
      dw = Math.max(1, Math.round(r.sw * s))
      dh = Math.max(1, Math.round(r.sh * s))
      dx = Math.floor((W0 - dw) / 2)
      dy = Math.floor((H0 - dh) / 2)
    }
  } else if (W0) {
    width = dw = W0
    height = dh = Math.max(1, Math.round((r.sh * W0) / r.sw))
  } else if (H0) {
    height = dh = H0
    width = dw = Math.max(1, Math.round((r.sw * H0) / r.sh))
  } else {
    width = dw = r.sw
    height = dh = r.sh
  }

  // 최대 가로세로 + 목표 크기용 축소 — 캔버스와 그릴 자리를 같은 비율로
  const maxW = opts.maxWidth && opts.maxWidth > 0 ? opts.maxWidth : Infinity
  const maxH = opts.maxHeight && opts.maxHeight > 0 ? opts.maxHeight : Infinity
  const f = Math.min(1, maxW / width, maxH / height) * Math.min(1, Math.max(0.01, scale))
  if (f < 1) {
    const nw = Math.max(1, Math.round(width * f))
    const nh = Math.max(1, Math.round(height * f))
    dw = Math.max(1, Math.round(dw * f))
    dh = Math.max(1, Math.round(dh * f))
    dx = Math.min(Math.round(dx * f), nw - dw)
    dy = Math.min(Math.round(dy * f), nh - dh)
    width = nw
    height = nh
  }

  const pad = Math.max(0, Math.round(opts.padding ?? 0))
  width += pad * 2
  height += pad * 2
  dx = Math.max(0, dx) + pad
  dy = Math.max(0, dy) + pad
  return {
    ...r,
    width,
    height,
    dx,
    dy,
    dw,
    dh,
    padded: dx > 0 || dy > 0 || dx + dw < width || dy + dh < height
  }
}

// ── 목표 크기 탐색 ──────────────────────────────────────────────────────────

export interface SizeAttempt<T> {
  param: number
  size: number
  value: T
}

export interface SizeSearchResult<T> {
  best: SizeAttempt<T>
  /** 목표 이하를 만들었는가 */
  reached: boolean
  /** 이 탐색에서 새로 인코딩한 시도 (atMax로 받은 것은 빼고 — 상한에는 atMax도 들어간다) */
  attempts: { param: number; size: number }[]
}

export interface SizeSearchOptions<T> {
  target: number
  /** 클수록 파일이 커지는 값의 범위 (품질 또는 배율) */
  max: number
  min: number
  /** 인코딩 횟수 상한 (atMax 포함, 기본 6, 1~12) */
  maxIterations?: number
  /** 값의 최소 간격 (기본 0.01) — 더 좁힐 수 없으면 멈춘다 */
  step?: number
  /** 목표의 이 비율 안으로 들어오면 그만 찾는다 (기본 0.03) */
  tolerance?: number
  /** max에서 이미 인코딩한 결과 (다시 만들지 않음) */
  atMax?: SizeAttempt<T>
}

/**
 * 목표 크기 이하에서 가장 큰 값(품질·배율)을 이분 탐색한다. 끝나는 조건이 정해져 있다:
 * 인코딩은 maxIterations번까지, 값은 [min, max] 밖으로 나가지 않는다.
 * min에서도 목표를 넘으면 시도한 것 중 가장 작은 결과를 reached: false로 돌려준다.
 */
export async function searchForSize<T>(
  encode: (param: number) => Promise<{ size: number; value: T }>,
  o: SizeSearchOptions<T>
): Promise<SizeSearchResult<T>> {
  const iterations = Math.min(12, Math.max(1, Math.floor(o.maxIterations ?? 6)))
  const step = o.step && o.step > 0 ? o.step : 0.01
  const tolerance = o.tolerance ?? 0.03
  const min = Math.min(o.min, o.max)
  const attempts: { param: number; size: number }[] = []
  const all: SizeAttempt<T>[] = []
  const run = async (param: number): Promise<SizeAttempt<T>> => {
    const r = await encode(param)
    const a = { param, size: r.size, value: r.value }
    attempts.push({ param, size: r.size })
    all.push(a)
    return a
  }
  const smallest = (): SizeAttempt<T> => all.reduce((a, b) => (b.size < a.size ? b : a))

  // atMax도 횟수에 넣는다 — 전체 인코딩이 maxIterations번을 넘지 않게
  const top = o.atMax ?? (await run(o.max))
  if (o.atMax) all.push(top)
  if (top.size <= o.target) return { best: top, reached: true, attempts }
  if (all.length >= iterations || min >= o.max - step / 2) return { best: smallest(), reached: false, attempts }

  const floor = await run(min)
  if (floor.size > o.target) return { best: smallest(), reached: false, attempts }

  let best = floor
  let lo = min
  let hi = o.max
  while (all.length < iterations && best.size < o.target * (1 - tolerance)) {
    const mid = Math.round((lo + hi) / 2 / step) * step
    if (mid <= lo + step / 2 || mid >= hi - step / 2) break
    const a = await run(mid)
    if (a.size <= o.target) {
      if (a.param > best.param) best = a
      lo = mid
    } else {
      hi = mid
    }
  }
  return { best, reached: true, attempts }
}

// ── 캔버스 ───────────────────────────────────────────────────────────────────

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement
type AnyContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

function makeCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  return c
}

function context(canvas: AnyCanvas): AnyContext {
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as AnyContext | null
  if (!ctx) throw new Error('캔버스를 만들 수 없습니다')
  return ctx
}

function encodeCanvas(canvas: AnyCanvas, mime: string, quality?: number): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: mime, ...(quality !== undefined ? { quality } : {}) })
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('이미지를 만들지 못했습니다'))), mime, quality)
  )
}

interface Rendered {
  canvas: AnyCanvas
  geometry: Geometry
  /** 그림 영역에 투명한 픽셀이 있었는가 */
  transparent: boolean
}

function render(bitmap: ImageBitmap, opts: ConvertOptions, scale: number): Rendered {
  const g = planGeometry(bitmap.width, bitmap.height, opts, scale)
  const canvas = makeCanvas(g.width, g.height)
  const ctx = context(canvas)
  const jpeg = opts.format === 'jpeg'
  const padColor = opts.padColor ?? (jpeg ? (opts.background ?? '#ffffff') : undefined)
  if (padColor && g.padded) {
    ctx.fillStyle = padColor
    ctx.fillRect(0, 0, g.width, g.height)
    ctx.clearRect(g.dx, g.dy, g.dw, g.dh)
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, g.sx, g.sy, g.sw, g.sh, g.dx, g.dy, g.dw, g.dh)

  // 그림 영역의 투명도 확인 — 254는 NAI 스텔스 정보가 든 불투명 픽셀이라 투명으로 치지 않는다 (scrubAlpha와 같은 기준)
  const area = ctx.getImageData(g.dx, g.dy, g.dw, g.dh).data
  let transparent = false
  for (let i = 3; i < area.length; i += 4) {
    if (area[i] < 254) {
      transparent = true
      break
    }
  }
  if (jpeg) {
    // JPEG에는 알파가 없다 — 배경색 위에 합성해 평평하게
    ctx.globalCompositeOperation = 'destination-over'
    ctx.fillStyle = opts.background ?? '#ffffff'
    ctx.fillRect(0, 0, g.width, g.height)
    ctx.globalCompositeOperation = 'source-over'
  } else if (opts.scrubAlpha !== false) {
    const data = ctx.getImageData(0, 0, g.width, g.height)
    scrubAlpha(data.data)
    ctx.putImageData(data, 0, 0)
  }
  return { canvas, geometry: g, transparent }
}

export interface ConvertResult {
  blob: Blob
  /** 실제로 만든 형식 (기기가 WebP 인코딩을 못 하면 png일 수 있다) */
  format: ImageFormat
  width: number
  height: number
  bytes: number
  /** JPEG·WebP 품질 */
  quality?: number
  /** 목표 크기 때문에 줄인 배율 (1 = 안 줄임) */
  scale: number
  /** 인코딩한 횟수 */
  encodes: number
  /** 목표 크기를 맞췄는가 (목표가 없으면 null) */
  reachedTarget: boolean | null
  warnings: string[]
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/** 한 장 변환. 원본은 그대로 두고 새 Blob을 돌려준다 */
export async function convertImage(input: Blob, opts: ConvertOptions): Promise<ConvertResult> {
  const bitmap = await createImageBitmap(input)
  try {
    return await convertBitmap(bitmap, opts)
  } finally {
    bitmap.close()
  }
}

async function convertBitmap(bitmap: ImageBitmap, opts: ConvertOptions): Promise<ConvertResult> {
  const warnings: string[] = []
  const mime = FORMAT_MIME[opts.format]
  const lossy = opts.format !== 'png'
  const maxQ = Math.min(1, Math.max(0.05, opts.quality ?? 0.92))
  const minQ = Math.min(maxQ, Math.max(0.05, opts.minQuality ?? 0.6))
  const target = opts.targetBytes && opts.targetBytes > 0 ? opts.targetBytes : 0
  let encodes = 0
  let actualFormat: ImageFormat = opts.format

  let rendered = render(bitmap, opts, 1)
  if (opts.format === 'jpeg' && rendered.transparent) {
    warnings.push(`JPEG는 투명도를 담지 못해 투명한 부분을 ${opts.background ?? '#ffffff'}로 채웠습니다`)
  }
  const encodeAt = async (canvas: AnyCanvas, q: number | undefined): Promise<{ size: number; value: Blob }> => {
    encodes++
    const blob = await encodeCanvas(canvas, mime, lossy ? q : undefined)
    // 이 기기가 그 형식을 못 만들면 브라우저는 PNG를 준다
    const got = formatOfMime(blob.type)
    if (got && got !== opts.format) actualFormat = got
    return { size: blob.size, value: blob }
  }

  let quality: number | undefined = lossy ? maxQ : undefined
  let scale = 1
  let best = { ...(await encodeAt(rendered.canvas, quality)), param: maxQ }
  if (actualFormat !== opts.format) {
    warnings.push(`이 기기는 ${opts.format.toUpperCase()} 인코딩을 지원하지 않아 ${actualFormat.toUpperCase()}로 만들었습니다`)
  }
  let reached: boolean | null = target ? best.size <= target : null

  // 1단계: 품질로 맞추기 (JPEG·WebP)
  if (target && !reached && lossy && actualFormat === opts.format) {
    const r = await searchForSize((q) => encodeAt(rendered.canvas, q), {
      target,
      max: maxQ,
      min: minQ,
      maxIterations: opts.maxIterations,
      atMax: best
    })
    best = r.best
    quality = r.best.param
    reached = r.reached
  }

  // 2단계: 크기를 줄여서 맞추기 (허용했을 때만, 품질은 1단계 결과 그대로)
  if (target && !reached && opts.allowDownscale) {
    const minScale = Math.min(1, Math.max(0.05, opts.minScale ?? 0.5))
    const q = quality
    const r = await searchForSize(
      async (s) => {
        rendered = render(bitmap, opts, s)
        const out = await encodeAt(rendered.canvas, q)
        return { size: out.size, value: { blob: out.value, geometry: rendered.geometry } }
      },
      {
        target,
        max: 1,
        min: minScale,
        maxIterations: opts.maxIterations,
        atMax: { param: 1, size: best.size, value: { blob: best.value, geometry: rendered.geometry } }
      }
    )
    best = { size: r.best.size, value: r.best.value.blob, param: quality ?? 1 }
    rendered = { ...rendered, geometry: r.best.value.geometry }
    scale = r.best.param
    reached = r.reached
  }

  if (target && !reached) {
    const why = !lossy
      ? 'PNG는 품질로 크기를 줄일 수 없습니다'
      : `품질 하한 ${Math.round(minQ * 100)}%까지 낮춰도 넘습니다`
    warnings.push(
      `목표 크기 ${formatBytes(target)}에 맞추지 못했습니다 (${why}) — 가장 작은 결과 ${formatBytes(best.size)}를 씁니다` +
        (opts.allowDownscale ? '' : '. 크기 줄이기를 허용하면 더 작게 만들 수 있습니다')
    )
  }
  const g = rendered.geometry
  return {
    blob: best.value,
    format: actualFormat,
    width: g.width,
    height: g.height,
    bytes: best.size,
    ...(lossy && actualFormat !== 'png' && quality !== undefined ? { quality: Math.round(quality * 100) / 100 } : {}),
    scale,
    encodes,
    reachedTarget: reached,
    warnings
  }
}

// ── 일괄 변환 ────────────────────────────────────────────────────────────────

export interface BatchItem<T> {
  item: T
  result?: ConvertResult
  error?: string
}

export interface BatchOptions {
  /** 동시에 변환할 장수 (기본 2) */
  concurrency?: number
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
  /** 변환 함수 (기본 convertImage, 워커로 돌리려면 convertInWorker) */
  convert?: (blob: Blob, opts: ConvertOptions) => Promise<ConvertResult>
}

/** 여러 장을 차례로(동시에 concurrency장) 변환한다. 한 장이 실패해도 나머지는 계속한다 */
export async function convertBatch<T extends { blob: Blob }>(
  items: readonly T[],
  opts: ConvertOptions | ((item: T) => ConvertOptions),
  o: BatchOptions = {}
): Promise<BatchItem<T>[]> {
  const out: BatchItem<T>[] = items.map((item) => ({ item }))
  const run = o.convert ?? convertImage
  let next = 0
  let done = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      if (o.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const i = next++
      try {
        out[i].result = await run(items[i].blob, typeof opts === 'function' ? opts(items[i]) : opts)
      } catch (e) {
        out[i].error = (e as Error)?.message ?? String(e)
      }
      o.onProgress?.(++done, items.length)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 2, items.length || 1)) }, lane))
  return out
}

// ── 워커 ─────────────────────────────────────────────────────────────────────

interface WorkerReply {
  id: number
  bytes?: ArrayBuffer
  type?: string
  info?: Omit<ConvertResult, 'blob'>
  error?: string
}

let workers: { worker: Worker; busy: boolean }[] | null = null
let workersBroken = false
const waiting: (() => void)[] = []
let nextJob = 1

function workerPool(): { worker: Worker; busy: boolean }[] | null {
  if (workersBroken || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null
  if (!workers) {
    try {
      const n = Math.max(1, Math.min(2, ((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2) - 1))
      workers = Array.from({ length: n }, () => ({
        worker: new Worker(new URL('./convert.worker.ts', import.meta.url), { type: 'module' }),
        busy: false
      }))
    } catch {
      workersBroken = true
      return null
    }
  }
  return workers
}

/** 워커에서 변환 (워커를 못 쓰면 이 스레드에서) — 메인 화면이 덜 끊긴다 */
export async function convertInWorker(blob: Blob, opts: ConvertOptions): Promise<ConvertResult> {
  const pool = workerPool()
  if (!pool) return convertImage(blob, opts)
  let slot = pool.find((s) => !s.busy)
  while (!slot) {
    await new Promise<void>((resolve) => waiting.push(resolve))
    slot = pool.find((s) => !s.busy)
  }
  slot.busy = true
  const s = slot
  const id = nextJob++
  try {
    const bytes = await blob.arrayBuffer()
    return await new Promise<ConvertResult>((resolve, reject) => {
      s.worker.onmessage = (e: MessageEvent<WorkerReply>) => {
        if (e.data.id !== id) return
        if (e.data.bytes && e.data.info) resolve({ ...e.data.info, blob: new Blob([e.data.bytes], { type: e.data.type }) })
        else reject(new Error(e.data.error ?? '변환 실패'))
      }
      s.worker.onerror = (e) => reject(new Error(e.message || '변환 워커 오류'))
      s.worker.postMessage({ id, bytes, type: blob.type || 'image/png', opts }, [bytes])
    })
  } catch {
    // 워커 쪽 실패(오래된 웹뷰 등)는 이 스레드에서 한 번 더 (원본 Blob은 그대로다)
    return convertImage(blob, opts)
  } finally {
    s.worker.onmessage = null
    s.worker.onerror = null
    s.busy = false
    waiting.shift()?.()
  }
}
