import { effectiveSteps, isMediumEffortModel } from './models'

/**
 * Anlas 비용 추정 — NAIS3 src/shared/anlas.ts 이식 (NAI 웹 번들의 비용 함수).
 * - V4/4.5: ceil(2.951823174884865e-6·px + 5.753298233447344e-7·px·steps)
 * - i2i/인페인트: ceil(비용 × strength), 최소 2
 * - Opus 무료: px ≤ 1024² && steps ≤ 28 (요청당 1장 → 1장씩 N번 요청이면 전부 무료)
 * - 캐릭터 레퍼런스: 장당 5 Anlas, 바이브 인코딩: 1회 2 Anlas (캐시 시 0)
 */
export interface AnlasEstimateInput {
  model?: string
  width: number
  height: number
  steps: number
  strength?: number
  charRefCount?: number
  isOpus: boolean
  batchCount: number
  unencodedVibes?: number
  vibeCount?: number
  opusUsageExhausted?: boolean
}

export interface AnlasEstimate {
  perImage: number
  generation: number
  charRef: number
  vibeEncoding: number
  vibeGeneration: number
  total: number
  free: boolean
  usesOpusUsage: boolean
}

const VIBE_ENCODE_COST = 2
const MEDIUM_EFFORT_STEP_FACTOR = 1 / 1.06521739
const CHARREF_COST = 5

function freeEligible(input: AnlasEstimateInput): boolean {
  const px = Math.max(input.width * input.height, 65536)
  const steps = effectiveSteps(input.model ?? '', input.steps)
  const isV5 = input.model?.startsWith('nai-diffusion-5-') ?? false
  if (!input.isOpus) return false
  if (isV5 && input.opusUsageExhausted !== false) return false
  return px <= 1048576 && steps <= 28
}

export function estimateAnlas(input: AnlasEstimateInput): AnlasEstimate {
  const px = Math.max(input.width * input.height, 65536)
  const strength = input.strength ?? 1
  const medium = isMediumEffortModel(input.model ?? '')
  const steps = effectiveSteps(input.model ?? '', input.steps)
  const stepFactor = medium ? MEDIUM_EFFORT_STEP_FACTOR : 1
  let base = Math.ceil(2.951823174884865e-6 * px + 5.753298233447344e-7 * px * steps * stepFactor)
  const isV5 = input.model?.startsWith('nai-diffusion-5-') ?? false
  if (isV5) base *= 1.5
  const perImage = Math.max(Math.ceil(base * strength), 2)
  const free = freeEligible(input)
  const generation = free ? 0 : perImage * input.batchCount
  const charRef = (input.charRefCount ?? 0) * CHARREF_COST * input.batchCount
  const vibeEncoding = (input.unencodedVibes ?? 0) * VIBE_ENCODE_COST
  const multivibe =
    input.model?.startsWith('nai-diffusion-4-') || input.model?.startsWith('nai-diffusion-5-')
  const vibeGeneration = multivibe
    ? Math.max((input.vibeCount ?? 0) - 4, 0) * 2 * input.batchCount
    : 0
  const total = generation + charRef + vibeEncoding + vibeGeneration
  return {
    perImage,
    generation,
    charRef,
    vibeEncoding,
    vibeGeneration,
    total,
    free: total === 0,
    usesOpusUsage: isV5 && free
  }
}

export const UPSCALE_ANLAS_COST = 1

/** 디렉터 툴 비용 (NAIS3 directorAugmentCost): 1~3MP로 정규화한 28스텝 생성 비용. 배경 제거는 3배+5, 무료 없음 */
export function directorCost(method: string, width: number, height: number, isOpus: boolean): number {
  if (width <= 0 || height <= 0) return 0
  let w = width
  let h = height
  const maxPixels = 3_145_728
  const minPixels = 1_048_576
  if (w * h > maxPixels) {
    const r = Math.sqrt(maxPixels / (w * h))
    w = Math.floor(w * r)
    h = Math.floor(h * r)
  }
  if (w * h < minPixels) {
    const r = Math.sqrt(minPixels / (w * h))
    w = Math.floor(w * r)
    h = Math.floor(h * r)
  }
  const bg = method === 'bg-removal'
  const est = estimateAnlas({ width: w, height: h, steps: 28, isOpus: bg ? false : isOpus, batchCount: 1 })
  return bg ? est.perImage * 3 + 5 : est.generation
}
