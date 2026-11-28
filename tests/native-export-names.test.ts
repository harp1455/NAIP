/**
 * 내보내기 파일 이름이 네이티브로 넘어갈 때 잘리지 않는지 — 플러그인은 가짜 (기기·네트워크 없음)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: { method: string; opts: Record<string, unknown> }[] = []

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => async (opts: Record<string, unknown>) => {
          calls.push({ method, opts })
          const path = `${opts.path ? `${String(opts.path)}/` : ''}${String(opts.fileName)}`
          return { uri: 'content://x', name: opts.fileName, path, overwritten: false, renamed: false }
        }
      }
    )
}))
vi.mock('../src/lib/image', () => ({ blobToBase64: async () => 'AAAA' }))

import { cleanExportFileName, cleanFolderPath, saveImageAt, saveTextAt } from '../src/lib/native'
import { DEFAULT_NAMING, previewPaths, sanitizeName } from '../src/project'

beforeEach(() => {
  calls.length = 0
})

describe('export file names sent to the native side', () => {
  it('keeps the extension and the whole planned name (no 80-character cut)', async () => {
    const stem = 'hero_school-uniform_smile_standing_front_lighting-soft_background-classroom_001'
    expect(stem.length + 4).toBeGreaterThan(80)
    const saved = await saveImageAt(new Blob([new Uint8Array(1)], { type: 'image/png' }), 'P/민지', `${stem}.png`, true)
    expect(calls[0].opts.fileName).toBe(`${stem}.png`)
    expect(saved.path).toBe(`P/민지/${stem}.png`)
  })

  it('passes every name the planner can make through unchanged, even at the longest setting', () => {
    const plan = previewPaths(
      [
        { id: 1, vars: { character: 'a'.repeat(200) }, ext: 'webp' },
        { id: 2, vars: { character: '가'.repeat(200) }, ext: 'png' },
        { id: 3, vars: { character: '가'.repeat(200) }, ext: 'png' }
      ],
      { ...DEFAULT_NAMING, fileTemplate: '{character}', folderTemplate: '{character}', maxLength: 120 }
    )
    for (const e of plan.entries) {
      expect(cleanExportFileName(e.fileName)).toBe(e.fileName)
      expect(cleanFolderPath(e.folder)).toBe(e.folder)
    }
  })

  it('shortens only the part before the extension when a name is too long', () => {
    const long = `${'가'.repeat(100)}.png`
    const out = cleanExportFileName(long)
    expect(out.endsWith('.png')).toBe(true)
    expect(new TextEncoder().encode(out.slice(0, -4)).length).toBeLessThanOrEqual(200)
    expect(cleanExportFileName('a:b/c.csv')).toBe('a_b_c.csv')
  })

  it('keeps the manifest and code list names apart for long project names', async () => {
    // save.ts가 목록 파일 이름에 쓰는 것과 같은 꼴 (긴 영문 프로젝트 이름 → 80자)
    const stem = sanitizeName('p'.repeat(100), { maxBytes: 180 })
    expect(stem).toHaveLength(80)
    await saveTextAt('x', 'text/csv', 'P', `${stem}_manifest.csv`, true)
    await saveTextAt('y', 'text/plain', 'P', `${stem}_codes.txt`, true)
    expect(calls.map((c) => c.opts.fileName)).toEqual([`${stem}_manifest.csv`, `${stem}_codes.txt`])
  })
})
