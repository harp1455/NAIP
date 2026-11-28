/// <reference types="node" />
/**
 * 백업·저장소 검토에서 나온 것 — 불러오지 못한 바이브·레퍼런스·마스크를 덮어쓰지 않기,
 * 그때 복원하는 프로젝트의 바이브·레퍼런스 연결을 끊지 않기, 히스토리 바꾸기 복원 뒤 이전 히스토리 옮기기가
 * 지운 그림을 되살리지 않기, 낡은 저장 공간 점검 결과로 복원한 기록·원본을 덮어쓰거나 지우지 않기.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 스토어들이 localStorage 를 쓴다 (node 에는 없다) — 가져오기 전에 메모리 것을 둔다
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
})

import { bytesSource, historyExportPort, historyImportPort, memorySink, writeNaipBackup, type BackupData } from '../src/backup'
import { idbStorage, openIdb, type HistoryMeta } from '../src/lib/db'
import { useProjects } from '../src/project/store'
import { setStorageForTests } from '../src/storage'
import { checkStorage, deleteOrphanOriginals, recoverOrphans, stillMissingOriginals } from '../src/storage/check'
import { memoryFileStore } from '../src/storage/files'
import { createHistoryRepo } from '../src/storage/history-repo'
import { idbLegacySource, migrateLegacy } from '../src/storage/legacy'
import { migrate } from '../src/storage/schema'
import { createSqlJsDriver } from '../src/storage/sqljs'
import { useMasks, masksLoadFailed } from '../src/stores/masks'
import { refsLoadFailed, useRefs } from '../src/stores/refs'

const THUMB = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2w=='
const H = 1_700_000_000_000

function png(n: number, seed = 1): Blob {
  const b = new Uint8Array(n).map((_, i) => (i * 13 + seed) & 0xff)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  return new Blob([b as BlobPart], { type: 'image/png' })
}

function meta(id: number, patch: Partial<HistoryMeta> & Record<string, unknown> = {}): HistoryMeta {
  return {
    id,
    ts: id,
    thumb: THUMB,
    width: 832,
    height: 1216,
    seed: id % 1000,
    model: 'nai-diffusion-4-5-full',
    kind: 't2i',
    prompt: `1girl, prompt ${id}`,
    negative: 'lowres',
    mime: 'image/png',
    unsaved: 1,
    ...patch
  } as HistoryMeta
}

const vibe = (id: number) => ({ id, name: `v${id}`, image: '', thumb: '', strength: 0.6, infoExtracted: 1, enabled: true, encodings: { 'm|1': `e${id}` } })
const ref = (id: number) => ({ id, name: `r${id}`, image: 'AA', thumb: '', type: 'character', strength: 1, fidelity: 1, enabled: true })
const mask = (id: number) => ({ id, name: `m${id}`, width: 8, height: 8, data: 'data:image/png;base64,AA==', ts: id })

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** 모아서 쓰는 저장(400ms)이 끝날 때까지 */
const settle = () => wait(600)

type Persisted = { persist: { rehydrate: () => Promise<void> | void } }

/** IndexedDB 읽기가 한 번 실패한 채로 다시 불러온다 (열기 실패·큰 값의 JSON.parse RangeError 등) */
async function failOnce(store: Persisted): Promise<void> {
  const read = idbStorage.getItem
  idbStorage.getItem = async () => {
    throw new RangeError('Invalid string length')
  }
  try {
    await store.persist.rehydrate()
  } finally {
    idbStorage.getItem = read
  }
}

describe('a failed IndexedDB load does not overwrite the stored data', () => {
  beforeEach(async () => {
    // 앞선 불러오기의 저장이 끝난 뒤에 시작한다
    await useRefs.persist.rehydrate()
    await useMasks.persist.rehydrate()
    await settle()
  })

  it('keeps the stored vibes and references, so a restart loads them again', async () => {
    const stored = JSON.stringify({ state: { vibes: [vibe(81)], charRefs: [ref(91)] }, version: 0 })
    await idbStorage.setItem('naip-refs', stored)
    await failOnce(useRefs)
    expect(refsLoadFailed()).toBe(true)
    expect(useRefs.getState().hydrated).toBe(true)
    expect(useRefs.getState().vibes).toEqual([])
    // 실패 처리(hydrated: true)가 빈 목록을 저장하지 않는다
    await settle()
    expect(await idbStorage.getItem('naip-refs')).toBe(stored)
    // 화면에서 바꾼 것도 이번 실행에서는 저장하지 않는다 (빈 목록 + 새 항목으로 덮어쓰지 않게)
    useRefs.getState().setAllCharRefs(false)
    useRefs.setState({ vibes: [vibe(5) as never] })
    await settle()
    expect(await idbStorage.getItem('naip-refs')).toBe(stored)

    // 다시 시작하면 그대로 불러온다
    await useRefs.persist.rehydrate()
    expect(refsLoadFailed()).toBe(false)
    expect(useRefs.getState().vibes.map((v) => v.id)).toEqual([81])
    expect(useRefs.getState().charRefs.map((r) => r.id)).toEqual([91])
    // 불러온 뒤에는 다시 저장한다
    useRefs.getState().patchVibe(81, { strength: 0.3 })
    await settle()
    expect(JSON.parse((await idbStorage.getItem('naip-refs'))!).state.vibes[0].strength).toBe(0.3)
  })

  it('keeps the stored masks when one is added after a failed load', async () => {
    const stored = JSON.stringify({ state: { masks: [mask(7)] }, version: 0 })
    await idbStorage.setItem('naip-masks', stored)
    await failOnce(useMasks)
    expect(masksLoadFailed()).toBe(true)
    useMasks.getState().add({ name: 'new', width: 8, height: 8, data: 'data:image/png;base64,AA==' })
    await settle()
    expect(await idbStorage.getItem('naip-masks')).toBe(stored)

    await useMasks.persist.rehydrate()
    expect(masksLoadFailed()).toBe(false)
    expect(useMasks.getState().masks.map((m) => m.id)).toEqual([7])
  })
})

describe('restoring projects while vibes and references failed to load', () => {
  const proj = (id: string) => ({
    id,
    name: id,
    axes: [],
    items: {},
    vibeIds: [81],
    refIds: [91],
    characters: [{ id: 'pc', libraryId: null, name: 'Bob', prompt: '', vibeIds: [81], refIds: [91] }]
  })

  async function backup(data: BackupData): Promise<Uint8Array> {
    const sink = memorySink()
    await writeNaipBackup(data, sink, { mode: 'light', appVersion: '0.12.0' })
    return sink.bytes()
  }

  it('keeps every project vibe and reference link instead of cutting them as dangling', async () => {
    await setStorageForTests(await createSqlJsDriver(), memoryFileStore())
    const app = await import('../src/backup/app')
    // 이 기기에는 바이브 81·레퍼런스 91 이 저장돼 있지만 이번 실행에서 불러오지 못했다
    await idbStorage.setItem('naip-refs', JSON.stringify({ state: { vibes: [vibe(81)], charRefs: [ref(91)] }, version: 0 }))
    useProjects.setState({ projects: [], activeId: null })
    await failOnce(useRefs)
    try {
      expect(refsLoadFailed()).toBe(true)
      const withRefs = await backup({ vibes: { vibes: [vibe(81)] }, charRefs: { charRefs: [ref(91)] }, projects: { projects: [proj('p1')], activeId: null } })
      const projectsOnly = await backup({ projects: { projects: [proj('p2')], activeId: null } })
      for (const bytes of [withRefs, projectsOnly]) {
        const src = await app.openRestoreSource({ name: 'b.naipbackup', source: bytesSource(bytes) })
        for (const mode of ['overwrite', 'merge'] as const) {
          const plan = await app.planFor(src, { mode, sections: {}, history: 'skip', originals: false })
          const section = plan.sections.projects!
          const [p] = section.result.projects as ReturnType<typeof proj>[]
          expect(p.vibeIds).toEqual([81])
          expect(p.refIds).toEqual([91])
          expect(p.characters[0]).toMatchObject({ vibeIds: [81], refIds: [91] })
          expect(section.stats.dangling).toBe(0)
          // 확인 화면에 확인하지 않고 둔 연결을 알린다
          expect(section.notes.some((n) => n.includes('불러오지 못해') && n.includes('4곳'))).toBe(true)
        }
      }
      const src = await app.openRestoreSource({ name: 'b.naipbackup', source: bytesSource(withRefs) })
      const plan = await app.planFor(src, { mode: 'overwrite', sections: {}, history: 'skip', originals: false })
      await app.applyRestore(src, plan, { safety: false })
      const [p] = useProjects.getState().projects
      expect(p.vibeIds).toEqual([81])
      expect(p.refIds).toEqual([91])
      expect(p.characters[0]).toMatchObject({ vibeIds: [81], refIds: [91] })
    } finally {
      await useRefs.persist.rehydrate()
    }
    // 다시 불러오면 바이브·레퍼런스도 그대로다 — 프로젝트가 다시 이어진다
    expect(useRefs.getState().vibes.map((v) => v.id)).toEqual([81])
  })

  it('still cuts links to vibes that are really missing when vibes did load', async () => {
    await setStorageForTests(await createSqlJsDriver(), memoryFileStore())
    const app = await import('../src/backup/app')
    useRefs.setState({ vibes: [], charRefs: [] })
    const src = await app.openRestoreSource({ name: 'b.naipbackup', source: bytesSource(await backup({ projects: { projects: [proj('p3')], activeId: null } })) })
    const plan = await app.planFor(src, { mode: 'merge', sections: {}, history: 'skip', originals: false })
    const p = (plan.sections.projects!.result.projects as ReturnType<typeof proj>[]).find((x) => x.id === 'p3')!
    expect(p.vibeIds).toEqual([])
    expect(p.characters[0]).toMatchObject({ vibeIds: [], refIds: [] })
    expect(plan.sections.projects!.stats.dangling).toBe(4)
  })
})

/** 예전 IndexedDB 히스토리에 그림을 넣는다 (v4 스키마 그대로) */
async function seedLegacy(metas: HistoryMeta[], size: number): Promise<void> {
  const db = await openIdb()
  const tx = db.transaction(['meta', 'blobs', 'text'], 'readwrite')
  for (const m of metas) {
    tx.objectStore('meta').put(m)
    tx.objectStore('blobs').put(new Uint8Array(size).fill(3).buffer, m.id)
    tx.objectStore('text').put(m.prompt, m.id)
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

describe('history replace restore while the old IndexedDB history is still being moved', () => {
  it('does not bring the removed images back on the next migration', async () => {
    const here = await setStorageForTests(await createSqlJsDriver(), memoryFileStore())
    const L1 = H + 101
    const L2 = H + 102
    // L1 은 이미 옮겼고(행과 같은 크기의 파일), L2 는 아직 옮기지 않았다. 옛 데이터는 아직 비우지 않았다
    await seedLegacy([meta(L1), meta(L2)], 64)
    await here.history.add(meta(L1), new Blob([new Uint8Array(64).fill(3)], { type: 'image/png' }))

    // 다른 기기의 백업: H+5 한 장
    const driver = await createSqlJsDriver()
    await migrate(driver)
    const files = memoryFileStore()
    await createHistoryRepo(driver, files).add(meta(H + 5), png(300, 5))
    const sink = memorySink()
    await writeNaipBackup({}, sink, { mode: 'full', appVersion: '0.12.0', history: historyExportPort({ driver, files }) })

    const app = await import('../src/backup/app')
    const src = await app.openRestoreSource({ name: 'other.naipbackup', source: bytesSource(sink.bytes()) })
    const plan = await app.planFor(src, { mode: 'selective', sections: {}, history: 'replace', originals: true })
    const summary = await app.applyRestore(src, plan, { safety: false })
    expect(summary.history?.removedIds).toEqual([L1])
    expect(await here.history.ids({})).toEqual([H + 5])

    const r = await migrateLegacy({ storage: here, source: idbLegacySource(), freeSpace: async () => 1e12 })
    expect(r.status).toBe('done')
    // 아직 옮기지 않았던 L2 는 옮겨 오고, 바꾸기로 지운 L1 은 되살아나지 않는다
    expect((await here.history.ids({})).sort()).toEqual([L2, H + 5].sort())
  })
})

describe('acting on a storage check report that went stale (a restore ran in between)', () => {
  const describeStub = async () => ({ width: 1, height: 1, seed: 0, model: 'x', prompt: 'recovered', negative: '', thumb: THUMB })

  async function store() {
    const driver = await createSqlJsDriver()
    await migrate(driver)
    const files = memoryFileStore()
    return { driver, files, repo: createHistoryRepo(driver, files) }
  }

  it('does not replace a restored record with one read from the image', async () => {
    const s = await store()
    await s.files.write(`images/${H + 1}.png`, png(400, 1))
    await s.files.write(`images/${H + 2}.png`, png(300, 2))
    const report = await checkStorage(s)
    expect(report.orphanOriginals.map((o) => o.path).sort()).toEqual([`images/${H + 1}.png`, `images/${H + 2}.png`])
    // 점검 결과를 띄워 둔 채 복원: H+1 은 원본과 함께 온전한 기록이, H+2 는 기록만 들어온다
    await s.repo.add(meta(H + 1, { fav: 1, saved: 'NAIP/a.png', unsaved: undefined, prompt: 'rich prompt' }), png(400, 1))
    await historyImportPort(s).put(meta(H + 2, { fav: 1, prompt: 'record only' }) as never, null)
    expect((await s.repo.row(H + 2))!.file).toBeNull()

    const r = await recoverOrphans(s, report.orphanOriginals, describeStub, { ids: async () => [] })
    expect(r).toEqual({ recovered: 1, waiting: 0, present: 1 })
    expect(await s.repo.get(H + 1)).toMatchObject({ fav: 1, saved: 'NAIP/a.png', prompt: 'rich prompt' })
    expect((await s.repo.get(H + 1))!.unsaved).toBeUndefined()
    // 기록만 있던 H+2 는 그 기록 그대로 원본을 잇는다
    expect(await s.repo.get(H + 2)).toMatchObject({ fav: 1, prompt: 'record only' })
    expect(await s.repo.row(H + 2)).toMatchObject({ file: `images/${H + 2}.png`, bytes: 300 })
    expect(await checkStorage(s)).toMatchObject({ orphanOriginals: [], missingOriginals: [], sizeMismatch: [] })
  })

  it('does not delete an original that a restored record now uses', async () => {
    const s = await store()
    for (const id of [H + 1, H + 2, H + 3, H + 4]) await s.files.write(`images/${id}.png`, png(400, id % 7))
    const report = await checkStorage(s)
    expect(report.orphanOriginals).toHaveLength(4)
    // 복원: H+1 은 원본과 함께, H+2 는 기록만(같은 id 의 원본을 그대로 가리킨다), H+4 는 다른 형식(webp)의 원본으로
    await s.repo.add(meta(H + 1), png(400, 1))
    await s.driver.batch([{ sql: 'INSERT INTO images (id, file, bytes, thumb, ts, width, height, seed, model, kind, prompt, negative, mime) VALUES (?, NULL, 0, NULL, ?, 1, 1, 0, ?, ?, ?, ?, ?)', params: [H + 2, H + 2, 'm', 't2i', 'p', '', 'image/png'] }])
    await s.repo.add(meta(H + 4, { mime: 'image/webp' }), new Blob([new Uint8Array(50)], { type: 'image/webp' }))

    const r = await deleteOrphanOriginals(s, report.orphanOriginals.map((o) => o.path))
    expect(r).toEqual({ deleted: 2, skipped: 2 })
    expect(s.files.files.has(`images/${H + 1}.png`)).toBe(true)
    expect(s.files.files.has(`images/${H + 2}.png`)).toBe(true)
    // 정말 남는 것(기록 없음, 다른 형식의 예전 파일)만 지운다
    expect(s.files.files.has(`images/${H + 3}.png`)).toBe(false)
    expect(s.files.files.has(`images/${H + 4}.png`)).toBe(false)
    expect((await checkStorage(s)).missingOriginals).toEqual([])
  })

  it('does not delete a record whose original came back', async () => {
    const s = await store()
    await s.repo.add(meta(H + 1), png(400, 1))
    await s.repo.add(meta(H + 2), png(400, 2))
    await s.files.remove([`images/${H + 1}.png`, `images/${H + 2}.png`])
    const report = await checkStorage(s)
    expect(report.missingOriginals.sort()).toEqual([H + 1, H + 2])
    // 복원으로 H+1 의 원본이 다시 들어왔다
    await s.repo.add(meta(H + 1), png(400, 1))
    expect(await stillMissingOriginals(s, report.missingOriginals)).toEqual([H + 2])
  })
})
