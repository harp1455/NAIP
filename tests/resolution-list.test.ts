/// <reference types="node" />
/**
 * 해상도 목록 — 내 해상도 더하기·지우기·순서 바꾸기, 기본 해상도 숨기기, 크기 검사,
 * 예전 설정(목록 없음)·손상된 값 불러오기, 백업에 담기고 되살아나는지.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 스토어가 localStorage 를 쓴다 (node 에는 없다) — 가져오기 전에 메모리 것을 둔다
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
  // zustand persist 는 window.localStorage 를 쓴다
  ;(globalThis as Record<string, unknown>).window ??= globalThis
})

import {
  addUserResolution,
  BUILTIN_RESOLUTIONS,
  exceedsFreeArea,
  findResolution,
  isListedSize,
  MAX_USER_RESOLUTIONS,
  moveUserResolution,
  normalizeHiddenResolutions,
  normalizeResolutionPrefs,
  normalizeUserResolutions,
  removeUserResolution,
  resolutionGroups,
  setBuiltinHidden,
  sizeProblem,
  USER_GROUP_LABEL,
  type ResolutionPrefs
} from '../src/nai/resolutionList'
import { RESOLUTIONS } from '../src/nai/constants'
import { bytesSource, memorySink, openNaipBackup, planRestore, writeNaipBackup, type BackupData } from '../src/backup'
import { splitSettings } from '../src/backup/format'
import { applyRestorePlan, collectStoreData, normalizeBackupData } from '../src/backup/stores'
import { useSettings } from '../src/stores/settings'

const EMPTY: ResolutionPrefs = { resolutions: [], hiddenResolutions: [] }
const ALL_KEYS = BUILTIN_RESOLUTIONS.map((r) => r.key)

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok: ${JSON.stringify(r)}`)
  return r as Extract<T, { ok: true }>
}

function errorOf(r: { ok: boolean; error?: string }): string {
  if (r.ok) throw new Error('expected an error')
  return r.error!
}

describe('size rules (NovelAI: 64 multiples, ≥ 64, ≤ 3 MiP)', () => {
  it('accepts every built-in size and the exact 3 MiP limit', () => {
    for (const r of RESOLUTIONS) expect(sizeProblem(r.width, r.height), r.label).toBeNull()
    expect(sizeProblem(2048, 1536)).toBeNull()
    expect(sizeProblem(64, 64)).toBeNull()
  })

  it('rejects non-numbers, non-multiples of 64, too small and too large sizes', () => {
    expect(sizeProblem(NaN, 1024)).toContain('숫자')
    expect(sizeProblem(0, 1024)).toContain('숫자')
    expect(sizeProblem(1000.5, 1024)).toContain('숫자')
    expect(sizeProblem(1000, 1024)).toContain('64의 배수')
    expect(sizeProblem(32, 1024)).toContain('64 이상')
    expect(sizeProblem(2048, 1600)).toContain('너무 큽니다')
  })

  it('marks sizes above the Opus free area (1024×1024)', () => {
    expect(exceedsFreeArea(1024, 1024)).toBe(false)
    expect(exceedsFreeArea(832, 1216)).toBe(false)
    expect(exceedsFreeArea(1024, 1088)).toBe(true)
    expect(exceedsFreeArea(1024, 1536)).toBe(true)
  })
})

describe('merged list (visible built-ins + 내 해상도)', () => {
  it('shows the NAI groups with every built-in by default, and no 내 해상도 group', () => {
    const groups = resolutionGroups(EMPTY)
    expect(groups.map((g) => g.label)).toEqual(['Normal', 'Large', 'Wallpaper', 'Small'])
    expect(groups.flatMap((g) => g.items).map((o) => o.text)).toEqual(RESOLUTIONS.map((r) => `${r.label} (${r.width}×${r.height})`))
  })

  it('puts user sizes last in their own group, in their order, named or not', () => {
    const groups = resolutionGroups({ resolutions: [{ name: '카드', width: 896, height: 1152 }, { width: 704, height: 1408 }], hiddenResolutions: [] })
    expect(groups.at(-1)).toMatchObject({ label: USER_GROUP_LABEL })
    expect(groups.at(-1)!.items.map((o) => [o.text, o.builtin])).toEqual([
      ['카드 (896×1152)', false],
      ['704×1408', false]
    ])
  })

  it('leaves hidden built-ins (and an emptied group) out, so their sizes count as not listed', () => {
    const prefs = { resolutions: [], hiddenResolutions: ['1088x1920', '1920x1088', '832x1216'] }
    const groups = resolutionGroups(prefs)
    expect(groups.map((g) => g.label)).toEqual(['Normal', 'Large', 'Small'])
    expect(findResolution(groups, 832, 1216)).toBeUndefined()
    expect(isListedSize(prefs, 832, 1216)).toBe(false)
    expect(isListedSize(prefs, 1216, 832)).toBe(true)
    expect(isListedSize(prefs, 896, 1152)).toBe(false)
  })

  it('is never empty: with everything hidden and no user sizes it falls back to all built-ins', () => {
    const groups = resolutionGroups({ resolutions: [], hiddenResolutions: ALL_KEYS })
    expect(groups.flatMap((g) => g.items)).toHaveLength(RESOLUTIONS.length)
  })

  it('shows a user size that matches a visible built-in only once', () => {
    const groups = resolutionGroups({ resolutions: [{ name: '내 세로', width: 832, height: 1216 }, { width: 896, height: 1152 }], hiddenResolutions: [] })
    expect(groups.flatMap((g) => g.items).filter((o) => o.key === '832x1216')).toHaveLength(1)
    expect(groups.at(-1)!.items.map((o) => o.key)).toEqual(['896x1152'])
  })
})

describe('editing the list', () => {
  it('adds a size to the end, trimming the name', () => {
    let p = ok(addUserResolution(EMPTY, { name: '  캐릭터\n카드  ', width: 896, height: 1152 }))
    p = ok(addUserResolution(p, { name: '', width: 704, height: 1408 }))
    expect(p.resolutions).toEqual([{ name: '캐릭터 카드', width: 896, height: 1152 }, { width: 704, height: 1408 }])
  })

  it('refuses invalid sizes and duplicates', () => {
    const p = ok(addUserResolution(EMPTY, { name: '카드', width: 896, height: 1152 }))
    expect(errorOf(addUserResolution(p, { width: 1000, height: 1000 }))).toContain('64의 배수')
    expect(errorOf(addUserResolution(p, { width: 896, height: 1152 }))).toContain('카드 (896×1152)')
    expect(errorOf(addUserResolution(p, { width: 832, height: 1216 }))).toContain('세로')
  })

  it('shows a hidden built-in again instead of adding a duplicate of it', () => {
    const r = ok(addUserResolution({ resolutions: [], hiddenResolutions: ['832x1216', '640x640'] }, { name: '세로', width: 832, height: 1216 }))
    expect(r.resolutions).toEqual([])
    expect(r.hiddenResolutions).toEqual(['640x640'])
    expect(r.notice).toContain('다시 보이게')
  })

  it(`keeps at most ${MAX_USER_RESOLUTIONS} user sizes`, () => {
    let p: ResolutionPrefs = EMPTY
    for (let i = 0; i < MAX_USER_RESOLUTIONS; i++) p = ok(addUserResolution(p, { width: 64 * (i + 1), height: 128 }))
    expect(errorOf(addUserResolution(p, { width: 64, height: 192 }))).toContain(`${MAX_USER_RESOLUTIONS}개`)
  })

  it('moves a size up and down, and does nothing past either end', () => {
    const p: ResolutionPrefs = { resolutions: [{ width: 64, height: 64 }, { width: 128, height: 128 }, { width: 192, height: 192 }], hiddenResolutions: [] }
    expect(ok(moveUserResolution(p, 2, -1)).resolutions.map((r) => r.width)).toEqual([64, 192, 128])
    expect(ok(moveUserResolution(p, 0, 1)).resolutions.map((r) => r.width)).toEqual([128, 64, 192])
    expect(ok(moveUserResolution(p, 0, -1)).resolutions).toEqual(p.resolutions)
    expect(ok(moveUserResolution(p, 2, 1)).resolutions).toEqual(p.resolutions)
  })

  it('removes a size, but never the last thing left in the list', () => {
    const p: ResolutionPrefs = { resolutions: [{ width: 896, height: 1152 }, { width: 704, height: 1408 }], hiddenResolutions: [] }
    expect(ok(removeUserResolution(p, 0)).resolutions).toEqual([{ width: 704, height: 1408 }])
    const lastOne: ResolutionPrefs = { resolutions: [{ width: 896, height: 1152 }], hiddenResolutions: ALL_KEYS }
    expect(errorOf(removeUserResolution(lastOne, 0))).toContain('하나는')
    expect(errorOf(removeUserResolution(p, 5))).toBeTruthy()
  })

  it('hides and shows built-ins, but never hides the last visible size', () => {
    let p = ok(setBuiltinHidden(EMPTY, '640x640', true))
    expect(p.hiddenResolutions).toEqual(['640x640'])
    p = ok(setBuiltinHidden(p, '640x640', false))
    expect(p.hiddenResolutions).toEqual([])
    const almost: ResolutionPrefs = { resolutions: [], hiddenResolutions: ALL_KEYS.filter((k) => k !== '1024x1024') }
    expect(errorOf(setBuiltinHidden(almost, '1024x1024', true))).toContain('하나는')
    // 내 해상도가 있으면 기본 해상도를 모두 숨길 수 있다
    expect(ok(setBuiltinHidden({ ...almost, resolutions: [{ width: 896, height: 1152 }] }, '1024x1024', true)).hiddenResolutions).toHaveLength(ALL_KEYS.length)
    expect(errorOf(setBuiltinHidden(EMPTY, '999x999', true))).toBeTruthy()
  })
})

describe('loading saved values (old settings, damaged values)', () => {
  it('turns anything that is not a list into an empty list', () => {
    for (const raw of [undefined, null, 'x', 3, {}]) {
      expect(normalizeUserResolutions(raw)).toEqual([])
      expect(normalizeHiddenResolutions(raw)).toEqual([])
    }
  })

  it('keeps usable entries only', () => {
    expect(
      normalizeUserResolutions([
        null,
        5,
        'x',
        [],
        { width: '896', height: 1152 },
        { width: 1000, height: 1000 },
        { name: 7, width: 896, height: 1152 },
        { name: '같은 크기', width: 896, height: 1152 },
        { name: '  긴  이름 '.repeat(10), width: 704, height: 1408, extra: true }
      ])
    ).toEqual([{ width: 896, height: 1152 }, { name: '긴 이름 긴 이름 긴 이름 긴 이름 긴 이름 긴 이름', width: 704, height: 1408 }])
    expect(normalizeHiddenResolutions(['832x1216', '832x1216', 'nope', 5, '640x640'])).toEqual(['832x1216', '640x640'])
  })

  it('never leaves the list empty', () => {
    expect(normalizeResolutionPrefs({ resolutions: [], hiddenResolutions: ALL_KEYS })).toEqual(EMPTY)
    expect(normalizeResolutionPrefs({ resolutions: [{ width: 7, height: 7 }], hiddenResolutions: ALL_KEYS })).toEqual(EMPTY)
    const mine = { resolutions: [{ width: 896, height: 1152 }], hiddenResolutions: ALL_KEYS }
    expect(normalizeResolutionPrefs(mine)).toEqual(mine)
  })
})

describe('settings store', () => {
  beforeEach(() => {
    localStorage.clear()
    useSettings.setState({ resolutions: [], hiddenResolutions: [], autoSave: false })
  })

  const saved = (): Record<string, unknown> => JSON.parse(localStorage.getItem('naip-settings') ?? '{}').state

  it('starts with an empty user list and nothing hidden', () => {
    const s = useSettings.getInitialState()
    expect(s.resolutions).toEqual([])
    expect(s.hiddenResolutions).toEqual([])
  })

  it('adds, moves, hides and removes, and saves every change', () => {
    const s = useSettings.getState()
    expect(s.addResolution({ name: '카드', width: 896, height: 1152 }).ok).toBe(true)
    expect(s.addResolution({ width: 704, height: 1408 }).ok).toBe(true)
    expect(s.moveResolution(1, -1).ok).toBe(true)
    expect(s.setResolutionHidden('640x640', true).ok).toBe(true)
    expect(saved()).toMatchObject({
      resolutions: [{ width: 704, height: 1408 }, { name: '카드', width: 896, height: 1152 }],
      hiddenResolutions: ['640x640']
    })
    expect(s.removeResolution(0).ok).toBe(true)
    expect(saved().resolutions).toEqual([{ name: '카드', width: 896, height: 1152 }])
  })

  it('does not change anything when an edit is refused', () => {
    const s = useSettings.getState()
    s.addResolution({ width: 896, height: 1152 })
    const before = useSettings.getState().resolutions
    const r = s.addResolution({ width: 896, height: 1152 })
    expect(r.ok).toBe(false)
    expect(useSettings.getState().resolutions).toBe(before)
  })

  it('loads settings saved by an older version (no list) and keeps the other settings', async () => {
    // (setState 가 naip-settings 를 다시 쓰므로 먼저)
    useSettings.setState({ resolutions: [{ width: 896, height: 1152 }] })
    localStorage.setItem('naip-settings', JSON.stringify({ state: { autoSave: true, historyLimit: 500, delayMin: 1.5, delayMax: 1.8 }, version: 0 }))
    await useSettings.persist.rehydrate()
    const s = useSettings.getState()
    expect(s.autoSave).toBe(true)
    expect(s.historyLimit).toBe(500)
    // 저장된 값에 목록이 없으면 지금 값(처음 열 때는 빈 목록)을 그대로 둔다
    expect(s.resolutions).toEqual([{ width: 896, height: 1152 }])
    expect(s.hiddenResolutions).toEqual([])
  })

  it('repairs damaged saved values on load', async () => {
    localStorage.setItem(
      'naip-settings',
      JSON.stringify({ state: { resolutions: [{ width: 896, height: 1152 }, null, { width: 1, height: 2 }], hiddenResolutions: 'all' }, version: 0 })
    )
    await useSettings.persist.rehydrate()
    expect(useSettings.getState().resolutions).toEqual([{ width: 896, height: 1152 }])
    expect(useSettings.getState().hiddenResolutions).toEqual([])
    localStorage.setItem('naip-settings', JSON.stringify({ state: { resolutions: [], hiddenResolutions: ALL_KEYS }, version: 0 }))
    await useSettings.persist.rehydrate()
    expect(useSettings.getState().hiddenResolutions).toEqual([])
  })
})

describe('backup', () => {
  beforeEach(() => {
    localStorage.clear()
    useSettings.setState({ resolutions: [], hiddenResolutions: [], autoSave: false })
  })

  async function roundTrip(data: BackupData): Promise<BackupData> {
    const sink = memorySink()
    await writeNaipBackup(data, sink, { mode: 'light', appVersion: '0.13.1', createdAt: '2026-11-28T00:00:00.000Z' })
    const reader = await openNaipBackup(bytesSource(sink.bytes()))
    const { data: read, problems } = await reader.readData()
    expect(problems).toEqual([])
    return normalizeBackupData(read)
  }

  const MINE = [{ name: '카드', width: 896, height: 1152 }, { width: 704, height: 1408 }]

  it('puts the list in the settings section (not the save-folder section)', () => {
    const { settings, saveFolders } = splitSettings({ resolutions: MINE, hiddenResolutions: ['640x640'], autoSave: true, saveFolders: [] })
    expect(settings).toEqual({ resolutions: MINE, hiddenResolutions: ['640x640'], autoSave: true })
    expect(saveFolders).toEqual({ saveFolders: [] })
  })

  it('round-trips the list through a backup file and restores it', async () => {
    useSettings.setState({ resolutions: MINE, hiddenResolutions: ['640x640', '1920x1088'] })
    const incoming = await roundTrip(collectStoreData())
    expect(incoming.settings).toMatchObject({ resolutions: MINE, hiddenResolutions: ['640x640', '1920x1088'] })

    // 다른 기기(목록 없음)에 덮어쓰기
    useSettings.setState({ resolutions: [], hiddenResolutions: [] })
    applyRestorePlan(planRestore(collectStoreData(), incoming, { mode: 'overwrite' }))
    expect(useSettings.getState().resolutions).toEqual(MINE)
    expect(useSettings.getState().hiddenResolutions).toEqual(['640x640', '1920x1088'])
  })

  it('merging fills an empty list from the backup and keeps a list that is already there', async () => {
    useSettings.setState({ resolutions: MINE, hiddenResolutions: [] })
    const incoming = await roundTrip(collectStoreData())
    useSettings.setState({ resolutions: [] })
    applyRestorePlan(planRestore(collectStoreData(), incoming, { mode: 'merge' }))
    expect(useSettings.getState().resolutions).toEqual(MINE)

    const here = [{ name: '여기', width: 1024, height: 1088 }]
    useSettings.setState({ resolutions: here })
    applyRestorePlan(planRestore(collectStoreData(), incoming, { mode: 'merge' }))
    expect(useSettings.getState().resolutions).toEqual(here)
  })

  it('restores an old backup without the list and leaves the current list alone', async () => {
    useSettings.setState({ resolutions: MINE, hiddenResolutions: ['640x640'] })
    const old = await roundTrip({ settings: { autoSave: true, historyLimit: 200 }, saveFolders: { saveFolders: ['a'] } })
    for (const mode of ['overwrite', 'merge'] as const) {
      applyRestorePlan(planRestore(collectStoreData(), old, { mode }))
      expect(useSettings.getState().autoSave, mode).toBe(true)
      expect(useSettings.getState().resolutions, mode).toEqual(MINE)
      expect(useSettings.getState().hiddenResolutions, mode).toEqual(['640x640'])
    }
  })

  it('cleans a damaged list from a backup and never ends up with an empty list', async () => {
    const crafted = await roundTrip({
      settings: { resolutions: [{ width: 896, height: 1152 }, 'x', null, { width: 999, height: 999 }], hiddenResolutions: [...ALL_KEYS, 'evil'] }
    })
    expect(crafted.settings).toMatchObject({ resolutions: [{ width: 896, height: 1152 }], hiddenResolutions: ALL_KEYS })
    applyRestorePlan(planRestore(collectStoreData(), crafted, { mode: 'overwrite' }))
    expect(useSettings.getState().resolutions).toEqual([{ width: 896, height: 1152 }])

    // 백업 목록이 비어 있고 기본 해상도를 모두 숨겼어도, 넣은 뒤 목록이 비지 않는다
    const emptyAll = await roundTrip({ settings: { resolutions: [], hiddenResolutions: ALL_KEYS } })
    applyRestorePlan(planRestore(collectStoreData(), emptyAll, { mode: 'overwrite' }))
    expect(useSettings.getState().resolutions).toEqual([])
    expect(useSettings.getState().hiddenResolutions).toEqual([])
    // 계획을 거치지 않고 손상된 값이 들어와도
    applyRestorePlan({
      sections: { settings: { section: 'settings', action: 'overwrite', result: { resolutions: 'bad', hiddenResolutions: ALL_KEYS }, stats: {} as never, changes: [], notes: [] } },
      history: null,
      warnings: []
    })
    expect(useSettings.getState().resolutions).toEqual([])
    expect(useSettings.getState().hiddenResolutions).toEqual([])
  })
})
