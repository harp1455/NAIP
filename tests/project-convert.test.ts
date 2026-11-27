import { describe, expect, it } from 'vitest'
import {
  describePreset,
  formatBytes,
  planGeometry,
  presetNotes,
  presetToConvertOptions,
  searchForSize,
  validatePreset
} from '../src/project'

describe('conversion geometry', () => {
  const box = (g: ReturnType<typeof planGeometry>): number[] => [g.width, g.height, g.dx, g.dy, g.dw, g.dh]
  const src = (g: ReturnType<typeof planGeometry>): number[] => [g.sx, g.sy, g.sw, g.sh]

  it('keeps the original size by default', () => {
    const g = planGeometry(832, 1216, { format: 'png' })
    expect(box(g)).toEqual([832, 1216, 0, 0, 832, 1216])
    expect(g.padded).toBe(false)
  })

  it('shrinks into a max box keeping the aspect, never enlarging', () => {
    expect(box(planGeometry(832, 1216, { format: 'webp', maxWidth: 512, maxHeight: 512 }))).toEqual([350, 512, 0, 0, 350, 512])
    expect(box(planGeometry(400, 300, { format: 'webp', maxWidth: 1000 }))).toEqual([400, 300, 0, 0, 400, 300])
    expect(box(planGeometry(832, 1216, { format: 'webp', width: 416 }))).toEqual([416, 608, 0, 0, 416, 608])
    expect(box(planGeometry(832, 1216, { format: 'webp', height: 2432 }))).toEqual([1664, 2432, 0, 0, 1664, 2432])
  })

  it('fits exact sizes with contain (padding), cover (center crop) or fill', () => {
    const contain = planGeometry(832, 1216, { format: 'png', width: 1024, height: 1024 })
    expect(box(contain)).toEqual([1024, 1024, 161, 0, 701, 1024])
    expect(contain.padded).toBe(true)
    const cover = planGeometry(832, 1216, { format: 'png', width: 1024, height: 1024, fit: 'cover' })
    expect(src(cover)).toEqual([0, 192, 832, 832])
    expect(box(cover)).toEqual([1024, 1024, 0, 0, 1024, 1024])
    const fill = planGeometry(832, 1216, { format: 'png', width: 100, height: 100, fit: 'fill' })
    expect([...src(fill), ...box(fill)]).toEqual([0, 0, 832, 1216, 100, 100, 0, 0, 100, 100])
    // 정확한 크기가 최대 크기보다 크면 전체를 같은 비율로 줄인다
    expect(box(planGeometry(832, 1216, { format: 'png', width: 1024, height: 1024, maxWidth: 512 }))).toEqual([512, 512, 81, 0, 351, 512])
  })

  it('crops by center aspect or a clamped rectangle, then pads', () => {
    expect(src(planGeometry(832, 1216, { format: 'png', crop: { mode: 'center', aspect: 1 } }))).toEqual([0, 192, 832, 832])
    expect(src(planGeometry(1216, 832, { format: 'png', crop: { mode: 'center', aspect: 1 } }))).toEqual([192, 0, 832, 832])
    expect(src(planGeometry(100, 100, { format: 'png', crop: { mode: 'rect', x: 80, y: -5, width: 50, height: 500 } }))).toEqual([80, 0, 20, 100])
    const padded = planGeometry(100, 50, { format: 'png', padding: 10 })
    expect(box(padded)).toEqual([120, 70, 10, 10, 100, 50])
    expect(padded.padded).toBe(true)
  })

  it('applies an extra scale for target-size shrinking', () => {
    expect(box(planGeometry(1000, 500, { format: 'png' }, 0.5))).toEqual([500, 250, 0, 0, 500, 250])
  })
})

describe('target size search', () => {
  /** 품질 q일 때 크기가 q에 비례하는 가짜 인코더 */
  function encoder(sizeAt: (q: number) => number) {
    const calls: number[] = []
    return {
      calls,
      encode: async (q: number) => {
        calls.push(q)
        return { size: sizeAt(q), value: `q${q}` }
      }
    }
  }

  it('stops at the first try when it already fits', async () => {
    const e = encoder((q) => q * 100)
    const r = await searchForSize(e.encode, { target: 100, max: 0.92, min: 0.6 })
    expect(r).toMatchObject({ reached: true, best: { param: 0.92 } })
    expect(e.calls).toEqual([0.92])
  })

  it('finds the highest quality under the target within the iteration limit', async () => {
    const e = encoder((q) => Math.round(q * 1000))
    const r = await searchForSize(e.encode, { target: 750, max: 0.92, min: 0.5, tolerance: 0 })
    expect(r.reached).toBe(true)
    expect(r.best.size).toBeLessThanOrEqual(750)
    expect(r.best.param).toBeGreaterThanOrEqual(0.7)
    expect(e.calls.length).toBeLessThanOrEqual(6)
    expect(e.calls.every((q) => q >= 0.5 && q <= 0.92)).toBe(true)
  })

  it('returns the smallest attempt with reached=false when even the floor is too big', async () => {
    const e = encoder((q) => 10_000 + q * 100)
    const r = await searchForSize(e.encode, { target: 5_000, max: 0.9, min: 0.6 })
    expect(r.reached).toBe(false)
    expect(r.best.param).toBe(0.6)
    expect(e.calls).toEqual([0.9, 0.6])
  })

  it('terminates on erratic encoders and clamps the iteration count', async () => {
    let n = 0
    const erratic = encoder(() => (n++ % 2 ? 100 : 10_000))
    const r = await searchForSize(erratic.encode, { target: 1_000, max: 1, min: 0.05, maxIterations: 1000, tolerance: 0 })
    expect(erratic.calls.length).toBeLessThanOrEqual(12)
    expect(r.best.size).toBeLessThanOrEqual(1_000)
    const once = encoder(() => 10_000)
    const r1 = await searchForSize(once.encode, { target: 1, max: 1, min: 0.5, maxIterations: 0 })
    expect(once.calls).toHaveLength(1)
    expect(r1.reached).toBe(false)
  })

  it('counts a pre-encoded attempt against the budget and never goes below the floor', async () => {
    const e = encoder((q) => Math.round(q * 1000))
    const r = await searchForSize(e.encode, {
      target: 610,
      max: 0.9,
      min: 0.6,
      maxIterations: 3,
      tolerance: 0,
      atMax: { param: 0.9, size: 900, value: 'q0.9' }
    })
    expect(e.calls).toHaveLength(2)
    expect(r.attempts).toHaveLength(2)
    expect(r.reached).toBe(true)
    expect(Math.min(...e.calls)).toBeGreaterThanOrEqual(0.6)
  })

  it('formats byte sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(300 * 1024)).toBe('300 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.00 MB')
  })
})

describe('platform presets', () => {
  it('validates user presets and turns them into convert options', () => {
    expect(validatePreset({ name: '', format: 'webp' })).toEqual(['프리셋 이름을 적어 주세요'])
    expect(validatePreset({ name: 'x', format: 'jpeg', maxWidth: 0, maxBytes: 10, quality: 0.5, minQuality: 0.8 })).toEqual([
      '최대 가로는 1 이상의 정수여야 합니다',
      '최대 용량은 1KB 이상이어야 합니다',
      '품질 하한이 품질보다 높습니다'
    ])
    const p = { name: '내 플랫폼', format: 'webp' as const, maxWidth: 1024, maxHeight: 1024, maxBytes: 500 * 1024, quality: 0.9 }
    expect(validatePreset(p)).toEqual([])
    expect(presetToConvertOptions(p)).toEqual({
      format: 'webp',
      maxWidth: 1024,
      maxHeight: 1024,
      quality: 0.9,
      targetBytes: 500 * 1024,
      scrubAlpha: true
    })
    expect(describePreset(p)).toBe('WebP · 최대 1024×1024 · 500KB 이하 · 품질 90%')
    expect(presetNotes({ name: 'png', format: 'png', maxBytes: 1024 * 1024 })[0]).toContain('PNG')
  })
})
