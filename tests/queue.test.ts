import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 네트워크·캔버스는 흉내 낸다 — 실제 NovelAI API는 부르지 않는다
const calls: { seed: number; prompt: string }[] = []
vi.mock('../src/nai/client', () => {
  class NaiHttpError extends Error {
    status = 0
    retryAfterMs?: number
  }
  return {
    NaiHttpError,
    fetchSubscription: vi.fn(async () => {
      throw new Error('offline')
    }),
    encodeVibe: vi.fn(),
    generateImageStream: vi.fn(),
    generateImage: vi.fn(async (_token: string, request: { seed: number; prompt: string }) => {
      calls.push({ seed: request.seed, prompt: request.prompt })
      return {
        image: new Blob([new Uint8Array(64)], { type: 'image/png' }),
        payload: { input: request.prompt, parameters: { negative_prompt: '' } },
        stats: { waitMs: 1, downloadMs: 1, sentBytes: 1, receivedBytes: 1 }
      }
    })
  }
})
vi.mock('../src/lib/image', () => ({
  makeThumb: async () => 'data:image/jpeg;base64,AAAA',
  normalizeInpaintMask: async () => null,
  processCharRefImage: async () => '',
  processCharRefImageV5: async () => '',
  resizeToPngBase64: async () => '',
  blobToBase64: async () => '',
  loadImage: async () => ({ naturalWidth: 1, naturalHeight: 1 })
}))

import { setStorageForTests } from '../src/storage'
import { createSqlJsDriver } from '../src/storage/sqljs'
import { memoryFileStore } from '../src/storage/files'
import type { QueueBatchRow, QueueItemRow } from '../src/storage/queue-repo'
import { fragmentSourceFrom } from '../src/stores/fragments'
import type { Batch } from '../src/stores/generation'
import { useGeneration } from '../src/stores/generation'
import { useHistory } from '../src/stores/history'
import { deserializeBatch, discardResume, loadResume, newRequestId, planResume, serializeBatch } from '../src/stores/queue-persist'
import { useScenes } from '../src/stores/scenes'
import { useSettings } from '../src/stores/settings'

function batch(id: number, n: number, patch: Partial<Batch> = {}): Batch {
  const fragmentLib = { folders: [], fragments: [{ id: 1, name: 'hair', folderId: null, content: 'black hair' }] }
  return {
    id,
    label: `메인 프롬프트 · ${n}장`,
    base: {
      prompt: '1girl, <hair>',
      negativePrompt: 'lowres',
      model: 'nai-diffusion-4-5-full',
      width: 832,
      height: 1216,
      steps: 28,
      cfgScale: 5,
      cfgRescale: 0,
      sampler: 'k_euler_ancestral',
      noiseSchedule: 'karras',
      seed: 0,
      variety: false,
      qualityToggle: true,
      ucPreset: 0,
      characterPrompts: [],
      useCoords: false
    },
    snap: { base: '1girl', additional: '', detail: '', negative: 'lowres', params: {}, chars: [] },
    fixedSeed: 100,
    source: { image: null, mask: null, strength: 0.7, noise: 0, originId: null },
    vibes: [],
    charRefs: [],
    fragmentLib,
    fragments: fragmentSourceFrom(fragmentLib),
    plan: Array.from({ length: n }, (_, i) => ({ offset: i })),
    verbatim: false,
    cast: null,
    ...patch
  }
}

const row = (b: Batch): QueueBatchRow => ({ id: b.id, label: b.label, data: serializeBatch(b), created: 0 })
const item = (batchId: number, idx: number, state: QueueItemRow['state'], reqId = `r${idx}`): QueueItemRow => ({
  batch_id: batchId,
  idx,
  state,
  req_id: reqId,
  image_id: null,
  seed: 100 + idx,
  updated: 0
})

describe('batch snapshot serialization', () => {
  it('drops the fragment closure, keeps every other field and rebuilds the source', () => {
    const b = { ...batch(1, 2), futureField: { nested: [1, 2] } } as Batch & { futureField: unknown }
    const json = serializeBatch(b)
    expect(JSON.parse(json)).not.toHaveProperty('fragments')
    const back = deserializeBatch(json) as Batch & { futureField: unknown }
    expect(back.futureField).toEqual({ nested: [1, 2] })
    expect(back.fragments.getLines('hair')).toEqual(['black hair'])
    expect(back.plan).toEqual(b.plan)
  })

  it('makes a unique id per request', () => {
    const ids = new Set(Array.from({ length: 200 }, newRequestId))
    expect(ids.size).toBe(200)
  })
})

describe('resume rules', () => {
  it('never resends an in-flight item automatically', () => {
    const b = batch(10, 5)
    const { entries } = planResume([row(b)], [item(10, 0, 'done'), item(10, 1, 'failed'), item(10, 2, 'sending')], new Map())
    expect(entries).toHaveLength(1)
    const e = entries[0]
    expect(e.done).toBe(1)
    expect(e.failed).toBe(1)
    expect(e.remaining.map((p) => p.key)).toEqual([3, 4])
    expect(e.uncertain.map((u) => u.key)).toEqual([2])
    expect(e.uncertain[0].seed).toBe(102)
  })

  it('treats an in-flight item as done when its request id is already in history', () => {
    const b = batch(11, 3)
    const { entries, resolved } = planResume([row(b)], [item(11, 0, 'sending', 'abc')], new Map([['abc', 999]]))
    expect(entries[0].uncertain).toEqual([])
    expect(entries[0].done).toBe(1)
    expect(resolved).toEqual([{ batchId: 11, idx: 0, reqId: 'abc', imageId: 999 }])
  })

  it('drops finished or unreadable batches', () => {
    const done = batch(12, 2)
    const broken: QueueBatchRow = { id: 13, label: 'x', data: '{not json', created: 0 }
    const missing: QueueBatchRow = { id: 14, label: 'y', data: null, created: 0 }
    const { entries, dropped } = planResume(
      [row(done), broken, missing],
      [item(12, 0, 'done'), item(12, 1, 'skipped')],
      new Map()
    )
    expect(entries).toEqual([])
    expect(dropped.sort()).toEqual([12, 13, 14])
  })
})

describe('persisted queue + generation store', () => {
  beforeEach(async () => {
    calls.length = 0
    await setStorageForTests(await createSqlJsDriver(), memoryFileStore())
    useSettings.setState({ token: 'pst-test', autoSave: false, background: false, keepAwake: false, vibrate: false, streaming: false, historyLimit: 0 })
    useScenes.setState({ scenes: [], folders: [] })
    await useHistory.getState().init()
  })

  it('resumes only unsent items, asks before resending in-flight ones, and clears the record', async () => {
    const { getStorage } = await import('../src/storage')
    const { queue } = await getStorage()
    const b = batch(20, 4)
    await queue.saveBatch(b.id, b.label, serializeBatch(b))
    await queue.mark(20, 0, 'done', 'r0', { imageId: 1 })
    await queue.mark(20, 1, 'sending', 'r1', { seed: 101 })
    const entries = await loadResume()
    expect(entries).toHaveLength(1)
    expect(entries[0].remaining.map((p) => p.key)).toEqual([2, 3])
    expect(entries[0].uncertain.map((u) => u.key)).toEqual([1])

    await useGeneration.getState().resume(entries, false)
    // 보내지 않은 두 장만, 고정 시드는 원래 위치대로 (100 + offset)
    expect(calls.map((c) => c.seed)).toEqual([102, 103])
    expect(calls[0].prompt).toContain('black hair')
    const items = useHistory.getState().items
    expect(items).toHaveLength(2)
    expect(items.every((m) => typeof m.requestId === 'string' && m.requestId.length > 8)).toBe(true)
    expect(new Set(items.map((m) => m.requestId)).size).toBe(2)
    // 다 돌았으면 기록이 지워져 다음 실행에서 다시 묻지 않는다
    expect(await loadResume()).toEqual([])
  }, 20000)

  it('resends in-flight items only when the user chose to', async () => {
    const { getStorage } = await import('../src/storage')
    const { queue } = await getStorage()
    const b = batch(21, 2)
    await queue.saveBatch(b.id, b.label, serializeBatch(b))
    await queue.mark(21, 0, 'sending', 'lost', { seed: 100 })
    const entries = await loadResume()
    await useGeneration.getState().resume(entries, true)
    expect(calls.map((c) => c.seed)).toEqual([100, 101])
  }, 20000)

  it('records sending before the request and done after the image is saved', async () => {
    const { getStorage } = await import('../src/storage')
    const s = await getStorage()
    const seen: string[] = []
    const { generateImage } = await import('../src/nai/client')
    vi.mocked(generateImage).mockImplementationOnce(async (_t, request) => {
      const rows = await s.driver.query<{ state: string; req_id: string }>('SELECT state, req_id FROM queue_items')
      seen.push(...rows.map((r) => r.state))
      return {
        image: new Blob([new Uint8Array(8)], { type: 'image/png' }),
        payload: { input: request.prompt, parameters: {} },
        stats: { waitMs: 1, downloadMs: 1, sentBytes: 1, receivedBytes: 1 }
      } as never
    })
    useSettings.setState({ delayMin: 1, delayMax: 1 })
    const { usePrompt } = await import('../src/stores/prompt')
    usePrompt.setState({ count: 1 })
    await useGeneration.getState().start()
    expect(seen).toEqual(['sending'])
    // 끝난 배치는 기록에서 지워진다
    await new Promise((r) => setTimeout(r, 20))
    expect(await s.driver.query('SELECT * FROM queue_batches')).toEqual([])
    expect(await s.driver.query('SELECT * FROM queue_items')).toEqual([])
  }, 20000)

  it('forgets progress rows whose batch was never written', async () => {
    const { getStorage } = await import('../src/storage')
    const s = await getStorage()
    await s.queue.mark(99, 0, 'sending', 'orphan')
    expect(await loadResume()).toEqual([])
    expect(await s.driver.query('SELECT * FROM queue_items')).toEqual([])
  })

  it('discarding returns unsent scene items to the reserve but not in-flight ones', async () => {
    useScenes.setState({
      scenes: [{ id: 7, name: '바다', folderId: null, prompt: 'sea', negative: '', size: null, reserve: 0 }],
      folders: []
    })
    const { getStorage } = await import('../src/storage')
    const { queue } = await getStorage()
    const scene = { id: 7, name: '바다', prompt: 'sea', negative: '', reserved: true }
    const b = batch(22, 3, { plan: [0, 1, 2].map((i) => ({ offset: i, scene })) })
    await queue.saveBatch(b.id, b.label, serializeBatch(b))
    await queue.mark(22, 0, 'sending', 'x')
    const entries = await loadResume()
    await discardResume(entries)
    expect(useScenes.getState().scenes[0].reserve).toBe(2)
    expect(await loadResume()).toEqual([])
  })
})
