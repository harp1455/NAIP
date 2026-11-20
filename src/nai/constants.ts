import type { UcPresetIndex } from './types'

export const MODELS = [
  { value: 'nai-diffusion-4-5-full', label: 'V4.5 Full' },
  { value: 'nai-diffusion-4-5-curated', label: 'V4.5 Curated' },
  { value: 'nai-diffusion-4-full', label: 'V4 Full' },
  { value: 'nai-diffusion-4-curated-preview', label: 'V4 Curated' },
  { value: 'nai-diffusion-5-full', label: 'V5 Full' },
  { value: 'nai-diffusion-5-full-medium', label: 'V5 Full (Medium)' },
  { value: 'nai-diffusion-5-curated', label: 'V5 Curated' }
] as const

export const SAMPLERS = [
  { value: 'k_euler_ancestral', label: 'Euler Ancestral' },
  { value: 'k_euler', label: 'Euler' },
  { value: 'k_dpmpp_2s_ancestral', label: 'DPM++ 2S Ancestral' },
  { value: 'k_dpmpp_2m_sde', label: 'DPM++ 2M SDE' },
  { value: 'k_dpmpp_2m', label: 'DPM++ 2M' },
  { value: 'k_dpmpp_sde', label: 'DPM++ SDE' },
  { value: 'ddim_v3', label: 'DDIM' }
] as const

export const NOISE_SCHEDULES = [
  { value: 'karras', label: 'Karras' },
  { value: 'native', label: 'Native' },
  { value: 'exponential', label: 'Exponential' },
  { value: 'polyexponential', label: 'Polyexponential' }
] as const

export const RESOLUTIONS = [
  { label: '세로', width: 832, height: 1216 },
  { label: '가로', width: 1216, height: 832 },
  { label: '정사각', width: 1024, height: 1024 },
  { label: '큰 세로', width: 1024, height: 1536 },
  { label: '큰 가로', width: 1536, height: 1024 },
  { label: '큰 정사각', width: 1472, height: 1472 },
  { label: '세로 배경화면', width: 1088, height: 1920 },
  { label: '가로 배경화면', width: 1920, height: 1088 },
  { label: '작은 세로', width: 512, height: 768 },
  { label: '작은 가로', width: 768, height: 512 },
  { label: '작은 정사각', width: 640, height: 640 }
] as const

export const UC_PRESET_OPTIONS: { value: UcPresetIndex; label: string }[] = [
  { value: 0, label: 'Heavy' },
  { value: 1, label: 'Light' },
  { value: 3, label: 'Human Focus' },
  { value: 4, label: 'None' }
]

export const REF_TYPES = [
  { value: 'character&style', label: '캐릭터+스타일' },
  { value: 'character', label: '캐릭터' },
  { value: 'style', label: '스타일' }
] as const
