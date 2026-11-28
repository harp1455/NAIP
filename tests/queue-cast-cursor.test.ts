/// <reference types="node" />
/**
 * "배치에 한 번" 순차 슬롯·순차 변형 그룹이 새 배치마다 한 칸씩 나아가는지 (배치를 넘어 이어 가는 순서 위치).
 * - 이미지가 한 장이라도 나온 배치만 다음 차례로 넘긴다 (보내기 전에 멈춘 배치·실패한 배치는 차례를 쓰지 않는다)
 * - 앱을 다시 열어도 이어 간다 (캐릭터 스토어에 저장)
 * - 이어서 생성은 처음 돌 때의 자리로 뽑고, 두 번 넘기지 않는다
 * - 장마다 뽑는 순차는 지금처럼 배치마다 처음부터
 * 네트워크는 흉내 낸다 — 실제 NovelAI API는 부르지 않는다.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 캐릭터 스토어가 localStorage 에 저장한다 (node 에는 없다) — 가져오기 전에 메모리 것을 둔다
const disk = vi.hoisted(() => {
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
  return m
})

const calls: { chars: string[] }[] = []
let hold: ((signal?: AbortSignal) => Promise<void>) | null = null
let fail: (() => Error | null) | null = null
vi.mock('../src/nai/client', () => {
  class NaiHttpError extends Error {
    status = 0
    retryAfterMs?: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  }
  return {
    NaiHttpError,
    fetchSubscription: vi.fn(async () => {
      throw new Error('offline')
    }),
    encodeVibe: vi.fn(),
    generateImageStream: vi.fn(),
    generateImage: vi.fn(
      async (_token: string, request: { prompt: string; characterPrompts: { prompt: string }[] }, _opts: unknown, signal?: AbortSignal) => {
        calls.push({ chars: request.characterPrompts.map((c) => c.prompt) })
        if (hold) await hold(signal)
        const err = fail?.()
        if (err) throw err
        return {
          image: new Blob([new Uint8Array(64)], { type: 'image/png' }),
          payload: { input: request.prompt, parameters: { negative_prompt: '' } },
          stats: { waitMs: 1, downloadMs: 1, sentBytes: 1, receivedBytes: 1 }
        }
      }
    )
  }
})
vi.mock('../src/lib/image', () => ({
  makeThumb: async () => 'data:image/jpeg;base64,AAAA',
  normalizeInpaintMask: async () => null,
  processCharRefImage: async () => '',
  processCharRefImageV5: async () => '',
  resizeToPngBase64: async () => '',
  blobToBase64: async () => '',
  loadImage: async () => ({ naturalWidth: 1, naturalHeight: 1 }),
  scrubAlpha: () => {}
}))

import { getStorage, setStorageForTests } from '../src/storage'
import { createSqlJsDriver } from '../src/storage/sqljs'
import { memoryFileStore } from '../src/storage/files'
import { NaiHttpError } from '../src/nai/client'
import { DEFAULT_CAST_OPTIONS, type CastCharacter, type CastOptions, type CastSlot, type VariationGroup } from '../src/nai/cast'
import { useGeneration } from '../src/stores/generation'
import { useHistory } from '../src/stores/history'
import { loadResume } from '../src/stores/queue-persist'
import { usePrompt } from '../src/stores/prompt'
import { useSettings } from '../src/stores/settings'
import { migrateCharacters, useCharacters } from '../src/stores/characters'
import { applyRestorePlan, collectStoreData, normalizeBackupData, normalizeCharactersSection } from '../src/backup/stores'
import { planRestore } from '../src/backup/plan'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 500 && !cond(); i++) await sleep(5)
  expect(cond()).toBe(true)
}
const idle = async (): Promise<void> => {
  await sleep(0)
  for (let i = 0; i < 500 && useGeneration.getState().running; i++) await sleep(10)
  expect(useGeneration.getState().running).toBe(false)
  // 끝난 배치의 기록 지우기(drop)가 저장소에 닿을 때까지
  await sleep(20)
}

const char = (id: number, name: string, variations: VariationGroup[] = []): CastCharacter => ({
  id,
  name,
  folderId: null,
  base: `char ${name}`,
  additional: '',
  detail: '',
  negative: '',
  variations
})
const SLOT = 77
const seqSlot = (p: Partial<CastSlot> = {}): CastSlot => ({
  id: SLOT,
  enabled: true,
  mode: 'sequential',
  charId: null,
  candidates: [1, 2, 3].map((id) => ({ kind: 'char' as const, id, weight: 1 })),
  chance: 100,
  wrap: true,
  center: null,
  ...p
})
const outfit: VariationGroup = {
  id: 5,
  kind: 'outfit',
  name: '',
  mode: 'sequential',
  fixedId: null,
  perBatch: true,
  items: [
    { id: 51, label: '교복', prompt: 'uniform', weight: 1 },
    { id: 52, label: '수영복', prompt: 'swimsuit', weight: 1 }
  ]
}

function cast(slots: CastSlot[], options: Partial<CastOptions>, characters = [char(1, 'A'), char(2, 'B'), char(3, 'C')]): void {
  useCharacters.setState({ folders: [], characters, slots, options: { ...DEFAULT_CAST_OPTIONS, ...options }, cursors: {} })
}

/** 생성 버튼 한 번 = 배치 하나. 그 배치가 보낸 장마다 첫 캐릭터 프롬프트 */
async function press(count: number): Promise<string[]> {
  const from = calls.length
  usePrompt.setState({ count })
  await useGeneration.getState().start()
  await idle()
  return calls.slice(from).map((c) => c.chars.join(' + '))
}

beforeEach(async () => {
  calls.length = 0
  hold = null
  fail = null
  disk.clear()
  await setStorageForTests(await createSqlJsDriver(), memoryFileStore())
  useSettings.setState({ token: 'pst-test', autoSave: false, background: false, keepAwake: false, vibrate: false, streaming: false, historyLimit: 0, delayMin: 0, delayMax: 0 })
  usePrompt.setState({ seed: '', count: 1 })
  await useHistory.getState().init()
})

describe('once-per-batch sequences continue across batches', () => {
  it('a sequential slot drawn once per batch moves to the next candidate with every new batch (and wraps)', async () => {
    cast([seqSlot()], { scope: 'batch' })
    expect(await press(2)).toEqual(['char A', 'char A'])
    expect(await press(2)).toEqual(['char B', 'char B'])
    expect(await press(1)).toEqual(['char C'])
    expect(await press(2)).toEqual(['char A', 'char A'])
  }, 20000)

  it('a sequential variation group drawn once per batch moves to the next item with every new batch', async () => {
    cast([{ ...seqSlot(), mode: 'fixed', charId: 1, candidates: [] }], { scope: 'image' }, [char(1, 'A', [outfit])])
    expect(await press(2)).toEqual(['char A, uniform', 'char A, uniform'])
    expect(await press(2)).toEqual(['char A, swimsuit', 'char A, swimsuit'])
    expect(await press(1)).toEqual(['char A, uniform'])
  }, 20000)

  it('per-image sequences still start every batch from the first candidate', async () => {
    cast([seqSlot()], { scope: 'image' }, [char(1, 'A', [{ ...outfit, perBatch: false }]), char(2, 'B'), char(3, 'C')])
    expect(await press(3)).toEqual(['char A, uniform', 'char B', 'char C'])
    expect(await press(2)).toEqual(['char A, uniform', 'char B'])
    expect(useCharacters.getState().cursors).toEqual({})
  }, 20000)

  it('batches queued behind a running one each take the next turn', async () => {
    cast([seqSlot()], { scope: 'batch' })
    let open!: () => void
    const opened = new Promise<void>((r) => (open = r))
    hold = () => opened
    usePrompt.setState({ count: 1 })
    const first = useGeneration.getState().start()
    await until(() => calls.length === 1)
    // 첫 배치가 도는 사이에 두 번 더 누른다 — 누른 순간이 아니라 실제로 돌 때의 자리로 뽑는다
    await useGeneration.getState().start()
    await useGeneration.getState().start()
    expect(useGeneration.getState().queue).toHaveLength(2)
    hold = null
    open()
    await first
    await idle()
    expect(calls.map((c) => c.chars[0])).toEqual(['char A', 'char B', 'char C'])
  }, 20000)

  it('keeps the position over an app restart', async () => {
    cast([seqSlot()], { scope: 'batch' })
    expect(await press(1)).toEqual(['char A'])
    const stored = disk.get('naip-characters') ?? '{}'
    const saved = JSON.parse(stored) as { state?: { cursors?: Record<string, number> } }
    expect(saved.state?.cursors).toEqual({ [`slot:${SLOT}`]: 1 })
    // 앱을 다시 연 것처럼 메모리의 자리를 잃은 뒤 저장된 것을 다시 읽는다
    useCharacters.setState({ cursors: {} })
    disk.set('naip-characters', stored)
    await useCharacters.persist.rehydrate()
    expect(useCharacters.getState().cursors).toEqual({ [`slot:${SLOT}`]: 1 })
    expect(await press(1)).toEqual(['char B'])
  }, 20000)

  it('loads data saved by an older version (no position) and starts from the first candidate', async () => {
    cast([], {})
    const old = { folders: [], characters: [char(1, 'A'), char(2, 'B'), char(3, 'C')], slots: [seqSlot()], options: { ...DEFAULT_CAST_OPTIONS, scope: 'batch' } }
    disk.set('naip-characters', JSON.stringify({ state: old, version: 1 }))
    await useCharacters.persist.rehydrate()
    expect(useCharacters.getState().slots.map((s) => s.id)).toEqual([SLOT])
    expect(useCharacters.getState().cursors).toEqual({})
    expect(await press(1)).toEqual(['char A'])
    expect(await press(1)).toEqual(['char B'])
  }, 20000)

  it('a reset made while a batch is running is kept when that batch finishes', async () => {
    cast([seqSlot()], { scope: 'batch' })
    expect(await press(1)).toEqual(['char A'])
    let open!: () => void
    const opened = new Promise<void>((r) => (open = r))
    hold = () => opened
    usePrompt.setState({ count: 1 })
    const run = useGeneration.getState().start()
    await until(() => calls.length === 2)
    useCharacters.getState().resetCursors()
    hold = null
    open()
    await run
    await idle()
    expect(calls[1].chars).toEqual(['char B'])
    expect(useCharacters.getState().cursors).toEqual({})
    expect(await press(1)).toEqual(['char A'])
  }, 20000)

  it('재추첨 생성 redraws on its own and leaves the sequence where it was', async () => {
    cast([seqSlot()], { scope: 'batch' })
    expect(await press(1)).toEqual(['char A'])
    expect(await press(1)).toEqual(['char B'])
    const image = useHistory.getState().items[0]
    expect(image.snap?.cast).toBeDefined()
    const from = calls.length
    await useGeneration.getState().start({ regenerate: image, redraw: true })
    await idle()
    expect(calls.length).toBe(from + 1)
    expect(useCharacters.getState().cursors).toEqual({ [`slot:${SLOT}`]: 2 })
    expect(await press(1)).toEqual(['char C'])
  }, 20000)
})

describe('a reset, restore or removal made while a batch is running is kept', () => {
  /** 배치(처음 자리 = 첫 후보)의 둘째 장을 보낼 때 — 첫 장이 자리를 넘긴 뒤 — 무언가를 한다 */
  async function pressWhileSecondIsSent(count: number, act: () => void): Promise<{ seen: Record<string, number>; sent: string[] }> {
    let seen: Record<string, number> | null = null
    hold = async () => {
      if (calls.length !== 2 || seen) return
      seen = { ...useCharacters.getState().cursors }
      act()
    }
    const sent = await press(count)
    hold = null
    expect(seen).not.toBeNull()
    return { seen: seen!, sent }
  }

  it('a confirmed reset after the first image of a batch that started at the first candidate', async () => {
    cast([seqSlot()], { scope: 'batch' })
    const { seen, sent } = await pressWhileSecondIsSent(3, () => useCharacters.getState().resetCursors())
    // 첫 장이 자리를 1로 넘겨 되돌리기가 보였고, 그걸 눌렀다 — 이 배치는 끝까지 A
    expect(seen).toEqual({ [`slot:${SLOT}`]: 1 })
    expect(sent).toEqual(['char A', 'char A', 'char A'])
    // 남은 장이 돌아와도 되돌린 자리를 다시 넘기지 않는다 — 다음 배치는 처음(A)부터
    expect(useCharacters.getState().cursors).toEqual({})
    expect(await press(1)).toEqual(['char A'])
    expect(await press(1)).toEqual(['char B'])
  }, 20000)

  it('a reset also holds for a sequence the batch had not moved yet', async () => {
    // B의 변형 그룹은 둘째 장에 처음 나온다 — 그 장이 돌아와도 "다음 배치부터 처음으로"가 지켜진다
    cast([seqSlot()], { scope: 'image' }, [char(1, 'A', [outfit]), char(2, 'B', [{ ...outfit, id: 6 }]), char(3, 'C')])
    useCharacters.setState({ cursors: { 'var:1:5': 1 } })
    const { sent } = await pressWhileSecondIsSent(2, () => useCharacters.getState().resetCursors())
    expect(sent).toEqual(['char A, swimsuit', 'char B, uniform'])
    expect(useCharacters.getState().cursors).toEqual({})
  }, 20000)

  it('an overwrite backup restore', async () => {
    cast([seqSlot()], { scope: 'batch' })
    const backup = {
      characters: {
        folders: [],
        characters: [char(1, 'A'), char(2, 'B'), char(3, 'C')],
        slots: [seqSlot()],
        options: { ...DEFAULT_CAST_OPTIONS, scope: 'batch' },
        cursors: {}
      }
    } as unknown as Parameters<typeof normalizeBackupData>[0]
    const { seen } = await pressWhileSecondIsSent(3, () => {
      applyRestorePlan(planRestore({}, normalizeBackupData(backup), { mode: 'overwrite' }))
    })
    expect(seen).toEqual({ [`slot:${SLOT}`]: 1 })
    expect(useCharacters.getState().cursors).toEqual({})
    expect(await press(1)).toEqual(['char A'])
  }, 20000)

  it('a removed slot or a deleted character does not get its position back', async () => {
    const other: CastSlot = { ...seqSlot(), id: 78, candidates: [2, 3].map((id) => ({ kind: 'char' as const, id, weight: 1 })) }
    cast([seqSlot(), other], { scope: 'batch' }, [char(1, 'A', [outfit]), char(2, 'B'), char(3, 'C')])
    const { seen, sent } = await pressWhileSecondIsSent(3, () => {
      useCharacters.getState().removeSlot(78)
      useCharacters.getState().deleteCharacter(1)
    })
    expect(seen).toEqual({ [`slot:${SLOT}`]: 1, 'slot:78': 1, 'var:1:5': 1 })
    expect(sent).toEqual(['char A, uniform + char B', 'char A, uniform + char B', 'char A, uniform + char B'])
    expect(useCharacters.getState().cursors).toEqual({ [`slot:${SLOT}`]: 1 })
  }, 20000)

  it('a backup never carries or overwrites the reset counter of this device', () => {
    cast([seqSlot()], { scope: 'batch' })
    useCharacters.getState().resetCursors()
    const epoch = (useCharacters.getState() as unknown as { cursorEpoch: number }).cursorEpoch
    expect(collectStoreData().characters).not.toHaveProperty('cursorEpoch')
    const incoming = { characters: { folders: [], characters: [], slots: [], options: {}, cursorEpoch: epoch - 5 } }
    expect(normalizeBackupData(incoming).characters).not.toHaveProperty('cursorEpoch')
    applyRestorePlan(planRestore({}, normalizeBackupData(incoming), { mode: 'overwrite' }))
    // 순서 자리가 없는 백업이라 자리도 세대도 그대로
    expect((useCharacters.getState() as unknown as { cursorEpoch: number }).cursorEpoch).toBe(epoch)
  })
})

describe('a batch that produced no image does not use up a turn', () => {
  it('stopped while waiting before its first request', async () => {
    cast([seqSlot()], { scope: 'batch' })
    expect(await press(1)).toEqual(['char A'])
    // 요청 간격을 기다리는 사이에 멈춘다 — 아무것도 보내지 않았다
    useSettings.setState({ delayMin: 30, delayMax: 30 })
    usePrompt.setState({ count: 2 })
    const run = useGeneration.getState().start()
    await until(() => useGeneration.getState().phase === 'waiting')
    useGeneration.getState().stop()
    await run
    await idle()
    expect(calls).toHaveLength(1)
    useSettings.setState({ delayMin: 0, delayMax: 0 })
    expect(await press(1)).toEqual(['char B'])
  }, 20000)

  it('stopped while its first request was in flight', async () => {
    cast([seqSlot()], { scope: 'batch' })
    expect(await press(1)).toEqual(['char A'])
    hold = (signal) =>
      new Promise<void>((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))
    usePrompt.setState({ count: 2 })
    const run = useGeneration.getState().start()
    await until(() => calls.length === 2)
    useGeneration.getState().stop()
    await run
    await idle()
    hold = null
    expect(useHistory.getState().items).toHaveLength(1)
    // 멈춘 배치는 B를 받았지만 그림이 하나도 나오지 않았다 — 다음 배치가 B를 다시 쓴다
    expect(await press(1)).toEqual(['char B'])
  }, 20000)

  it('whose only request failed', async () => {
    cast([seqSlot()], { scope: 'batch' })
    expect(await press(1)).toEqual(['char A'])
    fail = () => new (NaiHttpError as unknown as new (status: number, message: string) => Error)(402, 'Anlas 부족')
    expect(await press(1)).toEqual(['char B'])
    fail = null
    expect(await press(1)).toEqual(['char B'])
    expect(await press(1)).toEqual(['char C'])
  }, 20000)
})

describe('resume keeps the batch turn and never advances it twice', () => {
  /** n번째 요청을 보낸 뒤 결과를 받기 전에 앱이 죽은 것처럼 저장소를 남긴다 */
  async function crashWhileSending(n: number, count: number): Promise<void> {
    const { driver, queue } = await getStorage()
    let saved: { load: Awaited<ReturnType<typeof queue.load>>; kv: { key: string; value: string }[] } | null = null
    hold = async (signal) => {
      if (calls.length < n) return
      saved = { load: await queue.load(), kv: await driver.query("SELECT key, value FROM app_kv WHERE key LIKE 'queue-draw:%'") }
      await new Promise<void>((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))
    }
    usePrompt.setState({ count })
    const run = useGeneration.getState().start()
    await until(() => saved !== null)
    useGeneration.getState().stop()
    await run
    await idle()
    hold = null
    // 앱이 죽었다면 남았을 기록을 되돌린다 (멈춤은 기록을 지운다)
    const { load, kv } = saved!
    for (const b of load.batches) await queue.saveBatch(b.id, b.label, b.data!)
    for (const r of load.items) {
      await queue.mark(r.batch_id, r.idx, r.state, r.req_id, {
        ...(r.image_id !== null ? { imageId: r.image_id } : {}),
        ...(r.seed !== null ? { seed: r.seed } : {})
      })
    }
    for (const r of kv) await driver.exec('INSERT OR REPLACE INTO app_kv (key, value) VALUES (?, ?)', [r.key, r.value])
    calls.length = 0
  }

  for (const withUncertain of [false, true]) {
    it(`after an image came back (${withUncertain ? 're-sending' : 'skipping'} the unconfirmed one)`, async () => {
      cast([seqSlot()], { scope: 'batch' })
      expect(await press(1)).toEqual(['char A'])
      // B 배치: 첫 장은 받았고 둘째 장을 보낸 채 죽었다
      await crashWhileSending(3, 3)
      expect(useCharacters.getState().cursors).toEqual({ [`slot:${SLOT}`]: 2 })
      const entries = await loadResume()
      expect(entries).toHaveLength(1)
      await useGeneration.getState().resume(entries, withUncertain)
      await idle()
      // 이어서 생성은 처음 돌 때의 B로 — 그사이 넘어간 자리(C)로 바꾸지 않는다
      expect(calls.map((c) => c.chars[0])).toEqual(withUncertain ? ['char B', 'char B'] : ['char B'])
      expect(useCharacters.getState().cursors).toEqual({ [`slot:${SLOT}`]: 2 })
      expect(await press(1)).toEqual(['char C'])
    }, 20000)

    it(`after a reset made once the first image came back, over an app restart (${withUncertain ? 're-sending' : 'skipping'} the unconfirmed one)`, async () => {
      cast([seqSlot()], { scope: 'batch' })
      // 처음 자리(A)에서 시작한 배치: 첫 장은 받아 자리가 1로 넘어갔고, 둘째 장을 보낸 채 죽었다
      await crashWhileSending(2, 3)
      expect(useCharacters.getState().cursors).toEqual({ [`slot:${SLOT}`]: 1 })
      useCharacters.getState().resetCursors()
      // 앱을 다시 연 것처럼 메모리를 잃은 뒤 저장된 것을 다시 읽는다
      const stored = disk.get('naip-characters') ?? '{}'
      useCharacters.setState({ cursors: { [`slot:${SLOT}`]: 1 }, cursorEpoch: 0 } as never)
      disk.set('naip-characters', stored)
      await useCharacters.persist.rehydrate()
      expect(useCharacters.getState().cursors).toEqual({})
      await useGeneration.getState().resume(await loadResume(), withUncertain)
      await idle()
      expect(calls.map((c) => c.chars[0])).toEqual(withUncertain ? ['char A', 'char A'] : ['char A'])
      // 이어서 생성한 장이 돌아와도 되돌린 자리를 다시 넘기지 않는다
      expect(useCharacters.getState().cursors).toEqual({})
      expect(await press(1)).toEqual(['char A'])
    }, 20000)

    it(`before any image came back (${withUncertain ? 're-sending' : 'skipping'} the unconfirmed one)`, async () => {
      cast([seqSlot()], { scope: 'batch' })
      await crashWhileSending(1, 3)
      expect(useCharacters.getState().cursors).toEqual({})
      await useGeneration.getState().resume(await loadResume(), withUncertain)
      await idle()
      expect(calls.map((c) => c.chars[0])).toEqual(withUncertain ? ['char A', 'char A', 'char A'] : ['char A', 'char A'])
      expect(useCharacters.getState().cursors).toEqual({ [`slot:${SLOT}`]: 1 })
      expect(await press(1)).toEqual(['char B'])
    }, 20000)
  }
})

describe('the saved position in the characters store and backups', () => {
  it('drops positions of removed slots and characters, and can be reset', () => {
    cast([seqSlot(), { ...seqSlot(), id: 78 }], { scope: 'batch' }, [char(1, 'A', [outfit]), char(2, 'B'), char(3, 'C')])
    useCharacters.setState({ cursors: { [`slot:${SLOT}`]: 2, 'slot:78': 1, 'var:1:5': 3, 'var:2:9': 1 } })
    useCharacters.getState().removeSlot(78)
    useCharacters.getState().deleteCharacter(1)
    expect(useCharacters.getState().cursors).toEqual({ [`slot:${SLOT}`]: 2, 'var:2:9': 1 })
    useCharacters.getState().resetCursors()
    expect(useCharacters.getState().cursors).toEqual({})
  })

  it('old data and backups without positions still load, and broken positions are ignored', async () => {
    const old = { folders: [], characters: [{ id: 1, name: 'A', prompt: 'a' }], slots: [], options: {} }
    expect(migrateCharacters(old)).not.toHaveProperty('cursors')
    expect(normalizeCharactersSection(old)).not.toHaveProperty('cursors')
    const withPos = { ...old, cursors: { 'slot:7': 2, 'var:1:5': 1.9, 'slot:8': -1, 'slot:9': 'x', junk: 3 } }
    expect(migrateCharacters(withPos).cursors).toEqual({ 'slot:7': 2, 'var:1:5': 1 })
    expect(normalizeCharactersSection(withPos).cursors).toEqual({ 'slot:7': 2, 'var:1:5': 1 })
    expect(normalizeCharactersSection({ ...old, cursors: 'broken' })).not.toHaveProperty('cursors')
    // 저장된 자리가 깨져 있어도 생성은 처음부터 돈다
    cast([seqSlot()], { scope: 'batch' })
    useCharacters.setState({ cursors: { [`slot:${SLOT}`]: Number.NaN } })
    expect(await press(1)).toEqual(['char A'])
    expect(useCharacters.getState().cursors).toEqual({ [`slot:${SLOT}`]: 1 })
  }, 20000)
})
