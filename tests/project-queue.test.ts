import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 네트워크·캔버스는 흉내 낸다 — 실제 NovelAI API는 부르지 않는다
const calls: { seed: number; prompt: string; chars: string[]; width: number }[] = []
let hold: ((signal?: AbortSignal) => Promise<void>) | null = null
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
        calls.push({ seed: request.seed, prompt: request.prompt, width: request.width, chars: request.characterPrompts.map((c) => c.prompt) })
        if (hold) await hold(signal)
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

import { setStorageForTests, getStorage } from '../src/storage'
import { createSqlJsDriver } from '../src/storage/sqljs'
import { memoryFileStore } from '../src/storage/files'
import { createHistoryRepo } from '../src/storage/history-repo'
import { useGeneration } from '../src/stores/generation'
import { useHistory } from '../src/stores/history'
import { loadResume, serializeBatch } from '../src/stores/queue-persist'
import { useSettings } from '../src/stores/settings'
import { useCharacters } from '../src/stores/characters'
import { expandMatrix, planJobs, useProjects, type Project } from '../src/project'
import { jobsToBatches } from '../src/project/batches'
import { enqueueJobs } from '../src/project/run'
import { fragmentSourceFrom } from '../src/stores/fragments'
import type { HistoryMeta } from '../src/lib/db'

/** 캐릭터 2 × 표정 2 × 의상 1 — 화면에서 만드는 것과 같은 저장소 동작으로 */
function makeProject(): string {
  const s = useProjects.getState()
  const id = s.create('봄')
  s.patch(id, { stylePrompt: 'artist:foo', negative: 'lowres', defaults: { count: 2, target: 1 } })
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
    (a, i) => ({ queued: a.queued + i.queued, generating: a.generating + i.generating, failed: a.failed + i.failed, images: a.images + i.images.length }),
    { queued: 0, generating: 0, failed: 0, images: 0 }
  )
const idle = async (): Promise<void> => {
  for (let i = 0; i < 400 && useGeneration.getState().running; i++) await new Promise((r) => setTimeout(r, 10))
}

beforeEach(async () => {
  calls.length = 0
  hold = null
  await setStorageForTests(await createSqlJsDriver(), memoryFileStore())
  useSettings.setState({ token: 'pst-test', autoSave: false, background: false, keepAwake: false, vibrate: false, streaming: false, historyLimit: 0, delayMin: 0, delayMax: 0 })
  useCharacters.setState({
    characters: [{ id: 501, name: '민지', folderId: null, base: 'girl, black hair', additional: '', detail: '', negative: '', variations: [] }]
  })
  useProjects.setState({ projects: [], activeId: null })
  await useHistory.getState().init()
})

describe('project runs through the generation queue', () => {
  it('sends one request per image with the project prompt and tags every result', async () => {
    const id = makeProject()
    const plan = planJobs(project(id), 'all')
    const r = enqueueJobs(project(id), plan.jobs)
    expect(r).toMatchObject({ batches: 2, images: 8 })
    expect(counts(id).queued + counts(id).generating).toBeGreaterThan(0)
    await new Promise((res) => setTimeout(res, 0))
    await idle()
    expect(calls).toHaveLength(8)
    expect(calls.every((c) => c.prompt === 'artist:foo')).toBe(true)
    expect(calls.slice(0, 4).every((c) => c.chars[0].startsWith('girl, black hair, solo, '))).toBe(true)
    expect(calls.slice(4).every((c) => c.chars[0].startsWith('boy, '))).toBe(true)
    expect(counts(id)).toEqual({ queued: 0, generating: 0, failed: 0, images: 8 })
    const items = useHistory.getState().items
    expect(items).toHaveLength(8)
    expect(items.every((m) => m.project?.projectId === id)).toBe(true)
    // 히스토리를 지우면 프로젝트에서도 빠진다
    await useHistory.getState().remove([items[0].id])
    expect(counts(id).images).toBe(7)
    // missing: 채택이 없으니 조합마다 1장 (perMissing 1)
    expect(planJobs(project(id), 'missing').jobs.reduce((n, j) => n + j.count, 0)).toBe(4)
  }, 20000)

  it('two quick enqueues never run two batches at once', async () => {
    const id = makeProject()
    let inFlight = 0
    let peak = 0
    hold = async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
    }
    const jobs = planJobs(project(id), 'all').jobs
    enqueueJobs(project(id), jobs.slice(0, 2))
    enqueueJobs(project(id), jobs.slice(2))
    await new Promise((res) => setTimeout(res, 0))
    await idle()
    expect(calls).toHaveLength(8)
    expect(peak).toBe(1)
    expect(counts(id)).toEqual({ queued: 0, generating: 0, failed: 0, images: 8 })
  }, 20000)

  it('stop mid-run releases the queued and in-flight counts', async () => {
    const id = makeProject()
    let started!: () => void
    const firstStarted = new Promise<void>((res) => (started = res))
    hold = (signal) =>
      new Promise<void>((_, reject) => {
        started()
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    enqueueJobs(project(id), planJobs(project(id), 'all').jobs)
    await firstStarted
    expect(counts(id)).toMatchObject({ queued: 7, generating: 1 })
    useGeneration.getState().stop()
    await idle()
    expect(counts(id)).toEqual({ queued: 0, generating: 0, failed: 0, images: 0 })
    expect(calls).toHaveLength(1)
  }, 20000)
})

describe('project tag in the SQLite history', () => {
  it('survives write → reopen → read and later updates', async () => {
    const s = await getStorage()
    const tag = { projectId: 'P', key: 'character:A|e:smile', coords: { character: 'A', e: 'smile' } }
    const meta: HistoryMeta = {
      id: 42,
      ts: 42,
      thumb: '',
      width: 832,
      height: 1216,
      seed: 7,
      model: 'nai-diffusion-4-5-full',
      kind: 't2i',
      prompt: 'p',
      negative: '',
      mime: 'image/png',
      project: tag
    }
    await s.history.add(meta, new Blob([new Uint8Array(4)], { type: 'image/png' }))
    // 같은 DB를 새 저장소 객체로 다시 연다 (앱을 다시 연 것처럼)
    const reopened = createHistoryRepo(s.driver, s.files)
    expect((await reopened.get(42))?.project).toEqual(tag)
    expect((await reopened.getMany([42]))[0].project).toEqual(tag)
    await reopened.put({ ...(await reopened.get(42))!, saved: 'a/b.png' })
    expect((await createHistoryRepo(s.driver, s.files).get(42))?.project).toEqual(tag)
    expect((await reopened.list({}, 10))[0].project).toEqual(tag)
  })
})

describe('resume after a restart', () => {
  it('counts only the items it will send, never the unconfirmed ones, and adopts images already in history', async () => {
    const id = makeProject()
    const p = project(id)
    const jobs = planJobs(p, 'all').jobs.filter((j) => j.character?.name === '민지')
    const lib = { folders: [], fragments: [] }
    const [b] = jobsToBatches(p.name, jobs, {
      library: useCharacters.getState().characters,
      vibes: [],
      charRefs: [],
      fragmentLib: lib,
      fragments: fragmentSourceFrom(lib),
      newId: () => 77
    }).batches
    expect(b.plan).toHaveLength(4)
    const { history, queue } = await getStorage()
    await queue.saveBatch(b.id, b.label, serializeBatch(b))
    // 0: 끝남(이미 프로젝트에 있음), 1: 히스토리에 들어갔는데 끝남 기록 전에 죽음, 2: 보냈는데 결과 모름, 3: 아직 안 보냄
    const tag1 = b.plan[1].project!.tag
    await history.add(
      { id: 9001, ts: 1, thumb: '', width: 832, height: 1216, seed: 1, model: 'm', kind: 't2i', prompt: '', negative: '', mime: 'image/png', requestId: 'r1', project: tag1 },
      new Blob([new Uint8Array(4)], { type: 'image/png' })
    )
    await queue.mark(77, 0, 'done', 'r0', { imageId: 9000 })
    await queue.mark(77, 1, 'sending', 'r1', { seed: 1 })
    await queue.mark(77, 2, 'sending', 'r2', { seed: 2 })
    // 앱을 다시 연 것처럼 대기·생성 중 장수는 0
    expect(counts(id)).toMatchObject({ queued: 0, generating: 0 })

    const entries = await loadResume()
    // 히스토리에는 있지만 프로젝트에 빠졌던 그림을 분류 표시로 넣는다
    expect(project(id).items[tag1.key].images.map((i) => i.id)).toEqual([9001])
    expect(entries[0].remaining).toHaveLength(1)
    expect(entries[0].uncertain).toHaveLength(1)

    let seenQueued = -1
    hold = async () => {
      if (seenQueued < 0) seenQueued = counts(id).queued + counts(id).generating
    }
    await useGeneration.getState().resume(entries, false)
    await idle()
    // 보낼 1장만 대기로 셌고("확인 필요"는 빼고), 끝나면 0
    expect(seenQueued).toBe(1)
    expect(calls).toHaveLength(1)
    expect(counts(id)).toEqual({ queued: 0, generating: 0, failed: 0, images: 2 })
    const tagged = (await history.list({}, 50)).filter((m) => m.project?.projectId === id)
    expect(tagged.map((m) => m.project!.key).sort()).toEqual([tag1.key, b.plan[3].project!.tag.key].sort())
    expect(expandMatrix(project(id)).combos).toHaveLength(4)
  }, 20000)
})
