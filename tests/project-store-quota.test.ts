import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('project store when localStorage is full', () => {
  it('keeps working in memory and warns instead of throwing out of every action', async () => {
    const kept = new Map<string, string>()
    let full = false
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (full) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
        kept.set(k, v)
      },
      removeItem: (k: string) => void kept.delete(k),
      clear: () => kept.clear(),
      key: () => null,
      length: 0
    })
    vi.resetModules()
    const { useProjects } = await import('../src/project/store')
    const { useToast } = await import('../src/stores/toast')
    const s = useProjects.getState()
    const id = s.create('큰 프로젝트')
    s.markQueued(id, [{ key: 'k', count: 2 }])
    full = true
    // 생성 대기열의 진행 알림(markStarted)·멈출 때 돌려주기(releaseQueued)가 오류로 대기열을 멈추게 하지 않는다
    expect(() => {
      useProjects.getState().markStarted(id, 'k')
      useProjects.getState().releaseQueued(id, 'k', 1)
      useProjects.getState().setRedo(id, 'k', true)
    }).not.toThrow()
    const item = useProjects.getState().projects[0].items.k
    expect(item).toMatchObject({ queued: 0, generating: 1, redo: true })
    expect(useToast.getState()).toMatchObject({ error: true, text: expect.stringContaining('저장하지 못했습니다') })
  })
})
