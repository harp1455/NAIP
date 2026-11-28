/// <reference types="node" />
/**
 * 인증정보 보관 — 예전 평문 토큰은 옮긴 것을 확인한 뒤에만 지우고,
 * 읽기·쓰기 실패와 "다시 읽을 수 없음"을 조용히 넘기지 않는다.
 * 암호화 저장소(NaipSecure)는 메모리 흉내로 바꾼다. 실제 NovelAI API는 부르지 않는다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const local = new Map<string, string>()
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, String(v)),
    removeItem: (k: string) => void local.delete(k),
    clear: () => local.clear(),
    key: (i: number) => [...local.keys()][i] ?? null,
    get length() {
      return local.size
    }
  }
  // zustand persist 는 window.localStorage 를 쓴다
  ;(globalThis as Record<string, unknown>).window ??= globalThis
  return {
    local,
    /** 암호화 저장소 (앱을 다시 열어도 남는다) */
    secure: new Map<string, string>(),
    /** 읽기가 일시적으로 실패하는 이름 */
    readFails: new Set<string>(),
    /** 쓰기가 실패하는 이름 */
    writeFails: new Set<string>(),
    /** 키가 바뀌어 영영 풀 수 없는 이름 (플러그인은 지우고 lost를 돌려준다) */
    lost: new Set<string>()
  }
})

vi.mock('../src/lib/secrets', () => ({
  readSecret: vi.fn(async (name: string) => {
    if (h.readFails.has(name)) throw new Error('secure store unavailable: KeyStoreException')
    if (h.lost.has(name)) {
      h.lost.delete(name)
      h.secure.delete(name)
      return { value: '', lost: true }
    }
    return { value: h.secure.get(name) ?? '', lost: false }
  }),
  writeSecret: vi.fn(async (name: string, value: string) => {
    if (h.writeFails.has(name)) throw new Error('secure store failed: ProviderException')
    if (value) h.secure.set(name, value)
    else h.secure.delete(name)
  })
}))
vi.mock('../src/nai/client', () => ({
  fetchSubscription: vi.fn(async () => {
    throw new Error('offline')
  })
}))

import { splitSettings } from '../src/backup/format'

const LEGACY_NAI = 'pst-legacyLegacyLegacy0123456789'
const LEGACY_GH = 'github_pat_legacy0123456789abcdefghij'

/** 앱을 새로 연 것처럼 스토어를 다시 만든다 (localStorage·암호화 저장소는 그대로) */
async function launch() {
  vi.resetModules()
  const { useSettings } = await import('../src/stores/settings')
  const { useToast } = await import('../src/stores/toast')
  return { useSettings, useToast }
}

/** App.tsx 의 시작 순서 그대로 */
async function boot(useSettings: Awaited<ReturnType<typeof launch>>['useSettings']): Promise<void> {
  await useSettings
    .getState()
    .loadSecrets()
    .catch(() => useSettings.setState({ secretsLoaded: true }))
  await useSettings.getState().refreshSubscription()
}

/** naip-settings 에 실제로 저장된 값 */
function persisted(): Record<string, unknown> {
  const raw = h.local.get('naip-settings')
  return raw ? (JSON.parse(raw) as { state: Record<string, unknown> }).state : {}
}

/** 0.12.0 까지의 naip-settings (토큰이 평문으로 들어 있다) */
function legacySettings(): void {
  h.local.set('naip-settings', JSON.stringify({ state: { token: LEGACY_NAI, githubToken: LEGACY_GH, delayMin: 1.2, delayMax: 1.4 }, version: 0 }))
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  h.local.clear()
  h.secure.clear()
  h.readFails.clear()
  h.writeFails.clear()
  h.lost.clear()
})

describe('moving the 0.12.0 plaintext tokens', () => {
  it('moves both tokens and drops the plaintext only after reading them back', async () => {
    legacySettings()
    const { useSettings } = await launch()
    await boot(useSettings)
    expect(h.secure.get('naiToken')).toBe(LEGACY_NAI)
    expect(h.secure.get('githubToken')).toBe(LEGACY_GH)
    const p = persisted()
    expect(p.token).toBeUndefined()
    expect(p.githubToken).toBeUndefined()
    expect(p.delayMin).toBe(1.2)
    expect(useSettings.getState().token).toBe(LEGACY_NAI)
    expect(useSettings.getState().secretErrors).toEqual({})
  })

  it('keeps the plaintext token when the secure write fails, says so, and moves it on the next launch', async () => {
    legacySettings()
    h.writeFails.add('naiToken')
    const first = await launch()
    await boot(first.useSettings)
    // 옮기지 못한 토큰은 naip-settings 에 그대로 — 다른 설정을 바꿔 다시 저장해도 남는다
    expect(persisted().token).toBe(LEGACY_NAI)
    first.useSettings.getState().patch({ autoSave: true })
    expect(persisted().token).toBe(LEGACY_NAI)
    // 옮긴 GitHub 토큰은 평문에서 빠진다
    expect(persisted().githubToken).toBeUndefined()
    expect(first.useSettings.getState().token).toBe(LEGACY_NAI)
    expect(first.useSettings.getState().secretErrors.token).toMatch(/옮기지 못했습니다/)
    expect(first.useToast.getState().text).toMatch(/옮기지 못했습니다/)

    h.writeFails.clear()
    const second = await launch()
    await boot(second.useSettings)
    expect(h.secure.get('naiToken')).toBe(LEGACY_NAI)
    expect(persisted().token).toBeUndefined()
    expect(second.useSettings.getState().token).toBe(LEGACY_NAI)
    expect(second.useSettings.getState().secretErrors).toEqual({})
  })

  it('keeps the plaintext when the read-back does not match', async () => {
    legacySettings()
    const { writeSecret } = await import('../src/lib/secrets')
    // 쓰기는 성공했다고 하는데 실제로는 남지 않은 경우
    vi.mocked(writeSecret).mockImplementationOnce(async () => {})
    const { useSettings } = await launch()
    await boot(useSettings)
    expect(persisted().token).toBe(LEGACY_NAI)
    expect(useSettings.getState().secretErrors.token).toMatch(/옮기지 못했습니다/)
  })

  it('does not overwrite a token the user typed while the stored ones were loading', async () => {
    legacySettings()
    const { useSettings } = await launch()
    const loading = useSettings.getState().loadSecrets()
    useSettings.getState().setToken('pst-typedTypedTyped0123456789')
    await loading
    await flush()
    expect(useSettings.getState().token).toBe('pst-typedTypedTyped0123456789')
    expect(h.secure.get('naiToken')).toBe('pst-typedTypedTyped0123456789')
    expect(persisted().token).toBeUndefined()
  })
})

describe('read failures and lost keys', () => {
  it('a temporary read failure neither rejects nor wipes anything, and is shown', async () => {
    h.secure.set('naiToken', 'pst-storedStoredStored0123456')
    h.readFails.add('naiToken')
    const { useSettings, useToast } = await launch()
    await expect(useSettings.getState().loadSecrets()).resolves.toBeUndefined()
    await useSettings.getState().refreshSubscription()
    expect(h.secure.get('naiToken')).toBe('pst-storedStoredStored0123456')
    expect(useSettings.getState().secretsLoaded).toBe(true)
    expect(useSettings.getState().secretErrors.token).toMatch(/지금은 읽지 못했습니다/)
    expect(useToast.getState().text).toMatch(/지금은 읽지 못했습니다/)
  })

  it('a temporary read failure keeps the plaintext token and uses it for this run', async () => {
    legacySettings()
    h.readFails.add('naiToken')
    const { useSettings } = await launch()
    await boot(useSettings)
    expect(useSettings.getState().token).toBe(LEGACY_NAI)
    expect(h.secure.has('naiToken')).toBe(false)
    expect(persisted().token).toBe(LEGACY_NAI)
  })

  it('keeps the "cannot read any more" notice after the subscription refresh, for both tokens', async () => {
    h.secure.set('naiToken', 'pst-oldOldOldOld0123456789')
    h.secure.set('githubToken', 'github_pat_oldOldOld0123456789abcdef')
    h.lost.add('naiToken')
    h.lost.add('githubToken')
    const { useSettings, useToast } = await launch()
    await boot(useSettings)
    const s = useSettings.getState()
    expect(s.token).toBe('')
    expect(s.secretErrors.token).toMatch(/기기 보안 상태가 바뀌어 저장된 NovelAI 토큰/)
    expect(s.secretErrors.githubToken).toMatch(/기기 보안 상태가 바뀌어 저장된 GitHub 토큰/)
    expect(useToast.getState().error).toBe(true)
    // 새 토큰을 저장하면 그 알림만 사라진다
    s.setToken('pst-newNewNewNew0123456789')
    await flush()
    expect(useSettings.getState().secretErrors.token).toBeUndefined()
    expect(useSettings.getState().secretErrors.githubToken).toBeDefined()
  })
})

describe('saving a token', () => {
  it('shows a failed secure write instead of swallowing it', async () => {
    const { useSettings } = await launch()
    await boot(useSettings)
    h.writeFails.add('naiToken')
    useSettings.getState().setToken('pst-newNewNewNew0123456789')
    await flush()
    expect(useSettings.getState().secretErrors.token).toMatch(/저장하지 못했습니다/)
    expect(h.secure.has('naiToken')).toBe(false)
    h.writeFails.clear()
    useSettings.getState().setToken('pst-newNewNewNew0123456789')
    await flush()
    expect(useSettings.getState().secretErrors.token).toBeUndefined()
    expect(h.secure.get('naiToken')).toBe('pst-newNewNewNew0123456789')
    // 토큰은 naip-settings 에 들어가지 않는다
    expect(JSON.stringify(persisted())).not.toContain('pst-')
  })

  it('says the stored token comes back when clearing it fails', async () => {
    h.secure.set('githubToken', 'github_pat_storedStored0123456789abcdef')
    const first = await launch()
    await boot(first.useSettings)
    h.writeFails.add('githubToken')
    first.useSettings.getState().setGithubToken('')
    await flush()
    const notice = first.useSettings.getState().secretErrors.githubToken
    expect(notice).toMatch(/지우지 못했습니다/)
    expect(notice).toMatch(/다시 들어올 수 있으니 다시 지워 주세요/)
    expect(notice).not.toMatch(/없어집니다/)
    // 실제로 다음 실행에 돌아온다 — 알림이 말한 그대로
    h.writeFails.clear()
    const second = await launch()
    await boot(second.useSettings)
    expect(second.useSettings.getState().githubToken).toBe('github_pat_storedStored0123456789abcdef')
  })

  it('says a failed save falls back to the value saved before, not that the token disappears', async () => {
    h.secure.set('naiToken', 'pst-storedStoredStored0123456')
    const first = await launch()
    await boot(first.useSettings)
    h.writeFails.add('naiToken')
    first.useSettings.getState().setToken('pst-newNewNewNew0123456789')
    await flush()
    const notice = first.useSettings.getState().secretErrors.token
    expect(notice).toMatch(/저장하지 못했습니다/)
    expect(notice).toMatch(/전에 저장된 값이 있으면 그 값을 씁니다/)
    h.writeFails.clear()
    const second = await launch()
    await boot(second.useSettings)
    expect(second.useSettings.getState().token).toBe('pst-storedStoredStored0123456')
  })

  it('drops the plaintext copy when the user clears a token, even if the secure store fails', async () => {
    legacySettings()
    // 시작할 때 읽지 못해 예전 평문을 쥐고 있다
    h.readFails.add('githubToken')
    const first = await launch()
    await boot(first.useSettings)
    expect(persisted().githubToken).toBe(LEGACY_GH)
    h.writeFails.add('githubToken')
    first.useSettings.getState().setGithubToken('')
    await flush()
    expect(persisted().githubToken).toBeUndefined()
    h.readFails.clear()
    h.writeFails.clear()
    const second = await launch()
    await boot(second.useSettings)
    expect(second.useSettings.getState().githubToken).toBe('')
  })

  it('keeps the plaintext copy when saving a different token fails (it is the only copy left)', async () => {
    legacySettings()
    h.readFails.add('naiToken')
    const { useSettings } = await launch()
    await boot(useSettings)
    h.writeFails.add('naiToken')
    useSettings.getState().setToken('pst-newNewNewNew0123456789')
    await flush()
    expect(persisted().token).toBe(LEGACY_NAI)
    expect(useSettings.getState().secretErrors.token).toMatch(/전에 저장된 값이 있으면 그 값을 씁니다/)
  })

  it('never puts the token notices into a backup', () => {
    const { settings } = splitSettings({ autoSave: true, secretErrors: { token: 'x' }, secretsLoaded: true })
    expect(settings).toEqual({ autoSave: true })
  })
})
