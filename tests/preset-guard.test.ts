/// <reference types="node" />
/**
 * 프리셋을 옮기거나 설정을 불러올 때 저장하지 않은 프롬프트를 잃지 않는지 —
 * 바뀐 칸 찾기, 저장하고 옮기기, 설정에 따른 자동 선택, 되돌리기.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 스토어들이 localStorage 를 쓴다 (node 에는 없다) — 가져오기 전에 메모리 것을 둔다.
// zustand persist 는 window.localStorage 를 보므로 window 도 둔다 (그래야 저장·다시 불러오기를 시험할 수 있다)
vi.hoisted(() => {
  const m = new Map<string, string>()
  const g = globalThis as Record<string, unknown>
  g.window ??= globalThis
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
})

import { applyImport, type Importable } from '../src/lib/apply'
import { collectStoreData } from '../src/backup/stores'
import {
  autoPresetName,
  autoSwitchChoice,
  hasUnsavedPrompt,
  presetSwitchMode,
  sameParams,
  undoPromptReplace,
  unsavedParts,
  usePrompt,
  usePromptUndo,
  type Params,
  type PromptPreset
} from '../src/stores/prompt'

const PARAMS: Params = {
  model: 'nai-diffusion-4-5-full',
  width: 832,
  height: 1216,
  steps: 28,
  cfgScale: 5,
  cfgRescale: 0,
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  variety: false,
  qualityToggle: true,
  ucPreset: 0
}

const A: PromptPreset = { id: 11, name: '작가 A', base: 'artist:aaa, 1girl', detail: 'soft light', negative: 'lowres', params: PARAMS }
const B: PromptPreset = { id: 12, name: '작가 B', base: 'artist:bbb, 1boy', detail: '', negative: 'bad hands', params: { ...PARAMS, steps: 23 } }

/** A를 고른 뒤 고정 칸만 고친 상태 */
function editedA(): void {
  usePrompt.setState({
    base: 'artist:aaa, 1girl, EDITED',
    additional: 'sitting',
    detail: A.detail,
    negative: A.negative,
    params: PARAMS,
    seed: '',
    presets: [A, B],
    activePresetId: A.id,
    presetSwitch: 'ask'
  })
}

beforeEach(() => {
  usePromptUndo.setState({ snap: null })
  editedA()
})

describe('unsaved detection', () => {
  it('finds the changed parts against the active preset', () => {
    expect(unsavedParts(usePrompt.getState())).toEqual(['base'])
    usePrompt.setState({ base: A.base, params: { ...PARAMS, cfgScale: 6 } })
    expect(unsavedParts(usePrompt.getState())).toEqual(['params'])
    usePrompt.setState({ params: PARAMS, negative: 'x' })
    expect(unsavedParts(usePrompt.getState())).toEqual(['negative'])
  })

  it('ignores line-ending and surrounding whitespace differences, and the additional (가변) prompt', () => {
    usePrompt.setState({ base: `  ${A.base}\r\n`, detail: `${A.detail} `, additional: 'anything' })
    expect(hasUnsavedPrompt(usePrompt.getState())).toBe(false)
  })

  it('compares params the way applyPreset fills them (missing keys → defaults, missing optional flag = off)', () => {
    const old = { ...A, params: { model: PARAMS.model, width: 832, height: 1216 } as Params }
    usePrompt.setState({ base: A.base, presets: [old, B], params: { ...PARAMS } })
    expect(hasUnsavedPrompt(usePrompt.getState())).toBe(false)
    // 나중에 생길 켜고 끄는 칸이 예전 프리셋에 없어도 꺼져 있으면 같은 것
    expect(sameParams({ ...PARAMS, someNewFlag: false } as Params, PARAMS)).toBe(true)
    expect(sameParams({ ...PARAMS, someNewFlag: true } as Params, PARAMS)).toBe(false)
  })

  it('without an active preset, any text in base/detail/negative is unsaved', () => {
    usePrompt.setState({ activePresetId: null, base: '', detail: '', negative: '' })
    expect(hasUnsavedPrompt(usePrompt.getState())).toBe(false)
    usePrompt.setState({ negative: 'lowres' })
    expect(unsavedParts(usePrompt.getState())).toEqual(['negative'])
    // 지워진 프리셋을 가리키면 프리셋이 없는 것과 같다
    usePrompt.setState({ activePresetId: 999 })
    expect(unsavedParts(usePrompt.getState())).toEqual(['negative'])
  })
})

describe('switchPreset', () => {
  it('discard: switches, keeps 가변, and undo restores text, params and the active preset', () => {
    const r = usePrompt.getState().switchPreset(B.id, 'discard')
    expect(r).toEqual({ savedTo: null, savedAsNew: false, undoable: true })
    let s = usePrompt.getState()
    expect([s.base, s.negative, s.params.steps, s.activePresetId, s.additional]).toEqual([B.base, B.negative, 23, B.id, 'sitting'])
    // 프리셋은 그대로
    expect(s.presets.find((p) => p.id === A.id)?.base).toBe(A.base)

    expect(undoPromptReplace()).toBe(true)
    s = usePrompt.getState()
    expect([s.base, s.detail, s.negative, s.params.steps, s.activePresetId]).toEqual([
      'artist:aaa, 1girl, EDITED',
      A.detail,
      A.negative,
      28,
      A.id
    ])
    // B는 고치지 않았으므로 다시 되돌릴 것이 없다
    expect(usePromptUndo.getState().snap).toBeNull()
    expect(undoPromptReplace()).toBe(false)
  })

  it('saveActive: writes the edits into the active preset first, undo returns to it (now clean)', () => {
    const r = usePrompt.getState().switchPreset(B.id, 'saveActive')
    expect(r).toEqual({ savedTo: '작가 A', savedAsNew: false, undoable: true })
    let s = usePrompt.getState()
    expect(s.presets.find((p) => p.id === A.id)?.base).toBe('artist:aaa, 1girl, EDITED')
    expect([s.base, s.activePresetId]).toEqual([B.base, B.id])
    undoPromptReplace()
    s = usePrompt.getState()
    expect([s.base, s.activePresetId]).toEqual(['artist:aaa, 1girl, EDITED', A.id])
    expect(hasUnsavedPrompt(s)).toBe(false)
  })

  it('saveNew: saves the edits as a new preset with the given name, then switches', () => {
    const r = usePrompt.getState().switchPreset(B.id, { saveNew: '  A 고친 것 ' })
    expect(r).toEqual({ savedTo: 'A 고친 것', savedAsNew: true, undoable: true })
    const s = usePrompt.getState()
    const saved = s.presets.find((p) => p.name === 'A 고친 것')!
    expect(saved.base).toBe('artist:aaa, 1girl, EDITED')
    expect(s.presets.find((p) => p.id === A.id)?.base).toBe(A.base)
    expect(s.activePresetId).toBe(B.id)
    undoPromptReplace()
    expect(usePrompt.getState().activePresetId).toBe(saved.id)
    expect(hasUnsavedPrompt(usePrompt.getState())).toBe(false)
  })

  it('a blank new name or saveActive without an active preset falls back to an automatic name', () => {
    usePrompt.getState().switchPreset(B.id, { saveNew: '  ' })
    expect(usePrompt.getState().presets.at(-1)?.name).toMatch(/^자동 저장 \d\d-\d\d \d\d:\d\d$/)
    usePrompt.setState({ activePresetId: null, base: 'loose text' })
    const r = usePrompt.getState().switchPreset(A.id, 'saveActive')
    expect(r?.savedAsNew).toBe(true)
    expect(usePrompt.getState().presets.at(-1)?.base).toBe('loose text')
  })

  it('a clean switch saves nothing and leaves no undo; the same preset with no changes is a no-op', () => {
    usePrompt.setState({ base: A.base })
    const before = usePrompt.getState().presets.length
    expect(usePrompt.getState().switchPreset(B.id, { saveNew: 'x' })).toEqual({ savedTo: null, savedAsNew: false, undoable: false })
    expect(usePrompt.getState().presets.length).toBe(before)
    expect(usePromptUndo.getState().snap).toBeNull()
    expect(usePrompt.getState().switchPreset(B.id, 'discard')?.undoable).toBe(false)
    expect(usePrompt.getState().switchPreset(999, 'discard')).toBeNull()
  })

  it('re-applying the active preset over edits is undoable; saving into it first is not (nothing changes)', () => {
    expect(usePrompt.getState().switchPreset(A.id, 'discard')?.undoable).toBe(true)
    expect(usePrompt.getState().base).toBe(A.base)
    undoPromptReplace()
    expect(usePrompt.getState().base).toBe('artist:aaa, 1girl, EDITED')
    expect(usePrompt.getState().switchPreset(A.id, 'saveActive')).toEqual({ savedTo: '작가 A', savedAsNew: false, undoable: false })
  })

  it('undo never loses text: edits made after the switch can be brought back', () => {
    usePrompt.getState().switchPreset(B.id, 'discard')
    usePrompt.getState().set({ base: 'artist:bbb, 1boy, LATER EDIT' })
    undoPromptReplace()
    expect(usePrompt.getState().base).toBe('artist:aaa, 1girl, EDITED')
    expect(usePromptUndo.getState().snap?.base).toBe('artist:bbb, 1boy, LATER EDIT')
    undoPromptReplace()
    expect([usePrompt.getState().base, usePrompt.getState().activePresetId]).toEqual(['artist:bbb, 1boy, LATER EDIT', B.id])
  })

  it('undo does not point at a preset that was deleted meanwhile', () => {
    usePrompt.getState().switchPreset(B.id, 'discard')
    usePrompt.getState().deletePreset(A.id)
    undoPromptReplace()
    expect([usePrompt.getState().base, usePrompt.getState().activePresetId]).toEqual(['artist:aaa, 1girl, EDITED', null])
  })
})

describe('switch setting', () => {
  it('defaults to ask and sanitises unknown values', () => {
    expect(presetSwitchMode(undefined)).toBe('ask')
    expect(presetSwitchMode('nonsense')).toBe('ask')
    expect(presetSwitchMode('saveNew')).toBe('saveNew')
    usePrompt.getState().setPresetSwitch('bogus' as never)
    expect(usePrompt.getState().presetSwitch).toBe('ask')
  })

  it('picks what to do without asking for the automatic modes', () => {
    const now = new Date(2026, 10, 28, 14, 5)
    expect(autoSwitchChoice(usePrompt.getState(), now)).toBeNull()
    usePrompt.getState().setPresetSwitch('saveActive')
    expect(autoSwitchChoice(usePrompt.getState(), now)).toBe('saveActive')
    usePrompt.setState({ activePresetId: null })
    expect(autoSwitchChoice(usePrompt.getState(), now)).toEqual({ saveNew: '자동 저장 11-28 14:05' })
    usePrompt.getState().setPresetSwitch('saveNew')
    usePrompt.setState({ activePresetId: A.id })
    expect(autoSwitchChoice(usePrompt.getState(), now)).toEqual({ saveNew: '자동 저장 11-28 14:05' })
  })

  it('numbers automatic names that are already taken', () => {
    const now = new Date(2026, 0, 2, 3, 4)
    expect(autoPresetName(now)).toBe('자동 저장 01-02 03:04')
    expect(autoPresetName(now, ['자동 저장 01-02 03:04'])).toBe('자동 저장 01-02 03:04 (2)')
    expect(autoPresetName(now, ['자동 저장 01-02 03:04', '자동 저장 01-02 03:04 (2)'])).toBe('자동 저장 01-02 03:04 (3)')
  })

  it('old saved prompt data without the setting still loads, as ask', async () => {
    // 앱을 새로 열 때처럼 처음 값(물어보기)에서 0.13.1이 저장한 것을 읽는다 (setState 는 바로 저장하므로 먼저)
    usePrompt.setState({ presetSwitch: usePrompt.getInitialState().presetSwitch })
    localStorage.setItem(
      'naip-prompt',
      JSON.stringify({ state: { base: 'from 0.13.1', presets: [A], activePresetId: A.id, params: PARAMS }, version: 0 })
    )
    await usePrompt.persist.rehydrate()
    const s = usePrompt.getState()
    expect([s.base, s.presetSwitch, s.presets.length]).toEqual(['from 0.13.1', 'ask', 1])
  })

  it('the undo snapshot is memory-only: not in the persisted prompt or the backup', () => {
    usePrompt.getState().switchPreset(B.id, 'discard')
    expect(usePromptUndo.getState().snap).not.toBeNull()
    const persisted = JSON.parse(localStorage.getItem('naip-prompt') ?? '{}').state
    expect(JSON.stringify(persisted)).not.toContain('EDITED')
    const backup = collectStoreData()
    expect(JSON.stringify(backup.prompt)).not.toContain('EDITED')
    expect(backup.prompt?.presetSwitch).toBe('ask')
  })
})

describe('applyImport (설정 불러오기)', () => {
  const data: Importable = {
    base: 'imported base',
    additional: '',
    detail: '',
    negative: 'imported neg',
    params: { steps: 40 },
    seed: 7,
    chars: []
  }

  it('replacing unsaved text is undoable, and undo restores 가변·시드 too', () => {
    usePrompt.setState({ seed: '123' })
    const r = applyImport(data, new Set(['prompt', 'negative', 'sampling', 'seed']), null)
    expect(r.undoable).toBe(true)
    let s = usePrompt.getState()
    expect([s.base, s.additional, s.negative, s.params.steps, s.seed]).toEqual(['imported base', '', 'imported neg', 40, '7'])
    undoPromptReplace()
    s = usePrompt.getState()
    expect([s.base, s.additional, s.negative, s.params.steps, s.seed, s.activePresetId]).toEqual([
      'artist:aaa, 1girl, EDITED',
      'sitting',
      A.negative,
      28,
      '123',
      A.id
    ])
  })

  it('as a new preset: undo goes back to the previous preset and keeps the imported preset', () => {
    const r = applyImport(data, new Set(['prompt']), '가져옴')
    expect(r.undoable).toBe(true)
    const imported = usePrompt.getState().presets.find((p) => p.name === '가져옴')!
    expect(usePrompt.getState().activePresetId).toBe(imported.id)
    undoPromptReplace()
    expect(usePrompt.getState().activePresetId).toBe(A.id)
    expect(usePrompt.getState().presets.some((p) => p.id === imported.id)).toBe(true)
  })

  it('nothing unsaved (clean preset, empty 가변) → not undoable', () => {
    usePrompt.setState({ base: A.base, additional: '' })
    expect(applyImport(data, new Set(['prompt', 'negative']), null).undoable).toBe(false)
    expect(usePromptUndo.getState().snap).toBeNull()
  })

  it('unsaved text but nothing it touches changes → not undoable', () => {
    expect(applyImport(data, new Set(['seed']), null).undoable).toBe(false)
  })
})
