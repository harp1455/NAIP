import { stripAutoText } from '../nai/auto-text'
import { QUALITY_TAGS_SUFFIX, UC_PRESETS_V45_FULL, UC_PRESETS_V5 } from '../nai/presets'
import type { UcPresetIndex } from '../nai/types'

/** NAI가 PNG tEXt "Comment"에 넣는 생성 파라미터에서 뽑은, 설정으로 되돌릴 수 있는 값들 */
export interface ImportedSettings {
  prompt: string
  negative: string
  qualityToggle: boolean
  ucPreset: UcPresetIndex
  model?: string
  seed?: number
  steps?: number
  cfgScale?: number
  cfgRescale?: number
  sampler?: string
  noiseSchedule?: string
  width?: number
  height?: number
  variety?: boolean
  characters: { prompt: string; negative: string; center?: { x: number; y: number } }[]
  /** 이미지에 들어 있던 바이브 트랜스퍼 (인코딩된 형태 — 원본 그림 없이 그대로 다시 쓸 수 있다) */
  vibes: MetadataVibe[]
  /** 바이브가 인코딩된 모델. 확인된 Source 값일 때만 — 모르면 사용자가 고른다 */
  vibeModel?: string
}

export interface MetadataVibe {
  encoded: string
  strength: number
  infoExtracted: number
}

/** 외부 PNG는 믿을 수 없으므로 배열이 아무리 길어도 이만큼만 읽는다 */
const MAX_METADATA_VIBES = 16
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** 바이브 인코딩은 모델별이라 정확히 확인된 Source 문자열만 모델로 인정한다 (NAIS3 metadata-vibes.ts) */
const VIBE_SOURCE_MODELS: Record<string, string> = {
  'NovelAI Diffusion V4.5 1229B44F': 'nai-diffusion-4-5-full',
  'NovelAI Diffusion V4.5 C02D4F98': 'nai-diffusion-4-5-curated'
}

function parseVibes(c: Record<string, unknown>): MetadataVibe[] {
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
  const unit = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined
  const images = list(c.reference_image_multiple).slice(0, MAX_METADATA_VIBES)
  const strengths = list(c.reference_strength_multiple)
  const infos = list(c.reference_information_extracted_multiple)
  const out: MetadataVibe[] = []
  images.forEach((raw, i) => {
    const encoded = typeof raw === 'string' ? raw.trim() : ''
    // 길이가 어긋난 base64는 잘린 값이라 버린다
    if (!encoded || !BASE64.test(encoded)) return
    out.push({ encoded, strength: unit(strengths[i]) ?? 0.6, infoExtracted: unit(infos[i]) ?? 1 })
  })
  return out
}

const SOURCE_TO_MODEL: [RegExp, string][] = [
  [/4\.5.*curated|4-5-curated/i, 'nai-diffusion-4-5-curated'],
  [/4\.5|4-5/i, 'nai-diffusion-4-5-full'],
  [/V4.*curated|4-curated/i, 'nai-diffusion-4-curated-preview'],
  [/V4|diffusion-4/i, 'nai-diffusion-4-full']
]

function pngTextChunks(buf: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {}
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (buf.length < 8 || sig.some((b, i) => buf[i] !== b)) return out
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const latin1 = new TextDecoder('latin1')
  const utf8 = new TextDecoder('utf-8')
  let off = 8
  while (off + 8 <= buf.length) {
    const len = view.getUint32(off)
    const type = latin1.decode(buf.subarray(off + 4, off + 8))
    const data = buf.subarray(off + 8, off + 8 + len)
    if (off + 8 + len > buf.length || type === 'IEND') break
    if (type === 'tEXt') {
      const nul = data.indexOf(0)
      // NAI는 tEXt에 UTF-8을 그대로 쓴다 (표준은 latin1이지만 한글·일본어 프롬프트가 들어감)
      if (nul >= 0) out[latin1.decode(data.subarray(0, nul))] = utf8.decode(data.subarray(nul + 1))
    } else if (type === 'iTXt') {
      const nul = data.indexOf(0)
      if (nul >= 0 && data[nul + 1] === 0) {
        let p = data.indexOf(0, nul + 3) + 1
        p = data.indexOf(0, p) + 1
        out[latin1.decode(data.subarray(0, nul))] = utf8.decode(data.subarray(p))
      }
    }
    off += 12 + len
  }
  return out
}

/**
 * 병합된 네거티브에서 UC 프리셋을 찾아 벗긴다 (가장 긴 접두가 이긴다).
 * V4.5와 V5는 프리셋 문구가 다르고, V5 Full은 그 앞에 "nsfw, "를 더 붙인다.
 */
function inferUcPreset(uc: string): { preset: UcPresetIndex; rest: string } {
  let best: UcPresetIndex = 4
  let bestLen = -1
  for (const k of [0, 1, 3] as const) {
    const v5 = UC_PRESETS_V5[k]
    for (const preset of [UC_PRESETS_V45_FULL[k], v5, v5 && `nsfw, ${v5}`]) {
      if (!preset) continue
      if ((uc === preset || uc.startsWith(preset + ', ')) && preset.length > bestLen) {
        best = k
        bestLen = preset.length
      }
    }
  }
  return { preset: best, rest: bestLen < 0 ? uc : uc.slice(bestLen).replace(/^,\s*/, '') }
}

/** PNG에서 NAI 생성 설정을 읽는다. NAI 메타데이터가 없으면 null */
export async function readImageSettings(blob: Blob): Promise<ImportedSettings | null> {
  const text = pngTextChunks(new Uint8Array(await blob.arrayBuffer()))
  if (!text.Comment) return null
  let c: Record<string, unknown>
  try {
    c = JSON.parse(text.Comment) as Record<string, unknown>
  } catch {
    return null
  }
  const num = (k: string): number | undefined => (typeof c[k] === 'number' ? (c[k] as number) : undefined)
  const str = (k: string): string | undefined => (typeof c[k] === 'string' ? (c[k] as string) : undefined)
  type Caption = { caption?: { base_caption?: string; char_captions?: { char_caption?: string; centers?: { x: number; y: number }[] }[] }; use_coords?: boolean }
  const v4 = c.v4_prompt as Caption | undefined
  const v4n = c.v4_negative_prompt as Caption | undefined

  const sentPrompt = v4?.caption?.base_caption ?? str('prompt') ?? text.Description ?? ''
  // V5 Auto Text가 자동으로 붙인 `teXt:` 블록은 퀄리티 태그 뒤에 오므로 먼저 떼어야 접미사가 보인다
  const rawPrompt = stripAutoText(
    sentPrompt,
    (v4?.caption?.char_captions ?? []).map((ch) => ({ prompt: ch.char_caption ?? '', center: ch.centers?.[0] })),
    v4?.use_coords === true
  )
  const qualityToggle = rawPrompt.endsWith(QUALITY_TAGS_SUFFIX)
  const uc = inferUcPreset(v4n?.caption?.base_caption ?? str('uc') ?? '')
  const useCoords = v4?.use_coords === true
  const negChars = v4n?.caption?.char_captions ?? []
  const source = text.Source ?? ''
  return {
    prompt: qualityToggle ? rawPrompt.slice(0, -QUALITY_TAGS_SUFFIX.length) : rawPrompt,
    negative: uc.rest,
    qualityToggle,
    ucPreset: uc.preset,
    model: SOURCE_TO_MODEL.find(([re]) => re.test(source))?.[1],
    seed: num('seed'),
    steps: num('steps'),
    cfgScale: num('scale'),
    cfgRescale: num('cfg_rescale'),
    sampler: str('sampler'),
    noiseSchedule: str('noise_schedule'),
    width: num('width'),
    height: num('height'),
    variety: c.skip_cfg_above_sigma != null,
    vibes: parseVibes(c),
    ...(VIBE_SOURCE_MODELS[source.trim()] ? { vibeModel: VIBE_SOURCE_MODELS[source.trim()] } : {}),
    characters: (v4?.caption?.char_captions ?? []).map((ch, i) => ({
      prompt: ch.char_caption ?? '',
      negative: negChars[i]?.char_caption ?? '',
      ...(useCoords && ch.centers?.[0] ? { center: ch.centers[0] } : {})
    }))
  }
}
