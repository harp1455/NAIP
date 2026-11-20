import { QUALITY_TAGS_SUFFIX, UC_PRESETS_V45_FULL } from '../nai/presets'
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

function inferUcPreset(uc: string): { preset: UcPresetIndex; rest: string } {
  let best: UcPresetIndex = 4
  let bestLen = -1
  for (const [k, preset] of Object.entries(UC_PRESETS_V45_FULL)) {
    if (!preset || k === '2') continue
    if ((uc === preset || uc.startsWith(preset + ', ')) && preset.length > bestLen) {
      best = Number(k) as UcPresetIndex
      bestLen = preset.length
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

  const rawPrompt = v4?.caption?.base_caption ?? str('prompt') ?? text.Description ?? ''
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
    characters: (v4?.caption?.char_captions ?? []).map((ch, i) => ({
      prompt: ch.char_caption ?? '',
      negative: negChars[i]?.char_caption ?? '',
      ...(useCoords && ch.centers?.[0] ? { center: ch.centers[0] } : {})
    }))
  }
}
