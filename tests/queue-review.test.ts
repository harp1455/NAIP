/**
 * 생성 대기열 · 저장/이어서 생성 · 프로젝트 연결의 검토 지적 회귀 테스트.
 * 네트워크는 흉내 낸다 — 실제 NovelAI API는 부르지 않는다.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Sent {
  seed: number
  prompt: string
  width: number
  chars: string[]
  at: number
}
const calls: Sent[] = []
let hold: ((request: { prompt: string }, signal?: AbortSignal) => Promise<void>) | null = null
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
    generateImage: vi.fn(
      async (
        _token: string,
        request: { seed: number; prompt: string; width: number; characterPrompts: { prompt: string }[] },
        _opts: unknown,
        signal?: AbortSignal
      ) => {
        calls.push({
          seed: request.seed,
          prompt: request.prompt,
          width: request.width,
          chars: request.characterPrompts.map((c) => c.prompt),
          at: performance.now()
        })
        if (hold) await hold(request, signal)
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
import { memoryFileStore, type FileStore } from '../src/storage/files'
import { useGeneration, type Batch } from '../src/stores/generation'
import { useHistory } from '../src/stores/history'
import { discardResume, loadResume, serializeBatch } from '../src/stores/queue-persist'
import { useSettings } from '../src/stores/settings'
import { useCharacters } from '../src/stores/characters'
import { fragmentSourceFrom } from '../src/stores/fragments'
import { planJobs, useProjects, type Project } from '../src/project'
import { jobsToBatches } from '../src/project/batches'
import { releaseProjectItems } from '../src/project/queue'
import { enqueueCombo, enqueueJobs, inFlightFor } from '../src/project/run'
import type { HistoryMeta } from '../src/lib/db'

/** 캐릭터 2 × 표정 2 × 의상 1 */
function makeProject(name = '봄', style = 'artist:foo'): string {
  const s = useProjects.getState()
  const id = s.create(name)
  s.patch(id, { stylePrompt: style, negative: 'lowres', defaults: { count: 1, target: 1 } })
  s.addCharacter(id, { name: '민지', libraryId: 501, prompt: 'solo' })
  s.addCharacter(id, { name: '하늘', libraryId: null, prompt: 'boy' })
  const e = s.addAxis(id, 'expression')!
  s.addValue(id, e, { label: '웃음', prompt: 'smile' })
  s.addValue(id, e, { label: '울음', prompt: 'crying' })
  const o = s.addAxis(id, 'outfit')!
  s.addValue(id, o, { label: '교복', prompt: 'school uniform' })
  return id
}
const project = (id: string): Project => useProjects.getState().projects.find((p) => p.id === id)!
const counts = (id: string) =>
  Object.values(project(id).items).reduce(
    (a, i) => ({ queued: a.queued + i.queued, generating: a.generating + i.generating, images: a.images + i.images.length }),
    { queued: 0, generating: 0, images: 0 }
  )
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 500 && !cond(); i++) await sleep(5)
  expect(cond()).toBe(true)
}
const idle = async (): Promise<void> => {
  await sleep(0)
  for (let i = 0; i < 500 && useGeneration.getState().running; i++) await sleep(10)
  expect(useGeneration.getState().running).toBe(false)
}
const ctx = () => {
  const lib = { folders: [], fragments: [] }
  return { library: useCharacters.getState().characters, vibes: [], charRefs: [], fragmentLib: lib, fragments: fragmentSourceFrom(lib) }
}
/** 배치 내용 쓰기가 느린 저장소 (휴대폰에서 수 MB 배치를 base64로 바꿔 쓰는 시간) */
function slowFiles(ms: number): FileStore {
  const base = memoryFileStore()
  return {
    ...base,
    write: async (path, data) => {
      await sleep(ms)
      return base.write(path, data)
    }
  }
}
const png = (): Blob => new Blob([new Uint8Array(4)], { type: 'image/png' })
const meta = (id: number, patch: Partial<HistoryMeta> = {}): HistoryMeta => ({
  id,
  ts: id,
  thumb: '',
  width: 832,
  height: 1216,
  seed: 1,
  model: 'nai-diffusion-4-5-full',
  kind: 't2i',
  prompt: 'p',
  negative: '',
  mime: 'image/png',
  ...patch
})

async function reset(files: FileStore = memoryFileStore()): Promise<void> {
  calls.length = 0
  hold = null
  await setStorageForTests(await createSqlJsDriver(), files)
  useSettings.setState({ token: 'pst-test', autoSave: false, background: false, keepAwake: false, vibrate: false, streaming: false, historyLimit: 0, delayMin: 0, delayMax: 0 })
  useCharacters.setState({
    characters: [{ id: 501, name: '민지', folderId: null, base: 'girl, black hair', additional: '', detail: '', negative: '', variations: [] }]
  })
  useProjects.setState({ projects: [], activeId: null })
  await useHistory.getState().init()
}

/** 첫 요청을 멈춰 두는 문 (열거나 중지로 풀린다) */
function gate(): { open: () => void } {
  let open!: () => void
  const opened = new Promise<void>((r) => (open = r))
  hold = (_req, signal) =>
    new Promise<void>((resolve, reject) => {
      void opened.then(resolve)
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })
  return { open }
}

beforeEach(async () => {
  await reset()
})

describe('batch ids', () => {
  it('every project enqueue gets ids that never collide, so cancelling one removes only that one', async () => {
    const a = makeProject('A')
    const b = makeProject('B', 'artist:b')
    const c = makeProject('C', 'artist:c')
    const g = gate()
    enqueueJobs(project(a), planJobs(project(a), 'all').jobs.filter((j) => j.character?.name === '민지'))
    await until(() => calls.length === 1)
    enqueueJobs(project(b), planJobs(project(b), 'all').jobs.filter((j) => j.character?.name === '민지'))
    enqueueJobs(project(c), planJobs(project(c), 'all').jobs.filter((j) => j.character?.name === '민지'))
    await until(() => useGeneration.getState().queue.length === 2)
    const [qb, qc] = useGeneration.getState().queue
    expect(qb.id).not.toBe(qc.id)
    // C를 대기열에서 빼면 C만 빠지고 B는 남는다
    useGeneration.getState().removeQueued(qc.id)
    expect(useGeneration.getState().queue.map((q) => q.label)).toEqual([qb.label])
    expect(counts(c)).toMatchObject({ queued: 0, generating: 0 })
    expect(counts(b).queued).toBe(2)
    // 저장된 대기열: 돌고 있는 A와 대기 중인 B가 각각 남는다 (서로 덮어쓰지 않는다)
    await sleep(20)
    const { driver } = await getStorage()
    const rows = await driver.query<{ label: string }>('SELECT label FROM queue_batches ORDER BY id')
    expect(rows.map((r) => r.label)).toEqual([expect.stringContaining('A ·'), expect.stringContaining('B ·')])
    g.open()
    await idle()
    expect(calls.map((x) => x.prompt)).toEqual(['artist:foo', 'artist:foo', 'artist:b', 'artist:b'])
  }, 20000)
})

describe('persisted queue races', () => {
  it('removing a queued batch while its save is still being written leaves nothing to resume', async () => {
    await reset(slowFiles(40))
    const a = makeProject('A')
    const b = makeProject('B', 'artist:b')
    const g = gate()
    enqueueJobs(project(a), planJobs(project(a), 'all').jobs.slice(0, 1))
    await until(() => calls.length === 1)
    // B가 대기열에 들어가는 순간(배치 쓰기가 아직 끝나지 않았다) 바로 뺀다
    const unsub = useGeneration.subscribe((s) => {
      if (s.queue.length === 1) {
        unsub()
        s.removeQueued(s.queue[0].id)
      }
    })
    enqueueJobs(project(b), planJobs(project(b), 'all').jobs.slice(0, 1))
    await until(() => counts(b).queued === 0)
    await sleep(150)
    const { driver } = await getStorage()
    const labels = (await driver.query<{ label: string }>('SELECT label FROM queue_batches')).map((r) => r.label)
    expect(labels.some((l) => l.startsWith('B '))).toBe(false)
    g.open()
    await idle()
    // 다음 실행에서도 취소한 배치를 이어서 생성하자고 하지 않는다
    expect(await loadResume()).toEqual([])
    expect(calls.map((x) => x.prompt)).toEqual(['artist:foo'])
  }, 20000)

  it('reading the saved queue while a batch is running never offers that batch for resume', async () => {
    const a = makeProject('A')
    const g = gate()
    enqueueJobs(project(a), planJobs(project(a), 'all').jobs.filter((j) => j.character?.name === '민지'))
    await until(() => calls.length === 1)
    // 앱을 연 뒤 저장소 준비가 늦게 끝나 loadResume이 생성 중에 돈 경우
    expect(await loadResume()).toEqual([])
    // 돌고 있는 배치의 "보냄" 기록도 지우지 않는다
    const { driver } = await getStorage()
    expect(await driver.query<{ state: string }>('SELECT state FROM queue_items')).toEqual([expect.objectContaining({ state: 'sending' })])
    g.open()
    await idle()
    expect(calls).toHaveLength(2)
  }, 20000)
})

describe('delay between requests', () => {
  it('waits the configured interval before the first request of the next queued batch', async () => {
    useSettings.setState({ delayMin: 0.25, delayMax: 0.25 })
    const a = makeProject('A')
    // 캐릭터마다 배치 하나: 민지 2장 → 하늘 2장
    const r = enqueueJobs(project(a), planJobs(project(a), 'all').jobs)
    expect(r).toMatchObject({ batches: 2, images: 4 })
    await idle()
    expect(calls).toHaveLength(4)
    const gaps = calls.slice(1).map((c, i) => c.at - calls[i].at)
    // 배치 안(0→1, 2→3)과 배치 사이(1→2) 모두 설정한 간격 이상
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(240)
  }, 20000)
})

describe('history limit pruning', () => {
  it('never prunes images a project still uses (adopted, hold, unreviewed, exported)', async () => {
    const id = makeProject()
    const key = planJobs(project(id), 'all').jobs[0].key
    const h = useHistory.getState()
    for (const n of [1, 2, 3, 4]) await h.add(meta(n), png())
    const s = useProjects.getState()
    for (const n of [1, 2, 3]) s.addImage(id, key, { id: n, ts: n }, { fromQueue: false })
    s.setMarks(id, key, [1], 'adopted')
    s.setMarks(id, key, [2], 'rejected')
    // 3은 미선별, 4는 프로젝트 밖
    useSettings.setState({ historyLimit: 3 })
    await useHistory.getState().add(meta(5), png())
    await useHistory.getState().add(meta(6), png())
    const { history } = await getStorage()
    const left = (await history.list({}, 50)).map((m) => m.id).sort((x, y) => x - y)
    // 넘친 3장은 탈락(2)·프로젝트 밖(4)·그다음(5)에서 지운다 — 채택(1)·미선별(3)은 남는다
    expect(left).toEqual([1, 3, 6])
    expect(project(id).items[key].images.map((i) => i.id).sort()).toEqual([1, 3])
  }, 20000)
})

describe('double taps', () => {
  it('a quick second "이 조합 더 생성" tap does not queue (and pay for) the same images again', async () => {
    const id = makeProject()
    const key = planJobs(project(id), 'all').jobs[0].key
    const first = enqueueCombo(project(id), key, 3)
    const second = enqueueCombo(project(id), key, 3)
    expect(first).toMatchObject({ images: 3 })
    expect(typeof second).toBe('string')
    await idle()
    expect(calls).toHaveLength(3)
    expect(counts(id)).toEqual({ queued: 0, generating: 0, images: 3 })
  }, 20000)

  it('counts the images already queued for a plan (the plan sheet asks before adding them again)', () => {
    const id = makeProject()
    const jobs = planJobs(project(id), 'all').jobs
    expect(inFlightFor(project(id), jobs)).toBe(0)
    useProjects.getState().markQueued(id, [{ key: jobs[0].key, count: 2 }])
    useProjects.getState().markStarted(id, jobs[1].key)
    expect(inFlightFor(project(id), jobs)).toBe(3)
  })
})

describe('resume keeps project counts', () => {
  async function savedBatch(id: string) {
    const jobs = planJobs(project(id), 'all').jobs.filter((j) => j.character?.name === '민지')
    const [b] = jobsToBatches(project(id).name, jobs.map((j) => ({ ...j, count: 2 })), { ...ctx(), newId: () => 55 }).batches
    const { queue } = await getStorage()
    await queue.saveBatch(b.id, b.label, serializeBatch(b))
    await queue.mark(55, 0, 'done', 'r0', { imageId: 1 })
    return b
  }

  it('counts unsent project images as queued as soon as the saved queue is read, so "missing" does not plan them again', async () => {
    const id = makeProject()
    await savedBatch(id)
    expect(counts(id).queued).toBe(0) // 앱을 다시 연 상태
    const entries = await loadResume()
    expect(entries[0].remaining).toHaveLength(3)
    expect(counts(id).queued).toBe(3)
    // 이어서 생성 시트를 닫고 "부족분만"을 짜도 저장된 대기열의 장은 다시 넣지 않는다
    const missing = planJobs(project(id), 'missing').jobs.filter((j) => j.character?.name === '민지')
    expect(missing).toEqual([])
    // 버리면 돌려준다
    await discardResume(entries)
    expect(counts(id).queued).toBe(0)
  }, 20000)

  it('resuming does not count the same images twice', async () => {
    const id = makeProject()
    await savedBatch(id)
    const entries = await loadResume()
    let seen = -1
    hold = async () => {
      if (seen < 0) seen = counts(id).queued + counts(id).generating
    }
    await useGeneration.getState().resume(entries, false)
    await idle()
    expect(seen).toBe(3)
    expect(counts(id)).toEqual({ queued: 0, generating: 0, images: 3 })
  }, 20000)
})

describe('releasing a large plan', () => {
  it('writes each project once, not once per image', () => {
    const id = makeProject()
    const jobs = planJobs(project(id), 'all').jobs
    const { batches } = jobsToBatches(project(id).name, jobs.map((j) => ({ ...j, count: 50 })), ctx())
    const items = batches.flatMap((b) => b.plan)
    useProjects.getState().markQueued(id, jobs.map((j) => ({ key: j.key, count: 50 })))
    let writes = 0
    const unsub = useProjects.subscribe(() => writes++)
    releaseProjectItems(items)
    unsub()
    expect(writes).toBe(1)
    expect(counts(id)).toMatchObject({ queued: 0, generating: 0 })
  })
})

describe('deleting a project with queued work', () => {
  it('cancels only that project’s batches; other queued batches keep running', async () => {
    const x = makeProject('X', 'artist:x')
    const y = makeProject('Y', 'artist:y')
    // X의 요청은 멈춰 둔다 (중지로만 풀린다)
    hold = (req, signal) =>
      req.prompt === 'artist:x'
        ? new Promise<void>((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))
        : Promise.resolve()
    enqueueJobs(project(x), planJobs(project(x), 'all').jobs) // X: 배치 2개 (민지 · 하늘)
    await until(() => calls.length === 1)
    enqueueJobs(project(y), planJobs(project(y), 'all').jobs.filter((j) => j.character?.name === '하늘'))
    await until(() => useGeneration.getState().queue.length === 2)
    useGeneration.getState().cancelProject(x)
    expect(useGeneration.getState().queue.map((q) => q.label)).toEqual([expect.stringContaining('Y ·')])
    await idle()
    expect(calls.map((c) => c.prompt)).toEqual(['artist:x', 'artist:y', 'artist:y'])
    expect(counts(x)).toEqual({ queued: 0, generating: 0, images: 0 })
    expect(counts(y)).toEqual({ queued: 0, generating: 0, images: 2 })
  }, 20000)
})

describe('project images in history', () => {
  it('records each image’s own size in its settings snapshot when one batch mixes sizes', async () => {
    const id = makeProject()
    const jobs = planJobs(project(id), 'all').jobs.filter((j) => j.character?.name === '민지')
    const mixed = [jobs[0], { ...jobs[1], width: 1024, height: 1536 }]
    const { batches } = jobsToBatches(project(id).name, mixed, ctx())
    expect(batches).toHaveLength(1)
    await useGeneration.getState().enqueueBatches(batches)
    await idle()
    const items = useHistory.getState().items
    expect(items.map((m) => m.width).sort()).toEqual([1024, 832])
    for (const m of items) {
      expect(m.snap?.params).toMatchObject({ width: m.width, height: m.height })
    }
  }, 20000)

  it('puts back tagged images whose project record was lost when the app died, even with no queue rows', async () => {
    const id = makeProject()
    const key = planJobs(project(id), 'all').jobs[0].key
    const { history } = await getStorage()
    // 히스토리에는 분류 표시와 함께 저장됐는데 프로젝트 기록(localStorage)은 디스크에 닿기 전에 앱이 죽었다
    const late = Date.now() + 1000
    await history.add(meta(late, { project: { projectId: id, key, coords: {} } }), png())
    await history.add(meta(late + 1), png())
    expect(await loadResume()).toEqual([])
    expect(project(id).items[key].images.map((i) => i.id)).toEqual([late])
  }, 20000)
})

describe('resume continues the batch draws', () => {
  /** 순차 조각 aa → dd, 순차 슬롯 A → D, 4장 */
  function seqBatch(): Batch {
    const fragmentLib = { folders: [], fragments: [{ id: 1, name: 'seq', folderId: null, content: 'aa\nbb\ncc\ndd' }] }
    const characters = ['A', 'B', 'C', 'D'].map((name, i) => ({
      id: 10 + i,
      name,
      folderId: null,
      base: `char ${name}`,
      additional: '',
      detail: '',
      negative: '',
      variations: []
    }))
    return {
      id: 4242,
      label: '순차 · 4장',
      base: {
        prompt: '1girl, <*seq>',
        negativePrompt: '',
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
      snap: { base: '1girl', additional: '', detail: '', negative: '', params: {}, chars: [] },
      fixedSeed: null,
      source: { image: null, mask: null, strength: 0.7, noise: 0, originId: null },
      vibes: [],
      charRefs: [],
      fragmentLib,
      fragments: fragmentSourceFrom(fragmentLib),
      plan: [0, 1, 2, 3].map((offset) => ({ offset })),
      verbatim: false,
      cast: {
        slots: [
          {
            id: 1,
            enabled: true,
            mode: 'sequential',
            charId: null,
            candidates: characters.map((c) => ({ kind: 'char' as const, id: c.id, weight: 1 })),
            chance: 100,
            wrap: false,
            center: null
          }
        ],
        options: { allowDuplicates: false, scope: 'image', perScene: false, autoCountTags: false },
        characters
      }
    }
  }

  /** 3번째 장(key 2)을 보낸 뒤 결과를 받기 전에 앱이 죽은 것처럼 저장소를 남긴다 */
  async function crashWhileSendingThird(): Promise<void> {
    const { driver, queue } = await getStorage()
    let saved: { items: Record<string, unknown>[]; kv: Record<string, unknown>[] } | null = null
    hold = async (_req, signal) => {
      if (calls.length < 3) return
      saved = {
        items: await driver.query('SELECT * FROM queue_items'),
        kv: await driver.query("SELECT * FROM app_kv WHERE key LIKE 'queue-draw:%'")
      }
      await new Promise<void>((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))
    }
    const run = useGeneration.getState().enqueueBatches([seqBatch()])
    await until(() => saved !== null)
    useGeneration.getState().stop()
    await run
    await idle()
    expect(calls.map((c) => c.prompt)).toEqual(['1girl, aa', '1girl, bb', '1girl, cc'])
    expect(calls.map((c) => c.chars[0])).toEqual(['char A', 'char B', 'char C'])
    // 앱이 죽었다면 남았을 기록을 되돌린다 (멈춤은 기록을 지운다)
    const b = seqBatch()
    await queue.saveBatch(b.id, b.label, serializeBatch(b))
    for (const r of saved!.items) {
      await queue.mark(b.id, Number(r.idx), r.state as 'done', String(r.req_id), {
        ...(r.image_id !== null ? { imageId: Number(r.image_id) } : {}),
        ...(r.seed !== null ? { seed: Number(r.seed) } : {})
      })
    }
    for (const r of saved!.kv) await driver.exec('INSERT OR REPLACE INTO app_kv (key, value) VALUES (?, ?)', [String(r.key), String(r.value)])
    calls.length = 0
    hold = null
  }

  it('continues sequential fragments and slots after the unsent items, not from the start', async () => {
    await crashWhileSendingThird()
    const entries = await loadResume()
    expect(entries[0].remaining.map((p) => p.key)).toEqual([3])
    expect(entries[0].uncertain.map((u) => u.key)).toEqual([2])
    await useGeneration.getState().resume(entries, false)
    await idle()
    expect(calls.map((c) => c.prompt)).toEqual(['1girl, dd'])
    expect(calls.map((c) => c.chars[0])).toEqual(['char D'])
  }, 20000)

  it('re-sends an unconfirmed item with the same draw it had', async () => {
    await crashWhileSendingThird()
    await useGeneration.getState().resume(await loadResume(), true)
    await idle()
    expect(calls.map((c) => c.prompt)).toEqual(['1girl, cc', '1girl, dd'])
    expect(calls.map((c) => c.chars[0])).toEqual(['char C', 'char D'])
  }, 20000)
})
