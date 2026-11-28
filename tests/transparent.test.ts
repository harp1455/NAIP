/// <reference types="node" />
/**
 * V5 배경 투명 — 생성 설정 칸이 모든 생성 경로(메인·다시 생성·i2i·인페인트·프로젝트)의 요청에 실리는지,
 * 예전 설정을 꺼짐으로 읽는지, 메타데이터·설정 적용·NAIS3 가져오기/내보내기, 썸네일 체크무늬 합치기.
 * 네트워크는 흉내 낸다 — 실제 NovelAI API는 부르지 않는다 (요청 JSON은 진짜 payload 조립기로 만든다).
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 스토어들이 localStorage 를 쓴다 (node 에는 없다) — 가져오기 전에 메모리 것을 둔다
vi.hoisted(() => {
  const m = new Map<string, string>()
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    }
  }
})

const sent: { model: string; action: string; input: string; parameters: Record<string, unknown> }[] = []
vi.mock('../src/nai/client', async () => {
  const { buildGenerateImagePayload } = await vi.importActual<typeof import('../src/nai/payload')>('../src/nai/payload')
  class NaiHttpError extends Error {
    status = 0
    retryAfterMs?: number
  }
  return {
    NaiHttpError,
    fetchSubscription: vi.fn(async () => {
      throw new Error('offline')
    }),
    encodeVibe: vi.fn(),
    generateImageStream: vi.fn(),
    generateImage: vi.fn(async (_token: string, request: import('../src/nai/types').GenerationRequest, opts: import('../src/nai/payload').BuildOptions) => {
      const payload = buildGenerateImagePayload(request, opts)
      sent.push(payload)
      return {
        image: new Blob([new Uint8Array(64)], { type: 'image/png' }),
        payload,
        stats: { waitMs: 1, downloadMs: 1, sentBytes: 1, receivedBytes: 1 }
      }
    })
  }
})
vi.mock('../src/lib/image', () => ({
  makeThumb: async () => 'data:image/jpeg;base64,AAAA',
  normalizeInpaintMask: async () => 'MASK',
  processCharRefImage: async () => '',
  processCharRefImageV5: async () => '',
  resizeToPngBase64: async () => 'SRC',
  toPngBase64: async () => ({ base64: 'SRC', width: 832, height: 1216 }),
  blobToBase64: async () => '',
  loadImage: async () => ({ naturalWidth: 1, naturalHeight: 1 }),
  scrubAlpha: () => {}
}))

import { buildGenerateImagePayload } from '../src/nai/payload'
import { NAI_V5_CURATED, NAI_V5_FULL, NAI_V5_FULL_MEDIUM, sendsTransparentBackground } from '../src/nai/models'
import type { GenerationRequest } from '../src/nai/types'
import { CHECKER_DARK, CHECKER_LIGHT, checkerStyle, flattenOnChecker, generatedTransparent, hasAlphaBackground } from '../src/lib/alpha'
import { applyImport, availableParts, fromMetadata, fromSnapshot } from '../src/lib/apply'
import { readImageSettings, stripTransparentTag } from '../src/lib/metadata'
import { describeImage } from '../src/lib/share'
import type { HistoryMeta, SettingsSnapshot } from '../src/lib/db'
import { setStorageForTests } from '../src/storage'
import { createSqlJsDriver } from '../src/storage/sqljs'
import { memoryFileStore } from '../src/storage/files'
import { useGeneration } from '../src/stores/generation'
import { useHistory } from '../src/stores/history'
import { usePrompt, withParamDefaults, type Params } from '../src/stores/prompt'
import { useSettings } from '../src/stores/settings'
import { useSource } from '../src/stores/source'
import { useCharacters } from '../src/stores/characters'
import { planJobs, useProjects } from '../src/project'
import { enqueueJobs } from '../src/project/run'
import { bytesSource, exportNais3, importNais3, memorySink, naipToNais3, readNaisArchive, type BackupData } from '../src/backup'

const TAG = 'transparent background'
const QUALITY = ', very aesthetic, masterpiece, no text'

const OLD_PARAMS = {
  model: NAI_V5_FULL,
  width: 832,
  height: 1216,
  steps: 23,
  cfgScale: 7,
  cfgRescale: 0,
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  variety: false,
  qualityToggle: true,
  ucPreset: 0 as const
}

const req = (p: Partial<GenerationRequest> = {}): GenerationRequest => ({
  prompt: '1girl, smile',
  negativePrompt: 'lowres',
  model: NAI_V5_FULL,
  width: 832,
  height: 1216,
  steps: 23,
  cfgScale: 7,
  cfgRescale: 0,
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  seed: 1,
  variety: false,
  qualityToggle: true,
  ucPreset: 0,
  characterPrompts: [],
  useCoords: false,
  ...p
})
const alphaFields = (p: { parameters: Record<string, unknown> }): unknown[] => [p.parameters.straight_alpha, p.parameters.tag_hint_transparent_background]

describe('payload', () => {
  it('adds straight_alpha, the tag hint and the prompt tag only for V5 with the toggle on', () => {
    for (const model of [NAI_V5_FULL, NAI_V5_CURATED, NAI_V5_FULL_MEDIUM]) {
      const on = buildGenerateImagePayload(req({ model, transparentBackground: true }))
      expect(alphaFields(on)).toEqual([true, true])
      expect(on.input).toBe(`1girl, smile, ${TAG}${QUALITY}`)
      const off = buildGenerateImagePayload(req({ model, transparentBackground: false }))
      expect(alphaFields(off)).toEqual([undefined, undefined])
      expect(off.input).not.toContain(TAG)
      // 예전 요청(칸 없음)은 끔
      expect(alphaFields(buildGenerateImagePayload(req({ model })))).toEqual([undefined, undefined])
    }
    for (const model of ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-4-full']) {
      const p = buildGenerateImagePayload(req({ model, transparentBackground: true }))
      expect(alphaFields(p)).toEqual([undefined, undefined])
      expect(p.input).not.toContain(TAG)
    }
  })

  it('keeps it for V5 i2i and V5 Full inpaint, drops it for V5 Curated inpaint (sent to a V4.5 model)', () => {
    const i2i = buildGenerateImagePayload(req({ transparentBackground: true }), {
      i2i: { strength: 0.7, noise: 0, extraNoiseSeed: 0, colorCorrect: false, imageBase64: 'SRC' }
    })
    expect(i2i.action).toBe('img2img')
    expect(alphaFields(i2i)).toEqual([true, true])
    const inpaint = buildGenerateImagePayload(req({ model: `${NAI_V5_FULL}-inpainting`, transparentBackground: true }), {
      i2i: { strength: 0.7, noise: 0, extraNoiseSeed: 0, colorCorrect: false, imageBase64: 'SRC', maskBase64: 'MASK' }
    })
    expect(inpaint.action).toBe('infill')
    expect(alphaFields(inpaint)).toEqual([true, true])
    expect(sendsTransparentBackground(NAI_V5_FULL, true)).toBe(true)
    expect(sendsTransparentBackground(NAI_V5_CURATED, true)).toBe(false)
    expect(sendsTransparentBackground(NAI_V5_CURATED)).toBe(true)
    expect(sendsTransparentBackground('nai-diffusion-4-5-full')).toBe(false)
  })
})

describe('saved params', () => {
  it('fills the new field for params saved by older versions', () => {
    expect(withParamDefaults(OLD_PARAMS)).toEqual({ ...OLD_PARAMS, transparentBackground: false })
    expect(withParamDefaults({ ...OLD_PARAMS, transparentBackground: true }).transparentBackground).toBe(true)
    expect(withParamDefaults(null).model).toBe('nai-diffusion-4-5-full')
  })

  it('presets save it; applying a preset saved before it existed turns it off', () => {
    usePrompt.setState({ params: { ...OLD_PARAMS, transparentBackground: true }, presets: [] })
    usePrompt.getState().savePreset('투명')
    const saved = usePrompt.getState().presets[0]
    expect(saved.params.transparentBackground).toBe(true)
    usePrompt.setState({
      presets: [...usePrompt.getState().presets, { id: 9, name: '예전', base: 'a', detail: '', negative: '', params: OLD_PARAMS as Params }]
    })
    usePrompt.getState().applyPreset(9)
    expect(usePrompt.getState().params.transparentBackground).toBe(false)
    usePrompt.getState().applyPreset(saved.id)
    expect(usePrompt.getState().params.transparentBackground).toBe(true)
  })
})

// ── 생성 경로 (가짜 서버)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const idle = async (): Promise<void> => {
  await sleep(0)
  for (let i = 0; i < 500 && useGeneration.getState().running; i++) await sleep(10)
  expect(useGeneration.getState().running).toBe(false)
}
const latest = async (): Promise<HistoryMeta> => {
  await sleep(20)
  const items = useHistory.getState().items
  return items[0]
}

async function reset(): Promise<void> {
  sent.length = 0
  await setStorageForTests(await createSqlJsDriver(), memoryFileStore())
  useSettings.setState({ token: 'pst-test', autoSave: false, background: false, keepAwake: false, vibrate: false, streaming: false, historyLimit: 0, delayMin: 0, delayMax: 0 })
  useCharacters.setState({ characters: [], slots: [] })
  useSource.setState({ image: null, mask: null, width: 0, height: 0, originId: null })
  usePrompt.setState({ base: '1girl, smile', additional: '', detail: '', negative: 'lowres', seed: '', count: 1, params: { ...OLD_PARAMS, transparentBackground: false }, presets: [], activePresetId: null })
  useProjects.setState({ projects: [], activeId: null })
  await useHistory.getState().init()
}

describe('generation paths', () => {
  beforeEach(reset)

  it('main generation sends it and records it in the history snapshot', async () => {
    usePrompt.getState().patchParams({ transparentBackground: true })
    await useGeneration.getState().start()
    await idle()
    expect(sent).toHaveLength(1)
    expect(alphaFields(sent[0])).toEqual([true, true])
    const m = await latest()
    expect(m.snap?.params.transparentBackground).toBe(true)
    expect(generatedTransparent(m)).toBe(true)
    expect(hasAlphaBackground(m)).toBe(true)
    expect(describeImage(m)).toContain('배경 투명')
    // 다시 생성: 화면에서 껐어도 그 그림대로 켜서 보낸다
    usePrompt.getState().patchParams({ transparentBackground: false })
    await useGeneration.getState().start({ regenerate: m })
    await idle()
    expect(alphaFields(sent[1])).toEqual([true, true])
    expect(sent[1].input).toBe(sent[0].input)
  })

  it('regenerating an image recorded before the toggle existed does not pick up the screen toggle', async () => {
    usePrompt.getState().patchParams({ transparentBackground: true })
    const snap: SettingsSnapshot = { base: 'old', additional: '', detail: '', negative: '', params: { ...OLD_PARAMS }, chars: [] }
    const old: HistoryMeta = {
      id: 1,
      ts: 1,
      thumb: '',
      width: 832,
      height: 1216,
      seed: 5,
      model: NAI_V5_FULL,
      kind: 't2i',
      prompt: `old${QUALITY}`,
      negative: '',
      mime: 'image/png',
      snap,
      sent: { prompt: 'old', negative: '', chars: [] }
    }
    await useGeneration.getState().start({ regenerate: old })
    await idle()
    expect(sent).toHaveLength(1)
    expect(alphaFields(sent[0])).toEqual([undefined, undefined])
    expect(sent[0].input).toBe(`old${QUALITY}`)
  })

  it('a non-V5 model keeps the saved toggle but does not send it', async () => {
    usePrompt.getState().patchParams({ transparentBackground: true, model: 'nai-diffusion-4-5-full' })
    await useGeneration.getState().start()
    await idle()
    expect(alphaFields(sent[0])).toEqual([undefined, undefined])
    expect(generatedTransparent(await latest())).toBe(false)
  })

  it('i2i and inpaint on V5 Full send it; V5 Curated inpaint does not', async () => {
    usePrompt.getState().patchParams({ transparentBackground: true })
    useSource.setState({ image: 'SRC', width: 832, height: 1216 })
    await useGeneration.getState().start()
    await idle()
    expect(sent[0].action).toBe('img2img')
    expect(alphaFields(sent[0])).toEqual([true, true])
    useSource.setState({ mask: 'data:image/png;base64,MASK' })
    await useGeneration.getState().start()
    await idle()
    expect([sent[1].action, sent[1].model]).toEqual(['infill', `${NAI_V5_FULL}-inpainting`])
    expect(alphaFields(sent[1])).toEqual([true, true])
    usePrompt.getState().patchParams({ model: NAI_V5_CURATED })
    await useGeneration.getState().start()
    await idle()
    expect([sent[2].action, sent[2].model]).toEqual(['infill', 'nai-diffusion-4-5-curated-inpainting'])
    expect(alphaFields(sent[2])).toEqual([undefined, undefined])
  })

  it('project generation sends the project setting, not the screen one', async () => {
    usePrompt.getState().patchParams({ transparentBackground: false })
    const s = useProjects.getState()
    const id = s.create('투명', { ...OLD_PARAMS, transparentBackground: true })
    s.patch(id, { stylePrompt: 'artist:foo', defaults: { count: 1, target: 1 } })
    s.addCharacter(id, { name: '하늘', libraryId: null, prompt: 'boy' })
    const p = useProjects.getState().projects.find((x) => x.id === id)!
    expect(p.params.transparentBackground).toBe(true)
    enqueueJobs(p, planJobs(p, 'all').jobs)
    await idle()
    expect(sent).toHaveLength(1)
    expect(alphaFields(sent[0])).toEqual([true, true])
    expect(sent[0].input.startsWith(`artist:foo, ${TAG}`)).toBe(true)
    expect(generatedTransparent(await latest())).toBe(true)
  })
})

// ── 메타데이터 · 설정 적용
function pngWithComment(comment: Record<string, unknown>): Blob {
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length)
    new DataView(out.buffer).setUint32(0, data.length)
    out.set(new TextEncoder().encode(type), 4)
    out.set(data, 8)
    return out // CRC는 읽는 쪽이 보지 않는다
  }
  const text = new TextEncoder().encode(`Comment\0${JSON.stringify(comment)}`)
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', new Uint8Array(13)), chunk('tEXt', text), chunk('IEND', new Uint8Array(0))]
  return new Blob(parts as BlobPart[], { type: 'image/png' })
}

describe('metadata and apply', () => {
  beforeEach(() => {
    usePrompt.setState({ params: { ...OLD_PARAMS, transparentBackground: false } })
  })

  it('reads straight_alpha from a NovelAI PNG and removes the tag the setting added', async () => {
    const m = await readImageSettings(
      pngWithComment({ prompt: `1girl, ${TAG}${QUALITY}`, uc: 'lowres', straight_alpha: true, tag_hint_transparent_background: true, steps: 23 })
    )
    expect(m).toMatchObject({ prompt: '1girl', qualityToggle: true, transparentBackground: true })
    const plain = await readImageSettings(pngWithComment({ prompt: `1girl, ${TAG}${QUALITY}`, uc: '' }))
    // 설정 없이 직접 쓴 태그는 그대로 둔다
    expect(plain).toMatchObject({ prompt: `1girl, ${TAG}`, transparentBackground: false })
    expect(stripTransparentTag(TAG)).toBe('')
    expect(stripTransparentTag(`${TAG}, 1girl`)).toBe(`${TAG}, 1girl`)
  })

  it('applies it with the quality group and restores the prompt without a double tag', async () => {
    const m = await readImageSettings(pngWithComment({ prompt: `1girl, ${TAG}${QUALITY}`, uc: '', straight_alpha: true }))
    const data = fromMetadata(m!)
    expect(data.params.transparentBackground).toBe(true)
    expect(availableParts(data)).toContain('quality')
    applyImport(data, new Set(['prompt', 'quality']), null)
    const s = usePrompt.getState()
    expect(s.params.transparentBackground).toBe(true)
    expect(buildGenerateImagePayload({ ...req(), prompt: s.base, transparentBackground: s.params.transparentBackground }).input).toBe(`1girl, ${TAG}${QUALITY}`)
  })

  it('treats snapshots recorded before the toggle existed as off', () => {
    usePrompt.getState().patchParams({ transparentBackground: true })
    const old: SettingsSnapshot = { base: 'a', additional: '', detail: '', negative: '', params: { ...OLD_PARAMS }, chars: [] }
    const data = fromSnapshot(old)
    expect(data.params.transparentBackground).toBe(false)
    applyImport(data, new Set(['quality']), null)
    expect(usePrompt.getState().params.transparentBackground).toBe(false)
    expect(fromSnapshot({ ...old, params: { ...OLD_PARAMS, transparentBackground: true } }).params.transparentBackground).toBe(true)
    // 고르지 않으면 지금 값 유지
    usePrompt.getState().patchParams({ transparentBackground: true })
    applyImport(data, new Set(['prompt']), null)
    expect(usePrompt.getState().params.transparentBackground).toBe(true)
  })
})

// ── NAIS3
describe('NAIS3 mapping', () => {
  const prompt = (params: Record<string, unknown>): BackupData => ({
    prompt: { base: 'a', additional: '', detail: '', negative: '', params, seed: '' }
  })

  it('exports the working prompt toggle to mainParams and imports it back', async () => {
    const plan = naipToNais3(prompt({ ...OLD_PARAMS, transparentBackground: true }), { sections: ['prompt'] })
    expect(JSON.parse(plan.output.mainParams!)).toMatchObject({ model: NAI_V5_FULL, transparentBackground: true })
    const sink = memorySink()
    await exportNais3(prompt({ ...OLD_PARAMS, transparentBackground: true }), sink, { appVersion: 'test', sections: ['prompt'] })
    const { data, report } = await importNais3(await readNaisArchive(bytesSource(sink.bytes())))
    expect((data.prompt as { params: Record<string, unknown> }).params.transparentBackground).toBe(true)
    expect(report.notImported.some((l) => l.text.includes('transparentBackground'))).toBe(false)
    // 칸이 없으면 만들지 않고, "저장되지 않은 파라미터"로도 알리지 않는다
    const plain = naipToNais3(prompt({ ...OLD_PARAMS }), { sections: ['prompt'] })
    expect(JSON.parse(plain.output.mainParams!)).not.toHaveProperty('transparentBackground')
  })

  it('reports preset transparency as lost (NAIS3 presets have no such field)', () => {
    const data: BackupData = {
      presets: {
        presets: [
          { id: 1, name: '투명', base: 'a', detail: '', negative: '', params: { ...OLD_PARAMS, transparentBackground: true } },
          { id: 2, name: '보통', base: 'b', detail: '', negative: '', params: { ...OLD_PARAMS, transparentBackground: false } }
        ]
      }
    }
    const plan = naipToNais3(data, { sections: ['presets'] })
    const rows = plan.output.tables.prompt_presets!
    expect(JSON.parse(String(rows[0].params_json))).not.toHaveProperty('transparentBackground')
    expect(plan.lost.find((l) => l.text.includes('배경 투명'))?.items).toEqual(['투명'])
  })
})

// ── 썸네일·화면 체크무늬
describe('checker', () => {
  const rgba = (...px: number[][]): Uint8ClampedArray => new Uint8ClampedArray(px.flat())

  it('leaves opaque pixels (and NAI’s 254/255 stealth alpha) untouched', () => {
    const d = rgba([10, 20, 30, 255], [40, 50, 60, 254], [1, 2, 3, 255], [4, 5, 6, 254])
    const before = [...d]
    expect(flattenOnChecker(d, 2)).toBe(false)
    expect([...d]).toEqual(before)
  })

  it('composites transparent pixels onto a light checker instead of black', () => {
    // 2×2 칸을 cell 1로: (0,0) 밝은 칸, (1,0) 어두운 칸, (0,1) 어두운 칸, (1,1) 밝은 칸
    const d = rgba([0, 0, 0, 0], [0, 0, 0, 0], [255, 0, 0, 128], [9, 9, 9, 255])
    expect(flattenOnChecker(d, 2, 1)).toBe(true)
    expect([...d.slice(0, 4)]).toEqual([CHECKER_LIGHT, CHECKER_LIGHT, CHECKER_LIGHT, 255])
    expect([...d.slice(4, 8)]).toEqual([CHECKER_DARK, CHECKER_DARK, CHECKER_DARK, 255])
    const f = 128 / 255
    expect([...d.slice(8, 12)]).toEqual([Math.round(255 * f + CHECKER_DARK * (1 - f)), Math.round(CHECKER_DARK * (1 - f)), Math.round(CHECKER_DARK * (1 - f)), 255])
    expect([...d.slice(12, 16)]).toEqual([9, 9, 9, 255])
    expect(CHECKER_LIGHT).toBeGreaterThan(150)
    expect(CHECKER_DARK).toBeGreaterThan(150)
  })

  it('uses 8px cells by default', () => {
    const w = 16
    const d = new Uint8ClampedArray(w * 1 * 4) // 한 줄, 모두 투명
    flattenOnChecker(d, w)
    expect(d[0]).toBe(CHECKER_LIGHT)
    expect(d[7 * 4]).toBe(CHECKER_LIGHT)
    expect(d[8 * 4]).toBe(CHECKER_DARK)
  })

  it('draws the viewer checker only in the contained image box (image aspect SVG + contain)', () => {
    const s = checkerStyle(832, 1216)
    expect(s.backgroundSize).toBe('contain')
    expect(s.backgroundRepeat).toBe('no-repeat')
    const svg = decodeURIComponent(String(s.backgroundImage).replace(/^url\("data:image\/svg\+xml,/, '').replace(/"\)$/, ''))
    expect(svg).toContain("viewBox='0 0 832 1216'")
  })

  it('knows which history images can be transparent', () => {
    const base = { model: NAI_V5_FULL, snap: { params: { transparentBackground: true } } }
    expect(hasAlphaBackground(base)).toBe(true)
    expect(hasAlphaBackground({ ...base, model: 'nai-diffusion-4-5-full' })).toBe(false)
    expect(hasAlphaBackground({ model: NAI_V5_FULL, snap: { params: {} } })).toBe(false)
    expect(hasAlphaBackground({ model: NAI_V5_FULL })).toBe(false)
    expect(hasAlphaBackground({ model: 'director:bg-removal' })).toBe(true)
    expect(generatedTransparent({ model: 'director:bg-removal' })).toBe(false)
  })
})
