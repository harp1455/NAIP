import { describe, expect, it } from 'vitest'
import { buildGenerateImagePayload } from '../src/nai/payload'
import { estimateAnlas } from '../src/nai/anlas'
import type { GenerationRequest } from '../src/nai/types'

const req: GenerationRequest = {
  prompt: '1girl',
  negativePrompt: 'sepia',
  model: 'nai-diffusion-4-5-full',
  width: 832,
  height: 1216,
  steps: 28,
  cfgScale: 5,
  cfgRescale: 0,
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  seed: 42,
  variety: false,
  qualityToggle: true,
  ucPreset: 0,
  characterPrompts: [
    { prompt: 'a', negativePrompt: '', enabled: true, center: { x: 0.3, y: 0.5 } },
    { prompt: 'b', negativePrompt: '', enabled: true },
    { prompt: 'off', negativePrompt: '', enabled: false }
  ],
  useCoords: true
}

describe('payload', () => {
  it('always asks for exactly one image per request', () => {
    const p = buildGenerateImagePayload(req)
    expect(p.action).toBe('generate')
    expect(p.parameters.n_samples).toBe(1)
    expect(p.input).toBe('1girl, very aesthetic, masterpiece, no text')
    expect((p.parameters.characterPrompts as unknown[]).length).toBe(2)
    expect(p.parameters.use_coords).toBe(true)
  })

  it('switches action for i2i and inpaint', () => {
    const i2i = { strength: 0.7, noise: 0, extraNoiseSeed: 41, colorCorrect: false, imageBase64: 'x' }
    expect(buildGenerateImagePayload(req, { i2i }).action).toBe('img2img')
    const inpaint = buildGenerateImagePayload(req, { i2i: { ...i2i, maskBase64: 'm' } })
    expect(inpaint.action).toBe('infill')
    expect(inpaint.parameters.mask).toBe('m')
  })

  it('adds vibe and character reference fields', () => {
    const p = buildGenerateImagePayload(req, {
      vibes: [{ strength: 0.6, encodedVibeBase64: 'v' }],
      characterReferences: [{ referenceType: 'character', strength: 1, fidelity: 0.8, imageBase64: 'r' }]
    })
    expect(p.parameters.reference_image_multiple).toEqual(['v'])
    expect(p.parameters.director_reference_images).toEqual(['r'])
  })
})

describe('anlas', () => {
  it('is free for Opus at normal size, and charges references per image', () => {
    const base = { model: req.model, width: 832, height: 1216, steps: 28, batchCount: 8 }
    expect(estimateAnlas({ ...base, isOpus: true }).total).toBe(0)
    expect(estimateAnlas({ ...base, isOpus: true, charRefCount: 1 }).total).toBe(40)
    expect(estimateAnlas({ ...base, isOpus: false }).total).toBe(20 * 8)
  })
})

import { processWildcards, resetSequentialCounters } from '../src/nai/fragments'
import { appendPrompt } from '../src/stores/scenes'

describe('fragments', () => {
  const source = {
    getLines: (path: string) =>
      ({ hair: ['black hair', 'blonde hair'], 'set/pose': ['sitting, <hair>'] })[path] ?? null
  }

  it('replaces fragment references, including nested and folder paths', () => {
    const out = processWildcards('1girl, <Hair>, <set / pose>', source, () => 0)
    expect(out).toBe('1girl, black hair, sitting, black hair')
  })

  it('walks sequential fragments in order and keeps unknown references', () => {
    resetSequentialCounters()
    expect(processWildcards('<*hair>', source)).toBe('black hair')
    expect(processWildcards('<*hair>', source)).toBe('blonde hair')
    expect(processWildcards('<*hair>, <nope>', source)).toBe('black hair, <nope>')
  })

  it('picks from inline and slash alternatives without touching weights', () => {
    expect(processWildcards('<a|b>, red/blue, 1.2::artist:x::', source, () => 0.99)).toBe(
      'b, blue, 1.2::artist:x::'
    )
  })
})

describe('scenes', () => {
  it('appends scene prompts without doubling commas', () => {
    expect(appendPrompt('1girl, ', ', beach')).toBe('1girl, beach')
    expect(appendPrompt('', 'beach')).toBe('beach')
    expect(appendPrompt('1girl', '')).toBe('1girl')
  })
})

import { highlightRanges, parseWeights } from '../src/nai/weights'

describe('weights', () => {
  it('parses numeric, negative, brace and bracket weights', () => {
    const w = (text: string): number[] => parseWeights(text).map((s) => Math.round(s.weight * 1000) / 1000)
    expect(w('a, 1.2::b::, c')).toEqual([1, 1.2, 1])
    expect(w('-1::x::')).toEqual([-1])
    expect(w('{a}')).toEqual([1.05])
    expect(w('[a]')).toEqual([0.952])
  })

  it('classifies ranges by kind', () => {
    const kinds = (text: string): (string | null)[] => highlightRanges(text).map((r) => r.kind)
    expect(kinds('a, 1.2::b::, 0.7::c::, -2::d::, <frag>')).toEqual([
      null, 'up', null, 'down', null, 'negative', null, 'fragment'
    ])
    expect(kinds('# note\n1girl')).toEqual(['comment', null])
  })
})

import { parseRelease } from '../src/stores/update'

describe('update', () => {
  it('reads the build number and APK asset from a release', () => {
    const info = parseRelease({
      tag_name: 'build-12',
      name: 'NAIP 0.6.0 (build 12)',
      body: 'notes\n',
      assets: [
        { name: 'other.txt', size: 1, url: 'u0', browser_download_url: 'd0' },
        { name: 'NAIP-0.6.0-b12.apk', size: 100, url: 'u1', browser_download_url: 'd1' }
      ]
    })
    expect(info).toMatchObject({ build: 12, downloadUrl: 'd1', assetApiUrl: 'u1', notes: 'notes' })
  })

  it('ignores releases that are not app builds', () => {
    expect(parseRelease({ tag_name: 'v1.0', assets: [] })).toBeNull()
    expect(parseRelease({ tag_name: 'build-3', assets: [] })).toBeNull()
  })
})
