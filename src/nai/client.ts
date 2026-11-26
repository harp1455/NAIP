import JSZip from 'jszip'
import { ENDPOINTS } from './endpoints'
import { buildGenerateImagePayload, type BuildOptions } from './payload'
import { parseSubscriptionResponse, type NaiSubscriptionResponse } from './subscription'
import type { GenerationRequest, SubscriptionInfo } from './types'

/**
 * NAI HTTP 클라이언트 (NAIS3 src/main/nai/client.ts 기반).
 * image.novelai.net 은 CORS(*)를 허용하므로 WebView의 fetch로 직접 호출한다.
 * 허용 헤더는 Authorization, Content-Type 뿐이라 그 외 커스텀 헤더는 보내지 않는다.
 */
export class NaiHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'NaiHttpError'
  }
}

function parseRetryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after')
  if (!h) return undefined
  const secs = Number(h)
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
  const at = Date.parse(h)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

function headers(token: string, json = true): Record<string, string> {
  return {
    Authorization: `Bearer ${token.trim()}`,
    ...(json ? { 'Content-Type': 'application/json' } : {})
  }
}

async function fail(label: string, res: Response): Promise<never> {
  const text = await res.text().catch(() => '')
  let detail = text.slice(0, 300)
  try {
    const j = JSON.parse(text) as { message?: string }
    if (j.message) detail = j.message
  } catch {
    /* 본문이 JSON이 아니면 그대로 */
  }
  throw new NaiHttpError(`${label} (${res.status}) ${detail}`, res.status, parseRetryAfterMs(res))
}

export async function fetchSubscription(token: string): Promise<SubscriptionInfo> {
  const res = await fetch(ENDPOINTS.subscription, { headers: headers(token, false) })
  if (res.status === 401) throw new NaiHttpError('토큰이 올바르지 않습니다', 401)
  if (!res.ok) await fail('구독 정보 조회 실패', res)
  return parseSubscriptionResponse((await res.json()) as NaiSubscriptionResponse)
}

/** 비스트리밍 생성 (zip 응답). 요청당 항상 1장(n_samples: 1). */
export async function generateImage(
  token: string,
  request: GenerationRequest,
  buildOpts: Omit<BuildOptions, 'stream'> = {},
  signal?: AbortSignal
): Promise<{
  image: Blob
  payload: ReturnType<typeof buildGenerateImagePayload>
  /** 어디서 시간이 걸렸는지 보기 위한 측정값 */
  stats: { sentBytes: number; receivedBytes: number; waitMs: number; downloadMs: number }
}> {
  const payload = buildGenerateImagePayload(request, buildOpts)
  const body = JSON.stringify(payload)
  const t0 = performance.now()
  const res = await fetch(ENDPOINTS.generateImage, {
    method: 'POST',
    headers: headers(token),
    body,
    signal
  })
  if (!res.ok) await fail('생성 실패', res)
  // 여기까지가 "올려 보내기 + 서버가 그리는 시간", 이후가 결과 내려받기
  const t1 = performance.now()
  const buffer = await res.arrayBuffer()
  const t2 = performance.now()
  const zip = await JSZip.loadAsync(buffer)
  const entryName = Object.keys(zip.files)[0]
  if (!entryName) throw new Error('응답 zip에 이미지가 없습니다')
  const bytes = await zip.file(entryName)!.async('uint8array')
  const type = (buildOpts.imageFormat ?? 'png') === 'webp' ? 'image/webp' : 'image/png'
  return {
    image: new Blob([bytes as BlobPart], { type }),
    payload,
    // base64·영문 JSON이라 글자 수가 곧 바이트 수에 가깝다
    stats: { sentBytes: body.length, receivedBytes: buffer.byteLength, waitMs: t1 - t0, downloadMs: t2 - t1 }
  }
}

/** 바이브 인코딩 (1회 2 Anlas). 인코딩된 바이브를 base64로 돌려준다. */
export async function encodeVibe(
  token: string,
  imageBase64: string,
  informationExtracted: number,
  model: string,
  signal?: AbortSignal
): Promise<string> {
  const res = await fetch(ENDPOINTS.encodeVibe, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ image: imageBase64, information_extracted: informationExtracted, model }),
    signal
  })
  if (!res.ok) await fail('바이브 인코딩 실패', res)
  const bytes = new Uint8Array(await res.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

async function lastZipImage(res: Response, pick?: RegExp): Promise<Blob> {
  const zip = await JSZip.loadAsync(await res.arrayBuffer())
  const names = Object.keys(zip.files)
  const entry = pick ? names.find((n) => pick.test(n)) : names[names.length - 1]
  if (!entry) throw new Error('응답 zip에 이미지가 없습니다')
  const bytes = await zip.file(entry)!.async('uint8array')
  return new Blob([bytes as BlobPart], { type: 'image/png' })
}

export type DirectorMethod =
  | 'bg-removal'
  | 'lineart'
  | 'sketch'
  | 'colorize'
  | 'emotion'
  | 'declutter'
  | 'declutter-keep-bubbles'

/** 디렉터 툴 (augment-image). colorize/emotion만 prompt·defry를 보낸다. zip의 마지막 항목이 결과 */
export async function augmentImage(
  token: string,
  opts: {
    method: DirectorMethod
    imageBase64: string
    width: number
    height: number
    prompt?: string
    defry?: number
  },
  signal?: AbortSignal
): Promise<Blob> {
  const body: Record<string, unknown> = {
    req_type: opts.method,
    image: opts.imageBase64,
    width: opts.width,
    height: opts.height
  }
  if (opts.prompt !== undefined) body.prompt = opts.prompt
  if (opts.defry !== undefined) body.defry = opts.defry
  const res = await fetch(ENDPOINTS.augmentImage, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok) await fail('디렉터 툴 실패', res)
  return lastZipImage(res)
}

export const UPSCALE_MODEL = 'nai-diffusion-5-curated'

/** V5 Curated 2x 업스케일 (고정 1 Anlas). multipart: image 파트 + request(JSON) 파트 */
export async function upscaleImage(token: string, image: Blob, signal?: AbortSignal): Promise<Blob> {
  const body = new FormData()
  body.append('image', image)
  body.append(
    'request',
    new Blob([JSON.stringify({ image: 'image', model: UPSCALE_MODEL, declared_blur_sigma: 0 })], {
      type: 'application/json'
    })
  )
  const res = await fetch(ENDPOINTS.upscale, {
    method: 'POST',
    headers: headers(token, false),
    body,
    signal
  })
  if (!res.ok) await fail('업스케일 실패', res)
  return lastZipImage(res, /^image.*\.png$/i)
}
