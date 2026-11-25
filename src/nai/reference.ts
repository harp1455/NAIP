/**
 * NovelAI 정밀(캐릭터) 레퍼런스 규칙 — V5 개방(2026-11-24) 반영.
 * 종류 ↔ 요청 base_caption 변환과 V5 이미지 크기 표는 SDStudio(MIT, © sunho)의 naiReference.ts 에서 가져왔다
 * (공식 웹 클라이언트와 같은 표·식).
 *
 * - V4.5: 캐릭터 / 스타일 / 캐릭터+스타일, Strength 0~1 + Fidelity, 검정 여백 캔버스
 * - V5 Full·Curated: + 의상(costume), 캐릭터 계열에 "같은 의상 선호", Strength 0~5, Fidelity 없음,
 *   이미지는 종횡비가 가장 가까운 칸에 맞춰 가운데를 잘라 보냄. 인페인트와는 함께 못 쓴다
 * - V4, V5 Medium: 지원하지 않음
 */
import { isMediumEffortModel, modelCapabilities, type NaiModelCapabilities } from './models'

export type ReferenceType = 'character' | 'style' | 'character&style' | 'costume'

/** "같은 의상 선호"의 실효값 — 캐릭터는 기본 꺼짐, 캐릭터+스타일은 기본 켜짐, 그 밖은 해당 없음 */
export function effectiveSameOutfit(type: ReferenceType, sameOutfit: boolean | undefined): boolean | undefined {
  if (type === 'character') return sameOutfit ?? false
  if (type === 'character&style') return sameOutfit ?? true
  return undefined
}

/** 저장값 → 요청 base_caption. null = 이 모델에는 보내지 않는다 (의상을 모르는 모델의 costume) */
export function referenceCaption(
  type: ReferenceType,
  sameOutfit: boolean | undefined,
  caps: Pick<NaiModelCapabilities, 'outfitReference'>
): string | null {
  if (!caps.outfitReference) return type === 'costume' ? null : type
  if (type === 'character') return sameOutfit === true ? 'character_mainoutfit' : 'character'
  if (type === 'character&style') return sameOutfit === false ? 'character&style_anyoutfit' : 'character&style'
  return type
}

export function clampReferenceStrength(strength: number, caps: Pick<NaiModelCapabilities, 'referenceStrengthMax'>): number {
  if (!Number.isFinite(strength)) return 0
  return Math.min(Math.max(strength, 0), caps.referenceStrengthMax)
}

/** 레퍼런스를 못 쓰는 이유 (쓸 수 있으면 null) */
export function referenceBlockReason(model: string, inpaint = false): string | null {
  const caps = modelCapabilities(model)
  if (!caps.characterReferences) {
    return isMediumEffortModel(model)
      ? 'V5 Medium에서는 레퍼런스를 쓸 수 없습니다 (V5 Full로 바꾸세요)'
      : '이 모델은 레퍼런스를 지원하지 않습니다 (V4.5 또는 V5 Full·Curated)'
  }
  if (inpaint && !caps.referenceWithInpaint) return 'V5 인페인트에는 아직 레퍼런스가 적용되지 않습니다'
  return null
}

/** 이 모델·요청으로 실제 보낼 레퍼런스만 고른다 (생성·비용 계산·배지 표시 공용) */
export function referencesForModel<T extends { enabled: boolean; type: ReferenceType; sameOutfit?: boolean }>(
  refs: readonly T[],
  model: string,
  inpaint = false
): T[] {
  if (referenceBlockReason(model, inpaint)) return []
  const caps = modelCapabilities(model)
  return refs.filter((r) => r.enabled && referenceCaption(r.type, r.sameOutfit, caps) !== null)
}

// ── V5 레퍼런스 이미지 크기 표 ──────────────────────────────────────────────

export const V5_REFERENCE_BUCKETS: readonly (readonly [number, number])[] = [
  [256, 4096], [256, 4032], [256, 3968], [256, 3904], [256, 3840], [256, 3776], [256, 3712], [256, 3648],
  [256, 3584], [256, 3520], [256, 3456], [256, 3392], [256, 3328], [320, 3264], [320, 3200], [320, 3136],
  [320, 3072], [320, 3008], [320, 2944], [320, 2880], [320, 2816], [320, 2752], [384, 2688], [384, 2624],
  [384, 2560], [384, 2496], [384, 2432], [384, 2368], [448, 2304], [448, 2240], [448, 2176], [448, 2112],
  [512, 2048], [512, 1984], [512, 1920], [512, 1856], [576, 1792], [576, 1728], [576, 1664], [640, 1600],
  [640, 1536], [704, 1472], [704, 1408], [768, 1344], [768, 1280], [832, 1216], [896, 1152], [960, 1088],
  [1024, 1024], [1088, 960], [1152, 896], [1216, 832], [1280, 768], [1344, 768], [1408, 704], [1472, 704],
  [1536, 640], [1600, 640], [1664, 576], [1728, 576], [1792, 576], [1856, 512], [1920, 512], [1984, 512],
  [2048, 512], [2112, 448], [2176, 448], [2240, 448], [2304, 448], [2368, 384], [2432, 384], [2496, 384],
  [2560, 384], [2624, 384], [2688, 384], [2752, 320], [2816, 320], [2880, 320], [2944, 320], [3008, 320],
  [3072, 320], [3136, 320], [3200, 320], [3264, 320], [3328, 256], [3392, 256], [3456, 256], [3520, 256],
  [3584, 256], [3648, 256], [3712, 256], [3776, 256], [3840, 256], [3904, 256], [3968, 256], [4032, 256],
  [4096, 256]
]

export interface ReferenceBucketPlan {
  width: number
  height: number
  resizeWidth: number
  resizeHeight: number
  left: number
  top: number
}

/**
 * 원본(w×h)을 로그 종횡비가 가장 가까운 칸에 덮도록 늘이거나 줄인 뒤 가운데를 잘라 내는 계획.
 * 원본을 resizeWidth×resizeHeight 로 그린 다음 (left, top) 에서 width×height 를 잘라 낸다.
 */
export function planReferenceBucket(w: number, h: number): ReferenceBucketPlan {
  const aspect = Math.log(Math.max(w, 1) / Math.max(h, 1))
  let best = V5_REFERENCE_BUCKETS[0]
  let bestDiff = Infinity
  for (const b of V5_REFERENCE_BUCKETS) {
    const d = Math.abs(aspect - Math.log(b[0] / b[1]))
    if (d < bestDiff) {
      best = b
      bestDiff = d
    }
  }
  const [W, H] = best
  const scale = Math.max(W / w, H / h)
  const rw = Math.max(Math.floor(w * scale + 0.5), W)
  const rh = Math.max(Math.floor(h * scale + 0.5), H)
  return {
    width: W,
    height: H,
    resizeWidth: rw,
    resizeHeight: rh,
    left: Math.floor((rw - W) / 2),
    top: Math.floor((rh - H) / 2)
  }
}
