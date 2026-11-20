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
