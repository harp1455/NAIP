import { describe, expect, it, vi } from 'vitest'

// 휴대폰 플러그인을 흉내 낸다 — 진짜 네이티브 호출은 없다
vi.mock('@capacitor/core', () => {
  const plugin = { open: vi.fn() }
  return {
    Capacitor: { isNativePlatform: () => true, convertFileSrc: (p: string) => p },
    registerPlugin: () => plugin
  }
})

import { absolutePath, NaipStorage, openNative } from '../src/storage/native'

describe('native storage open', () => {
  it('opens again after a failed open instead of repeating the old error', async () => {
    const open = vi.mocked(NaipStorage.open)
    open.mockRejectedValueOnce(new Error('open failed: disk full'))
    open.mockResolvedValueOnce({ filesDir: '/data/files/', dbPath: '/data/databases/naip-history.db' })
    await expect(openNative()).rejects.toThrow('disk full')
    // 공간을 비우고 "다시 시도"
    await expect(openNative()).resolves.toBe('/data/files')
    expect(absolutePath('images/1.png')).toBe('/data/files/images/1.png')
    // 열린 뒤에는 다시 열지 않는다
    await openNative()
    expect(open).toHaveBeenCalledTimes(2)
  })
})
