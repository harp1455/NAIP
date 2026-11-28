/**
 * 생성 히스토리 · 에셋 프로젝트 연결 최종 검토 지적의 회귀 테스트
 * (프로젝트 삭제와 저장된 대기열, 빠진 그림 다시 넣기, 보관 한도 정리, 재시도 간격, 중지 직후 생성).
 * 네트워크는 흉내 낸다 — 실제 NovelAI API는 부르지 않는다.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Sent {
  prompt: string
  at: number
}
const calls: Sent[] = []
let hold: ((request: { prompt: string }, signal?: AbortSignal) => Promise<void>) | null = null
vi.mock('../src/nai/client', () => {
  class NaiHttpError extends Error {
    constructor(
      message: string,
      readonly status = 0,
      readonly retryAfterMs?: number
    ) {
      super(message)
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
      async (_token: string, request: { prompt: string }, _opts: unknown, signal?: AbortSignal) => {
        // fetch처럼: 이미 멈춘 요청은 보내지 않는다
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        calls.push({ prompt: request.prompt, at: performance.now() })
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
import { useGeneration } from '../src/stores/generation'
import { useHistory } from '../src/stores/history'
import { loadResume, serializeBatch } from '../src/stores/queue-persist'
import { useSettings } from '../src/stores/settings'
import { usePrompt } from '../src/stores/prompt'
import { useCharacters } from '../src/stores/characters'
import { fragmentSourceFrom } from '../src/stores/fragments'
import { planJobs, useProjects, type Project } from '../src/project'
import { jobsToBatches } from '../src/project/batches'
import { tagHistoryImages } from '../src/project/assign'
import { enqueueCombo } from '../src/project/run'
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
/** 프로젝트의 모든 칸에 든 그림 id (같은 그림이 두 칸에 들면 두 번 나온다) */
const imagesOf = (id: string): number[] => Object.values(project(id).items).flatMap((i) => i.images.map((img) => img.id))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const until = async (cond: () => boolean | Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 500 && !(await cond()); i++) await sleep(5)
  expect(await cond()).toBe(true)
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

/** 앱을 다시 연다 — 같은 DB·파일로 저장소를 새로 연다 (이 실행에서 적은 배정처럼 프로세스에만 있던 것이 사라진다) */
async function relaunch(): Promise<void> {
  const { driver, files } = await getStorage()
  await setStorageForTests(driver, files)
}

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

beforeEach(async () => {
  await reset()
})

describe('deleting a project after closing the resume sheet', () => {
  it('cancelling its work also cancels the saved batch counted at launch, so it is never offered or sent again', async () => {
    const id = makeProject()
    const jobs = planJobs(project(id), 'all').jobs.filter((j) => j.character?.name === '민지')
    const [b] = jobsToBatches(project(id).name, jobs.map((j) => ({ ...j, count: 2 })), { ...ctx(), newId: () => 77 }).batches
    const { queue } = await getStorage()
    await queue.saveBatch(b.id, b.label, serializeBatch(b))
    // 앱을 다시 열면 보내지 않은 4장이 대기로 다시 세어진다
    const entries = await loadResume()
    expect(entries).toHaveLength(1)
    expect(counts(id).queued).toBe(4)
    // 이어서 생성 시트를 X로 닫은 뒤 프로젝트를 지우며 "대기·생성 중인 4장도 취소"를 고른다
    expect(useGeneration.getState().cancelProject(id)).toBe(4)
    expect(counts(id).queued).toBe(0)
    useProjects.getState().remove(id)
    // 저장된 배치도 지워져 다음 실행에서 다시 묻지 않는다
    await until(async () => (await queue.load()).batches.length === 0)
    expect(await loadResume()).toEqual([])
    // 이미 읽어 둔 목록으로 이어서 생성을 눌러도 보내지 않는다
    await useGeneration.getState().resume(entries, false)
    await idle()
    expect(calls).toHaveLength(0)
  }, 20000)

  it('leaves the saved batches of other projects alone', async () => {
    const a = makeProject('A')
    const other = makeProject('B')
    const jobsOf = (pid: string) => planJobs(project(pid), 'all').jobs.filter((j) => j.character?.name === '민지')
    const [ba] = jobsToBatches('A', jobsOf(a), { ...ctx(), newId: () => 81 }).batches
    const [bb] = jobsToBatches('B', jobsOf(other), { ...ctx(), newId: () => 82 }).batches
    const { queue } = await getStorage()
    await queue.saveBatch(ba.id, ba.label, serializeBatch(ba))
    await queue.saveBatch(bb.id, bb.label, serializeBatch(bb))
    expect(await loadResume()).toHaveLength(2)
    expect(useGeneration.getState().cancelProject(a)).toBe(2)
    await until(async () => (await queue.load()).batches.length === 1)
    expect(counts(other).queued).toBe(2)
    expect((await loadResume()).map((e) => e.batch.id)).toEqual([82])
  }, 20000)
})

describe('putting back images whose project record was lost', () => {
  it('puts back an older history image assigned by 분류 when the project record did not reach disk', async () => {
    const id = makeProject()
    const key = planJobs(project(id), 'all').jobs[0].key
    const { history, driver } = await getStorage()
    // 프로젝트보다 먼저 만든 히스토리 그림 (id가 프로젝트의 어떤 그림보다도 작다)
    const old = project(id).createdAt - 100000
    await history.add(meta(old), png())
    // 분류가 히스토리에 표시를 남긴 뒤, 프로젝트 기록(localStorage)이 디스크에 닿기 전에 앱이 죽었다 (addImage 없음)
    const tagged = await tagHistoryImages([{ id: old, tag: { projectId: id, key, coords: {} } }])
    expect(tagged).toHaveLength(1)
    await relaunch()
    await loadResume()
    expect(project(id).items[key].images.map((i) => i.id)).toEqual([old])
    const notes = async (): Promise<number> =>
      (await driver.query("SELECT key FROM app_kv WHERE key LIKE 'project-assigned:%'")).length
    // 이번 실행의 기록도 디스크에 닿기 전에 죽을 수 있어, 넣은 실행에서는 적어 둔 것을 지우지 않는다
    expect(await notes()).toBe(1)
    // 다음 실행: 이미 들어 있으면 두 번 넣지 않고 적어 둔 것을 지운다
    await relaunch()
    await loadResume()
    expect(imagesOf(id)).toEqual([old])
    expect(await notes()).toBe(0)
  }, 20000)

  it('keeps a 분류 note written in this run when the late boot finds the image already in the project', async () => {
    const id = makeProject()
    const key = planJobs(project(id), 'all').jobs[0].key
    const { history, driver } = await getStorage()
    const old = project(id).createdAt - 100000
    await history.add(meta(old), png())
    // 디스크의 프로젝트 기록 (이번 실행의 분류 전)
    const onDisk = JSON.parse(JSON.stringify(useProjects.getState().projects)) as Project[]
    // 저장소 준비가 끝나기 전에 분류로 오래된 그림을 배정한다 (ClassifySheet.apply와 같이 표시 → 조합에 넣기)
    for (const m of await tagHistoryImages([{ id: old, tag: { projectId: id, key, coords: {} } }])) {
      useProjects.getState().addImage(id, m.project!.key, { id: m.id, ts: m.ts, seed: m.seed, width: m.width, height: m.height, mime: m.mime }, { fromQueue: false })
    }
    const notes = async (): Promise<number> =>
      (await driver.query("SELECT key FROM app_kv WHERE key LIKE 'project-assigned:%'")).length
    expect(await notes()).toBe(1)
    // 늦게 끝난 준비(loadResume): 메모리의 프로젝트에 들어 있어도 이번 기록이 디스크에 닿았는지는 모른다
    await loadResume()
    expect(await notes()).toBe(1)
    // 프로젝트 기록이 디스크에 닿기 전에 앱이 죽었다 — 다음 실행에서 적어 둔 것으로 다시 넣는다
    await relaunch()
    useProjects.setState({ projects: onDisk })
    await loadResume()
    expect(imagesOf(id)).toEqual([old])
    // 그다음 실행: 이미 들어 있으니 지운다
    await relaunch()
    await loadResume()
    expect(imagesOf(id)).toEqual([old])
    expect(await notes()).toBe(0)
  }, 20000)

  it('a late boot still finds the image lost last run although this run already landed a newer one', async () => {
    const id = makeProject()
    const key = planJobs(project(id), 'all').jobs[0].key
    const { history } = await getStorage()
    // 지난 실행: 분류 표시와 함께 히스토리에 들어갔는데 프로젝트 기록은 잃었다
    const orphan = project(id).createdAt + 1
    await sleep(5)
    await history.add(meta(orphan, { project: { projectId: id, key, coords: {} } }), png())
    // 이번 실행: 저장소 준비(loadResume)가 끝나기 전에 생성한 그림이 먼저 들어온다
    expect(enqueueCombo(project(id), key, 1)).toMatchObject({ images: 1 })
    await idle()
    expect(project(id).items[key].images).toHaveLength(1)
    await loadResume()
    const ids = project(id).items[key].images.map((i) => i.id)
    expect(ids).toContain(orphan)
    expect(ids).toHaveLength(2)
  }, 20000)

  it('never puts an image back a second time under its old combo key after the key moved', async () => {
    const id = makeProject()
    const key = planJobs(project(id), 'all').jobs[0].key
    expect(enqueueCombo(project(id), key, 1)).toMatchObject({ images: 1 })
    await idle()
    const [landed] = imagesOf(id)
    // 빈 축에 첫 값을 넣으면 지금까지의 칸이 새 키로 옮겨진다 (히스토리의 분류 표시는 옛 키 그대로)
    const pose = useProjects.getState().addAxis(id, 'action')!
    useProjects.getState().addValue(id, pose, { label: '서기', prompt: 'standing' })
    expect(project(id).items[key]).toBeUndefined()
    await loadResume()
    expect(imagesOf(id)).toEqual([landed])
  }, 20000)
})

describe('history limit pruning with two adds at once', () => {
  it('a history add that runs during a project image’s own add never deletes that image', async () => {
    const id = makeProject()
    const key = planJobs(project(id), 'all').jobs[0].key
    const h = useHistory.getState()
    for (const n of [1, 2, 3]) await h.add(meta(n), png())
    for (const n of [1, 2, 3]) useProjects.getState().addImage(id, key, { id: n, ts: n }, { fromQueue: false })
    useSettings.setState({ historyLimit: 3 })
    const s = await getStorage()
    const orig = s.history.oldestIds.bind(s.history)
    let director: Promise<void> | null = null
    let first = true
    s.history.oldestIds = async (n, keep) => {
      if (first) {
        first = false
        // 생성한 프로젝트 그림의 정리 조회가 도는 사이 디렉터 도구 결과가 따로 저장된다
        director = useHistory.getState().add(meta(Date.now() + 5000), png())
        await director
      }
      return orig(n, keep)
    }
    try {
      expect(enqueueCombo(project(id), key, 1)).toMatchObject({ images: 1 })
      await idle()
      await director
    } finally {
      s.history.oldestIds = orig
    }
    const inHistory = new Set((await s.history.list({}, 50)).map((m) => m.id))
    const imgs = project(id).items[key].images.map((i) => i.id)
    expect(imgs).toHaveLength(4)
    for (const i of imgs) expect(inHistory.has(i)).toBe(true)
  }, 20000)
})

describe('retry spacing', () => {
  it('waits at least the configured request gap before retrying a 429 with Retry-After 0', async () => {
    useSettings.setState({ delayMin: 0.25, delayMax: 0.25 })
    const { NaiHttpError } = await import('../src/nai/client')
    let first = true
    hold = async () => {
      if (!first) return
      first = false
      // "Retry-After: 0" (또는 이미 지난 시각)
      throw new NaiHttpError('busy', 429, 0)
    }
    const id = makeProject()
    const key = planJobs(project(id), 'all').jobs[0].key
    expect(enqueueCombo(project(id), key, 1)).toMatchObject({ images: 1 })
    await idle()
    expect(calls).toHaveLength(2)
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(240)
  }, 20000)
})

describe('생성 right after 중지', () => {
  it('runs the batch added while the stopped batch is still winding down instead of dropping it', async () => {
    await reset(slowFiles(200))
    usePrompt.setState({ count: 2 })
    const run = useGeneration.getState().start()
    // 첫 장은 배치 내용이 다 써지기를 기다리는 중 (중지로 끊을 수 없다)
    await sleep(50)
    expect(calls).toHaveLength(0)
    useGeneration.getState().stop()
    expect(useGeneration.getState().running).toBe(true)
    // 아직 "생성 중"으로 보여 대기열 추가 버튼을 누른다 — "대기열에 추가했습니다"가 뜬다
    await useGeneration.getState().start()
    expect(useGeneration.getState().queue).toHaveLength(1)
    await run
    await idle()
    // 멈춘 배치는 보내지 않고, 멈춘 뒤에 넣은 배치는 2장 모두 보낸다
    expect(calls).toHaveLength(2)
    expect(useGeneration.getState().queue).toEqual([])
    expect((await (await getStorage()).queue.load()).batches).toEqual([])
  }, 20000)
})
