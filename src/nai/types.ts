/** NAIS3 src/shared/types.ts 에서 필요한 부분만 가져옴 */
export interface CharacterPromptInput {
  prompt: string
  negativePrompt: string
  /** 0~1 정규화 좌표. 미지정 시 NAI의 AI's choice */
  center?: { x: number; y: number }
  enabled: boolean
  name?: string
}

/** UC 프리셋 인덱스: 0=Heavy, 1=Light, 3=Human Focus, 4=None. 2는 미사용 */
export type UcPresetIndex = 0 | 1 | 2 | 3 | 4

export interface PromptParts {
  base: string
  additional: string
  detail: string
}

export interface GenerationRequest {
  prompt: string
  promptParts?: PromptParts
  negativePrompt: string
  model: string
  width: number
  height: number
  steps: number
  cfgScale: number
  cfgRescale: number
  sampler: string
  noiseSchedule: string
  seed: number
  variety: boolean
  qualityToggle: boolean
  transparentBackground?: boolean
  ucPreset: UcPresetIndex
  characterPrompts: CharacterPromptInput[]
  useCoords: boolean
}

export interface OpusUsageStatus {
  percent: number
  isNegative: boolean
  timeUntilNextPercent: number
  purchasedPercent?: number
}

export interface SubscriptionInfo {
  tier: 'paper' | 'tablet' | 'scroll' | 'opus'
  anlasFixed: number
  anlasPurchased: number
  usage?: OpusUsageStatus
  expired?: boolean
}
