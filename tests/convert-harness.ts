/**
 * convert.ts 브라우저 점검 (캔버스가 필요해 vitest 대신 실제 Chromium에서 돈다).
 * tests/convert.browser.cjs가 vite 개발 서버로 tests/convert-harness.html을 열고 window.runChecks()를 부른다.
 */
import { convertBatch, convertImage, convertInWorker, type ConvertResult } from '../src/project/convert'

interface Check {
  name: string
  ok: boolean
  detail: string
}

// ── PNG 조작 (텍스트 청크 넣기·청크 목록) ───────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** IHDR 뒤에 tEXt 청크(NAI처럼 Comment)를 끼운 PNG */
async function withTextChunk(png: Blob, key: string, text: string): Promise<Blob> {
  const src = new Uint8Array(await png.arrayBuffer())
  const data = new TextEncoder().encode(`${key}\0${text}`)
  const chunk = new Uint8Array(12 + data.length)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, data.length)
  chunk.set(new TextEncoder().encode('tEXt'), 4)
  chunk.set(data, 8)
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)))
  const at = 8 + 25 // 서명 + IHDR
  return new Blob([src.subarray(0, at), chunk, src.subarray(at)], { type: 'image/png' })
}

async function pngChunks(blob: Blob): Promise<string[]> {
  const b = new Uint8Array(await blob.arrayBuffer())
  const view = new DataView(b.buffer)
  const out: string[] = []
  for (let i = 8; i + 8 <= b.length; ) {
    const len = view.getUint32(i)
    out.push(String.fromCharCode(...b.subarray(i + 4, i + 8)))
    i += 12 + len
  }
  return out
}

// ── 시험 그림 ────────────────────────────────────────────────────────────────

function canvasWith(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): OffscreenCanvas {
  const c = new OffscreenCanvas(w, h)
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fill(x, y)
      const i = (y * w + x) * 4
      img.data[i] = r
      img.data[i + 1] = g
      img.data[i + 2] = b
      img.data[i + 3] = a
    }
  }
  ctx.putImageData(img, 0, 0)
  return c
}

let seed = 1
function rand(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}

async function pixels(blob: Blob): Promise<{ w: number; h: number; data: Uint8ClampedArray }> {
  const bmp = await createImageBitmap(blob)
  const c = new OffscreenCanvas(bmp.width, bmp.height)
  const ctx = c.getContext('2d')!
  ctx.drawImage(bmp, 0, 0)
  const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data
  const out = { w: bmp.width, h: bmp.height, data }
  bmp.close()
  return out
}

function px(p: { w: number; data: Uint8ClampedArray }, x: number, y: number): number[] {
  const i = (y * p.w + x) * 4
  return [p.data[i], p.data[i + 1], p.data[i + 2], p.data[i + 3]]
}

const near = (a: number[], b: number[], tol = 6): boolean => a.every((v, i) => Math.abs(v - b[i]) <= tol)

async function digest(blob: Blob): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function info(r: ConvertResult): string {
  const { blob, ...rest } = r
  return JSON.stringify({ ...rest, type: blob.type })
}

// ── 점검 ─────────────────────────────────────────────────────────────────────

async function runChecks(): Promise<Check[]> {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks.push({ name, ok, detail })
  }

  // 1) 불투명 그림 + NAI처럼 알파 최하위 비트(254/255)에 숨긴 정보 + 텍스트 청크
  const stealth = canvasWith(64, 48, (x, y) => [x * 4, y * 5, 128, (x + y) % 3 === 0 ? 254 : 255])
  const original = await withTextChunk(await stealth.convertToBlob({ type: 'image/png' }), 'Comment', '{"prompt":"secret"}')
  const before = await digest(original)
  check('fixture has text chunk', (await pngChunks(original)).includes('tEXt'))
  const fixture = await pixels(original)
  check('fixture keeps alpha 254', px(fixture, 0, 0)[3] === 254, String(px(fixture, 0, 0)))

  const png = await convertImage(original, { format: 'png' })
  const pngPx = await pixels(png.blob)
  const chunks = await pngChunks(png.blob)
  check('png drops text chunks', !chunks.some((c) => c === 'tEXt' || c === 'iTXt' || c === 'zTXt'), chunks.join(','))
  let allOpaque = true
  for (let i = 3; i < pngPx.data.length; i += 4) if (pngPx.data[i] !== 255) allOpaque = false
  check('png scrubs stealth alpha bits', allOpaque, info(png))
  const kept = await pixels((await convertImage(original, { format: 'png', scrubAlpha: false })).blob)
  check('control: without scrub the bits survive', px(kept, 0, 0)[3] === 254, String(px(kept, 0, 0)))
  check('original untouched', (await digest(original)) === before)

  // 2) 투명 그림: 왼쪽 절반 투명, 오른쪽 빨강, 가운데 줄은 반투명(숨은 비트 후보)
  const transparent = await canvasWith(40, 20, (x) =>
    x < 20 ? [0, 0, 0, 0] : x === 20 ? [255, 0, 0, 100] : [255, 0, 0, 255]
  ).convertToBlob({ type: 'image/png' })
  const jpg = await convertImage(transparent, { format: 'jpeg', background: '#00ff00', quality: 0.95 })
  const jpgPx = await pixels(jpg.blob)
  check('jpeg output type', jpg.blob.type === 'image/jpeg' && jpg.format === 'jpeg', info(jpg))
  check('jpeg flattens transparency on the background', near(px(jpgPx, 5, 10), [0, 255, 0, 255], 12), String(px(jpgPx, 5, 10)))
  check('jpeg warns about transparency', jpg.warnings.some((w) => w.includes('투명')), jpg.warnings.join(' / '))
  const opaqueJpg = await convertImage(original, { format: 'jpeg' })
  check('jpeg of an opaque image has no warning', opaqueJpg.warnings.length === 0, opaqueJpg.warnings.join(' / '))
  const tpng = await pixels((await convertImage(transparent, { format: 'png' })).blob)
  check('png keeps transparency', px(tpng, 5, 10)[3] === 0 && px(tpng, 30, 10)[3] === 255, `${px(tpng, 5, 10)} ${px(tpng, 30, 10)}`)
  check('png forces odd alpha on semi-transparent pixels', px(tpng, 20, 10)[3] % 2 === 1, String(px(tpng, 20, 10)))
  const twebp = await convertImage(transparent, { format: 'webp', quality: 0.9 })
  const twebpPx = await pixels(twebp.blob)
  check('webp output type', twebp.blob.type === 'image/webp', info(twebp))
  check('webp keeps transparency', px(twebpPx, 5, 10)[3] === 0 && px(twebpPx, 30, 10)[3] > 250, `${px(twebpPx, 5, 10)} ${px(twebpPx, 30, 10)}`)

  // 3) 크기·여백·자르기
  const tall = await canvasWith(83, 121, () => [0, 0, 255, 255]).convertToBlob({ type: 'image/png' })
  const small = await convertImage(tall, { format: 'webp', maxWidth: 40, maxHeight: 40 })
  check('max box keeps aspect', small.width === 27 && small.height === 40, info(small))
  const boxed = await convertImage(tall, { format: 'png', width: 100, height: 100, padColor: '#ff0000' })
  const boxedPx = await pixels(boxed.blob)
  check('contain pads with color', boxed.width === 100 && near(px(boxedPx, 1, 50), [255, 0, 0, 255]) && near(px(boxedPx, 50, 50), [0, 0, 255, 255]), `${px(boxedPx, 1, 50)} ${px(boxedPx, 50, 50)}`)
  const cropped = await convertImage(tall, { format: 'png', crop: { mode: 'center', aspect: 1 } })
  check('center crop', cropped.width === 83 && cropped.height === 83, info(cropped))
  const padded = await convertImage(tall, { format: 'jpeg', padding: 5, padColor: '#ffffff' })
  const paddedPx = await pixels(padded.blob)
  check('padding adds a border', padded.width === 93 && padded.height === 131 && near(px(paddedPx, 1, 1), [255, 255, 255, 255]), info(padded))

  // 4) 목표 파일 크기
  const noise = await canvasWith(256, 256, () => [rand() * 255, rand() * 255, rand() * 255, 255]).convertToBlob({ type: 'image/png' })
  const at = async (q: number): Promise<number> => (await convertImage(noise, { format: 'webp', quality: q })).bytes
  const s92 = await at(0.92)
  const s60 = await at(0.6)
  check('webp size shrinks with quality', s60 < s92, `${s60} < ${s92}`)
  const target = Math.round((s92 + s60) / 2)
  const hit = await convertImage(noise, { format: 'webp', quality: 0.92, minQuality: 0.6, targetBytes: target })
  check(
    'target size reached within 6 encodes',
    hit.reachedTarget === true && hit.bytes <= target && hit.encodes <= 6 && (hit.quality ?? 0) >= 0.6 && (hit.quality ?? 1) < 0.92,
    `${info(hit)} target=${target}`
  )
  const miss = await convertImage(noise, { format: 'webp', quality: 0.92, minQuality: 0.6, targetBytes: Math.round(s60 / 2) })
  check(
    'unreachable target: best attempt at the floor + warning',
    miss.reachedTarget === false && miss.quality === 0.6 && miss.encodes <= 6 && miss.warnings.some((w) => w.includes('목표 크기')),
    info(miss)
  )
  const jpgMiss = await convertImage(noise, { format: 'jpeg', quality: 0.9, minQuality: 0.7, targetBytes: 1000, maxIterations: 50 })
  check('quality never drops below the floor', jpgMiss.quality === 0.7 && jpgMiss.encodes <= 12, info(jpgMiss))
  const pngSize = (await convertImage(noise, { format: 'png' })).bytes
  const pngMiss = await convertImage(noise, { format: 'png', targetBytes: Math.round(pngSize / 3) })
  check('png over target warns without shrinking', pngMiss.reachedTarget === false && pngMiss.width === 256 && pngMiss.encodes === 1 && pngMiss.warnings.some((w) => w.includes('PNG')), info(pngMiss))
  const pngFit = await convertImage(noise, { format: 'png', targetBytes: Math.round(pngSize / 3), allowDownscale: true, minScale: 0.3 })
  check('png downscales to fit when allowed', pngFit.reachedTarget === true && pngFit.bytes <= pngSize / 3 && pngFit.width < 256 && pngFit.scale < 1 && pngFit.encodes <= 6, info(pngFit))

  // 5) 워커 + 일괄 변환
  const worker = new Worker(new URL('../src/project/convert.worker.ts', import.meta.url), { type: 'module' })
  const bytes = await tall.arrayBuffer()
  const reply = await new Promise<{ bytes?: ArrayBuffer; type?: string; info?: { width: number }; error?: string }>((resolve) => {
    worker.onmessage = (e) => resolve(e.data)
    worker.onerror = (e) => resolve({ error: e.message })
    worker.postMessage({ id: 1, bytes, type: 'image/png', opts: { format: 'webp', maxWidth: 30 } }, [bytes])
  })
  worker.terminate()
  check('worker converts', reply.type === 'image/webp' && reply.info?.width === 30 && (reply.bytes?.byteLength ?? 0) > 0, JSON.stringify({ ...reply, bytes: reply.bytes?.byteLength }))
  const viaPool = await convertInWorker(tall, { format: 'jpeg', maxHeight: 50 })
  check('convertInWorker', viaPool.blob.type === 'image/jpeg' && viaPool.height === 50, info(viaPool))

  let progress = 0
  const batch = await convertBatch(
    [{ blob: tall }, { blob: new Blob(['not an image'], { type: 'image/png' }) }, { blob: original }],
    { format: 'webp', maxWidth: 20 },
    { concurrency: 2, onProgress: (d) => (progress = d) }
  )
  check(
    'batch keeps going after a broken image',
    !!batch[0].result && !!batch[1].error && !!batch[2].result && progress === 3,
    JSON.stringify(batch.map((b) => (b.result ? b.result.width : b.error)))
  )
  return checks
}

;(window as unknown as { runChecks: typeof runChecks }).runChecks = runChecks
