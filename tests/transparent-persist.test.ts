/// <reference types="node" />
/**
 * 예전 버전이 localStorage(naip-prompt)에 저장한 params(배경 투명 칸 없음)를 다시 불러오면 꺼짐으로 채워지는지.
 * zustand persist 기본 저장소는 window.localStorage 라 이 파일에서만 window 를 둔다 (다른 테스트와 따로 돈다).
 */
import { expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const m = new Map<string, string>()
  const g = globalThis as Record<string, unknown>
  g.localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    }
  }
  g.window = { localStorage: g.localStorage }
})

import { usePrompt } from '../src/stores/prompt'

const OLD_PARAMS = {
  model: 'nai-diffusion-5-full',
  width: 832,
  height: 1216,
  steps: 23,
  cfgScale: 7,
  cfgRescale: 0,
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  variety: false,
  qualityToggle: true,
  ucPreset: 0
}

it('rehydrates an old naip-prompt with the toggle off and keeps everything else', async () => {
  localStorage.setItem(
    'naip-prompt',
    JSON.stringify({ state: { base: 'old base', negative: 'old neg', seed: '7', params: OLD_PARAMS, presets: [], activePresetId: null }, version: 0 })
  )
  await usePrompt.persist.rehydrate()
  const s = usePrompt.getState()
  expect([s.base, s.negative, s.seed]).toEqual(['old base', 'old neg', '7'])
  expect(s.params).toEqual({ ...OLD_PARAMS, transparentBackground: false })
  // 켠 값은 그대로 읽는다
  localStorage.setItem('naip-prompt', JSON.stringify({ state: { params: { ...OLD_PARAMS, transparentBackground: true } }, version: 0 }))
  await usePrompt.persist.rehydrate()
  expect(usePrompt.getState().params.transparentBackground).toBe(true)
  expect(usePrompt.getState().base).toBe('old base')
  // params 가 깨져 있어도 기본값으로 연다
  localStorage.setItem('naip-prompt', JSON.stringify({ state: { params: null }, version: 0 }))
  await usePrompt.persist.rehydrate()
  expect(usePrompt.getState().params.model).toBe('nai-diffusion-4-5-full')
})
