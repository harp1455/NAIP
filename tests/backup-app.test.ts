/// <reference types="node" />
/**
 * Phase 4 UI 연결 시험 — 히스토리 포트(Phase 3 SQLite + 파일), Phase 2 캐릭터 id 다시 매기기,
 * 에셋 프로젝트 섹션, 예전 형식 캐릭터 백업, 토큰이 백업 어디에도 없는지, 자동 백업, 대기열 제외.
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

import {
  bytesSource,
  historyExportPort,
  historyImportPort,
  listSafetyBackups,
  memorySink,
  openAnyBackup,
  openNaipBackup,
  planRestore,
  pruneSafetyBackups,
  restoreHistory,
  restoreHistorySafely,
  safetySink,
  safetySource,
  writeNaipBackup,
  type BackupData
} from '../src/backup'
import { applyRestorePlan, collectStoreData, normalizeBackupData, normalizeCharactersSection } from '../src/backup/stores'
import { fromUtf8, utf8 } from '../src/backup/bytes'
import { sha256Hex } from '../src/backup/hash'
import type { HistoryMeta } from '../src/lib/db'
import { useProjects } from '../src/project/store'
import { memoryFileStore } from '../src/storage/files'
import { createHistoryRepo } from '../src/storage/history-repo'
import { migrate } from '../src/storage/schema'
import { createSqlJsDriver } from '../src/storage/sqljs'
import { useCharacters } from '../src/stores/characters'
import { useSettings } from '../src/stores/settings'
import { readAllEntries, rewriteZip } from './helpers/zip-craft'
import { sampleData } from './helpers/sample'

const THUMB = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2w=='

function png(n: number, seed = 1): Uint8Array {
  const b = new Uint8Array(n).map((_, i) => (i * 13 + seed) & 0xff)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  return b
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

async function fresh() {
  const driver = await createSqlJsDriver()
  await migrate(driver)
  const files = memoryFileStore()
  return { driver, files, repo: createHistoryRepo(driver, files) }
}

type Fresh = Awaited<ReturnType<typeof fresh>>

const H = 1_700_000_000_000

/** 모든 종류의 필드를 가진 히스토리 5장 (하나는 원본 파일이 사라졌고, 하나는 썸네일이 없다) */
async function seeded(): Promise<Fresh> {
  const s = await fresh()
  const snap = { base: 'b', additional: '', detail: '', negative: 'n', params: { steps: 28 }, chars: [], cast: { plan: { slots: [], options: {}, characters: [] } } }
  const sent = {
    prompt: 'p',
    negative: 'n',
    chars: [{ name: 'Alice', prompt: '1girl', negative: '', center: { x: 0.2, y: 0.5 } }],
    cast: { chars: [{ slotId: 9, charId: 31, variations: [{ group: '복장', label: '교복' }] }], countFix: { from: '2girls', to: '1girl' } }
  }
  await s.repo.add(meta(H + 1, { fav: 1, snap, sent, sceneId: 51, sceneName: '해변' } as never), new Blob([png(900, 1) as BlobPart], { type: 'image/png' }))
  await s.repo.add(meta(H + 2, { parentId: H + 1, kind: 'i2i', saved: 'NAIP/a.png', unsaved: undefined, requestId: 'req-2' } as never), new Blob([png(700, 2) as BlobPart]))
  await s.repo.add(meta(H + 3, { project: { id: 'p-1', key: 'pc-1|smile' }, futureField: [1, 2] } as never), new Blob([png(800, 3) as BlobPart]))
  await s.repo.add(meta(H + 4, { thumb: '' }), new Blob([png(600, 4) as BlobPart]))
  await s.repo.add(meta(H + 5), new Blob([png(500, 5) as BlobPart]))
  // 원본 파일이 사라진 기록
  await s.files.remove([`images/${H + 5}.png`])
  return s
}

async function fullBackup(s: Fresh, data: BackupData = {}, opts: Partial<Parameters<typeof writeNaipBackup>[2]> = {}): Promise<Uint8Array> {
  const sink = memorySink()
  await writeNaipBackup(data, sink, { mode: 'full', appVersion: '0.12.0', history: historyExportPort(s), historyPageSize: 2, ...opts })
  return sink.bytes()
}

const stripThumb = (m: HistoryMeta | null): Record<string, unknown> => {
  const { thumb: _t, ...rest } = (m ?? {}) as HistoryMeta
  void _t
  return rest
}

describe('history ports on the Phase 3 storage', () => {
  it('round-trips every HistoryMeta field, thumbnails and originals', async () => {
    const src = await seeded()
    // 원본은 한 번에 한 장만 읽는다
    let inFlight = 0
    let maxInFlight = 0
    const read = src.files.read.bind(src.files)
    src.files.read = async (path, mime) => {
      if (!path.startsWith('images/')) return read(path, mime)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        return await read(path, mime)
      } finally {
        inFlight--
      }
    }
    const port = historyExportPort(src)
    // 크기는 행에 적힌 값으로 어림한다 (H+5 는 파일이 사라졌지만 행에는 500 바이트로 남아 있다)
    expect(await port.stats()).toMatchObject({ count: 5, originalBytes: 900 + 700 + 800 + 600 + 500 })
    const sink = memorySink()
    const written = await writeNaipBackup({}, sink, { mode: 'full', appVersion: '0.12.0', history: port, historyPageSize: 2 })
    expect(written.skippedOriginals).toBe(1)
    expect(written.manifest.counts).toMatchObject({ history: 5, historyOriginals: 4 })
    expect(maxInFlight).toBe(1)

    const dst = await fresh()
    const made: string[] = []
    const reader = await openNaipBackup(bytesSource(sink.bytes()))
    const r = await restoreHistory(reader, historyImportPort(dst, { makeThumb: async () => (made.push('x'), 'data:image/jpeg;base64,/9j/TUFERQ==') }), {
      mode: 'merge',
      originals: true
    })
    expect(r).toMatchObject({ added: 5, failed: 0, missingOriginals: 1 })
    for (let i = 1; i <= 5; i++) {
      expect(stripThumb(await dst.repo.get(H + i))).toEqual(stripThumb(await src.repo.get(H + i)))
    }
    // 앞으로 늘어날 필드·프로젝트 표시도 그대로
    expect(await dst.repo.get(H + 3)).toMatchObject({ project: { id: 'p-1', key: 'pc-1|smile' }, futureField: [1, 2] })
    expect(await dst.repo.get(H + 1)).toMatchObject({ sent: { cast: { chars: [{ charId: 31 }], countFix: { to: '1girl' } } }, fav: 1 })
    expect(await dst.repo.get(H + 2)).toMatchObject({ parentId: H + 1, saved: 'NAIP/a.png', requestId: 'req-2' })
    expect((await dst.repo.get(H + 2))!.unsaved).toBeUndefined()
    // 원본
    for (let i = 1; i <= 4; i++) {
      expect(dst.files.files.get(`images/${H + i}.png`)).toEqual(src.files.files.get(`images/${H + i}.png`))
    }
    expect((await dst.repo.row(H + 5))!.file).toBeNull()
    // 썸네일: 저장돼 있던 것은 그대로, 없던 것(H+4)은 원본으로 새로 만든다
    expect(dst.files.files.get(`thumbs/${H + 1}.jpg`)).toEqual(src.files.files.get(`thumbs/${H + 1}.jpg`))
    expect(made).toHaveLength(1)
    expect(Buffer.from(dst.files.files.get(`thumbs/${H + 4}.jpg`)!).toString('base64')).toBe('/9j/TUFERQ==')
  })

  it('replaces history only after every backup record went in', async () => {
    const src = await seeded()
    const bytes = await fullBackup(src)
    const dst = await fresh()
    await dst.repo.add(meta(H + 1, { prompt: 'current version' }), new Blob([png(300, 9) as BlobPart]))
    await dst.repo.add(meta(H + 99, { prompt: 'only here' }), new Blob([png(300, 8) as BlobPart]))
    const port = historyImportPort(dst)

    // 원본 하나가 손상된 백업 → 기록은 다 넣지만 지금 것을 지우지 않는다
    const broken = await rewriteZip(bytes, (path, data) => (path === `history/originals/${H + 2}.png` ? data.map((b, i) => (i === 40 ? b ^ 1 : b)) : data))
    const r1 = await restoreHistorySafely(await openNaipBackup(bytesSource(broken)), port, { mode: 'replace', originals: true })
    expect(r1.removed).toBe(0)
    expect(r1.keptBecauseOfProblems).toBe(1)
    expect(r1.problems.length).toBeGreaterThan(0)
    expect(await dst.repo.get(H + 99)).not.toBeNull()

    // 손상된 기록 페이지 → 그 페이지 기록을 몰라 아무것도 지우지 않는다
    const badPage = await rewriteZip(bytes, (path, data) => (path === 'history/meta-000001.jsonl' ? utf8('garbage') : data))
    const r2 = await restoreHistorySafely(await openNaipBackup(bytesSource(badPage)), port, { mode: 'replace', originals: true })
    expect(r2.removed).toBe(0)
    expect(await dst.repo.get(H + 99)).not.toBeNull()

    // 온전한 백업 → 백업 기록으로 바꾸고, 백업에 없던 지금 기록만 지운다
    const r3 = await restoreHistorySafely(await openNaipBackup(bytesSource(bytes)), port, { mode: 'replace', originals: true })
    expect(r3).toMatchObject({ added: 5, failed: 0, removed: 1 })
    expect(await dst.repo.get(H + 99)).toBeNull()
    expect(dst.files.files.has(`images/${H + 99}.png`)).toBe(false)
    expect((await dst.repo.get(H + 1))!.prompt).toBe(`1girl, prompt ${H + 1}`)
    expect(dst.files.files.get(`images/${H + 1}.png`)).toEqual(src.files.files.get(`images/${H + 1}.png`))
  })

  it('keeps the current original when a record-only backup replaces a record', async () => {
    const src = await seeded()
    const bytes = await fullBackup(src, {}, { mode: 'custom', sections: ['history'] })
    const dst = await fresh()
    const mine = png(321, 7)
    await dst.repo.add(meta(H + 1, { prompt: 'mine' }), new Blob([mine as BlobPart]))
    const r = await restoreHistorySafely(await openNaipBackup(bytesSource(bytes)), historyImportPort(dst), { mode: 'replace', originals: false })
    expect(r).toMatchObject({ added: 5, failed: 0 })
    expect((await dst.repo.get(H + 1))!.prompt).toBe(`1girl, prompt ${H + 1}`)
    expect((await dst.repo.row(H + 1))!.file).toBe(`images/${H + 1}.png`)
    expect(dst.files.files.get(`images/${H + 1}.png`)).toEqual(mine)
    // 원본이 없는 기록은 원본 없이 (썸네일은 백업 것)
    expect((await dst.repo.row(H + 2))!.file).toBeNull()
    expect(dst.files.files.has(`thumbs/${H + 2}.jpg`)).toBe(true)
  })

  it('rejects malformed records without stopping the rest', async () => {
    const src = await seeded()
    const bytes = await fullBackup(src)
    let page: Uint8Array = new Uint8Array()
    const evil = await rewriteZip(bytes, (path, data) => {
      if (path !== 'history/meta-000001.jsonl') return data
      page = utf8(fromUtf8(data).replace(`"id":${H + 1},`, '"id":-5,'))
      return page
    })
    // 체크섬도 맞춰 준다 (조작자가 할 수 있는 일) — 그래도 잘못된 기록 하나만 빠지고 나머지는 들어간다
    const fixed = await rewriteZip(evil, (path, data) => {
      if (path !== 'checksums.json') return data
      const sums = JSON.parse(fromUtf8(data))
      sums['history/meta-000001.jsonl'] = { sha256: sha256Hex(page), size: page.byteLength }
      return utf8(JSON.stringify(sums))
    })
    const reader = await openNaipBackup(bytesSource(fixed))
    expect((await reader.verify()).ok).toBe(true)
    const dst = await fresh()
    const r = await restoreHistory(reader, historyImportPort(dst), { mode: 'merge', originals: true })
    expect(r).toMatchObject({ added: 4, failed: 1 })
    expect(r.problems.some((p) => p.detail.includes('기록 id'))).toBe(true)
    expect(await dst.repo.count({})).toBe(4)
  })
})

describe('Phase 2 character ids in restore plans', () => {
  const char = (id: number, name: string, folderId: number | null, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    folderId,
    base: name.toLowerCase(),
    additional: '',
    detail: '',
    negative: '',
    variations: [{ id: 7, kind: 'outfit', name: '복장', mode: 'random', fixedId: null, items: [{ id: 70, label: 'a', prompt: 'a', weight: 1 }] }],
    ...extra
  })
  const options = { allowDuplicates: false, scope: 'image', perScene: false, autoCountTags: false }
  const incoming = (): BackupData => ({
    characters: {
      folders: [{ id: 1, name: '다른 기기 폴더' }],
      characters: [char(10, 'Bob', 1), char(11, 'Cat', null)],
      slots: [
        { id: 900, enabled: true, mode: 'fixed', charId: 10, candidates: [], chance: 50, wrap: true, center: { x: 0.3, y: 0.5 } },
        {
          id: 901,
          enabled: true,
          mode: 'random',
          charId: null,
          candidates: [
            { kind: 'char', id: 11, weight: 2 },
            { kind: 'char', id: 10, weight: 1 },
            { kind: 'folder', id: 1, weight: 1 },
            { kind: 'folder', id: null, weight: 1 },
            { kind: 'char', id: 999, weight: 1 },
            { kind: 'folder', id: 998, weight: 1 }
          ],
          chance: 50,
          wrap: true,
          center: null
        },
        { id: 902, enabled: true, mode: 'fixed', charId: 999, candidates: [], chance: 50, wrap: true, center: null }
      ],
      options
    },
    scenes: { folders: [], scenes: [{ id: 20, name: '씬', folderId: null, prompt: '', negative: '', size: null, cast: [10, 11, 999], castCenters: { 10: { x: 0.1, y: 0.1 } }, reserve: 0 }] }
  })
  const current = (slots: unknown[] = []): BackupData => ({
    characters: { folders: [{ id: 1, name: '내 폴더' }], characters: [char(10, 'Alice', 1)], slots, options },
    scenes: { folders: [], scenes: [] }
  })

  it('remaps slot characters, folder candidates and scene casts on merge', () => {
    let next = 5000
    const plan = planRestore(current(), normalizeBackupData(incoming()), { mode: 'merge', newId: () => ++next })
    const ch = plan.sections.characters!.result as { folders: { id: number; name: string }[]; characters: { id: number; name: string; folderId: number | null; variations: { id: number }[] }[]; slots: { id: number; mode: string; charId: number | null; candidates: { kind: string; id: number | null }[] }[] }
    const folder = ch.folders.find((f) => f.name === '다른 기기 폴더')!
    const bob = ch.characters.find((c) => c.name === 'Bob')!
    expect(folder.id).toBe(5001)
    expect(bob.id).toBe(5002)
    expect(bob.folderId).toBe(5001)
    // 변형 id 는 캐릭터 안의 것이라 그대로
    expect(bob.variations[0].id).toBe(7)
    expect(ch.characters.find((c) => c.name === 'Cat')!.id).toBe(11)
    // 지금 출연 슬롯이 비어 있으면 백업 슬롯을 쓰고, 그 안의 id 를 고친다
    expect(ch.slots.map((s) => s.id)).toEqual([900, 901])
    expect(ch.slots[0]).toMatchObject({ mode: 'fixed', charId: 5002, center: { x: 0.3, y: 0.5 } })
    expect(ch.slots[1].candidates).toEqual([
      { kind: 'char', id: 11, weight: 2 },
      { kind: 'char', id: 5002, weight: 1 },
      { kind: 'folder', id: 5001, weight: 1 },
      { kind: 'folder', id: null, weight: 1 }
    ])
    const scene = (plan.sections.scenes!.result.scenes as { id: number; cast: number[]; castCenters: Record<string, unknown> }[])[0]
    expect(scene.cast).toEqual([5002, 11])
    expect(Object.keys(scene.castCenters)).toEqual(['5002'])
    // 지금 Alice(10) 는 그대로
    expect(ch.characters.find((c) => c.id === 10)!.name).toBe('Alice')
  })

  it('keeps the current cast slots on merge when there are some', () => {
    const mine = [{ id: 1, enabled: true, mode: 'fixed', charId: 10, candidates: [], chance: 50, wrap: true, center: null }]
    const plan = planRestore(current(mine), normalizeBackupData(incoming()), { mode: 'merge', newId: (() => { let n = 7000; return () => ++n })() })
    expect(plan.sections.characters!.result.slots).toEqual(mine)
  })

  it('drops slots and candidates whose character is gone on overwrite', () => {
    const plan = planRestore(current(), normalizeBackupData(incoming()), { mode: 'overwrite' })
    const slots = plan.sections.characters!.result.slots as { id: number; candidates: { id: number | null }[] }[]
    // 고정 슬롯 902(없는 캐릭터)는 빠지고, 후보 999·폴더 998 도 빠진다
    expect(slots.map((s) => s.id)).toEqual([900, 901])
    expect(slots[1].candidates.map((c) => c.id)).toEqual([11, 10, 1, null])
    expect(plan.sections.characters!.stats.dangling).toBe(3)
  })

  it('migrates pre-Phase 2 characters (prompt + cast) from an old JSON backup through the same path', async () => {
    const old = {
      app: 'naip',
      version: 2,
      prompt: { base: 'x', additional: '', detail: '', negative: '', params: {}, presets: [] },
      characters: {
        folders: [{ id: 1, name: 'F' }],
        characters: [{ id: 2, name: 'Old', folderId: 1, prompt: '1girl, red hair', negative: 'bad', legacyOnly: 'kept' }],
        cast: [
          { charId: 2, enabled: true, center: { x: 0.3, y: 0.4 } },
          { charId: 3, enabled: false, center: null }
        ]
      },
      scenes: { folders: [], scenes: [{ id: 4, name: 's', folderId: null, prompt: '', negative: '', size: null, cast: [2], reserve: 0 }] }
    }
    const opened = await openAnyBackup(bytesSource(utf8(JSON.stringify(old))))
    expect(opened.kind).toBe('naip-json')
    const data = normalizeBackupData((opened as { data: BackupData }).data)
    const ch = data.characters as unknown as { characters: Record<string, unknown>[]; slots: Record<string, unknown>[]; cast?: unknown }
    expect(ch.cast).toBeUndefined()
    expect(ch.characters[0]).toMatchObject({ id: 2, base: '1girl, red hair', additional: '', detail: '', negative: 'bad', variations: [], legacyOnly: 'kept' })
    expect(ch.characters[0].prompt).toBeUndefined()
    expect(ch.slots.map((s) => [s.mode, s.charId, s.enabled])).toEqual([
      ['fixed', 2, true],
      ['fixed', 3, false]
    ])
    // 지금 라이브러리와 id 가 부딪히면 새 id 로, 슬롯·씬도 따라간다 (3 은 없는 캐릭터라 슬롯째 빠진다)
    let next = 100
    const plan = planRestore(
      { characters: { folders: [], characters: [char(2, 'Mine', null)], slots: [], options } },
      data,
      { mode: 'merge', newId: () => ++next }
    )
    const result = plan.sections.characters!.result as { characters: { id: number; name: string }[]; slots: { charId: number }[] }
    const oldId = result.characters.find((c) => c.name === 'Old')!.id
    expect(oldId).not.toBe(2)
    expect(result.slots.map((s) => s.charId)).toEqual([oldId])
    expect((plan.sections.scenes!.result.scenes as { cast: number[] }[])[0].cast).toEqual([oldId])

    // 스토어에 넣으면 지금 형식 그대로
    applyRestorePlan(plan)
    const st = useCharacters.getState()
    expect(st.characters.find((c) => c.name === 'Old')).toMatchObject({ base: '1girl, red hair', variations: [] })
    expect(st.slots[0]).toMatchObject({ mode: 'fixed', charId: oldId, center: { x: 0.3, y: 0.4 } })
    expect(typeof st.addSlot).toBe('function')
  })

  it('migrates old-shape characters inside a .naipbackup too', async () => {
    const sink = memorySink()
    await writeNaipBackup(sampleData(), sink, { mode: 'light', appVersion: '0.11.0' })
    const reader = await openNaipBackup(bytesSource(sink.bytes()))
    const data = normalizeBackupData((await reader.readData()).data)
    const ch = data.characters as { characters: { id: number; base: string }[]; slots: { charId: number }[] }
    expect(ch.characters.map((c) => [c.id, c.base])).toEqual([
      [31, '1girl'],
      [32, '1boy']
    ])
    expect(ch.slots.map((s) => s.charId)).toEqual([32, 31])
  })

  it('normalizes characters idempotently', () => {
    const once = normalizeCharactersSection(incoming().characters)
    expect(normalizeCharactersSection(once)).toEqual(once)
  })
})

describe('asset projects section', () => {
  const proj = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, characters: [], axes: [], items: {}, ...extra })

  it('merges by adding missing project ids and keeping current ones', () => {
    const cur: BackupData = { projects: { projects: [proj('p1', 'Mine')], activeId: 'p1', presets: [] } }
    const inc: BackupData = {
      characters: { folders: [], characters: [{ id: 10, name: 'Bob', folderId: null, base: '', additional: '', detail: '', negative: '', variations: [] }], slots: [], options: {} },
      vibes: { vibes: [{ id: 81, name: 'v', image: '', thumb: '', strength: 0.6, infoExtracted: 1, enabled: true, encodings: {} }] },
      projects: {
        projects: [
          proj('p1', 'Other device'),
          proj('p2', 'New', {
            characters: [{ id: 'pc', libraryId: 10, name: 'Bob', vibeIds: [81, 82], refIds: [] }],
            items: { 'pc|smile': { key: 'pc|smile', images: [{ id: H + 1, ts: 1, mark: 'adopted' }], queued: 0, generating: 0 } }
          })
        ],
        activeId: 'p2',
        presets: [{ id: 'cp', name: '변환' }]
      }
    }
    const current: BackupData = {
      ...cur,
      characters: { folders: [], characters: [{ id: 10, name: 'Alice', folderId: null, base: 'a', additional: '', detail: '', negative: '', variations: [] }], slots: [], options: {} }
    }
    let next = 300
    const plan = planRestore(current, normalizeBackupData(inc), { mode: 'merge', newId: () => ++next })
    const pr = plan.sections.projects!
    const list = pr.result.projects as { id: string; name: string; characters: { libraryId: number | null; vibeIds: number[] }[]; items: Record<string, { images: { id: number }[] }> }[]
    expect(list.map((p) => [p.id, p.name])).toEqual([
      ['p1', 'Mine'],
      ['p2', 'New']
    ])
    expect(pr.stats).toMatchObject({ added: 2, kept: 1 })
    expect(pr.changes.find((c) => c.kind === 'kept')).toMatchObject({ id: 'p1' })
    // 프로젝트 캐릭터는 새 id 를 받은 라이브러리 캐릭터를 따라가고, 없는 바이브는 빠진다
    const bobId = (plan.sections.characters!.result.characters as { id: number; name: string }[]).find((c) => c.name === 'Bob')!.id
    expect(bobId).not.toBe(10)
    expect(list[1].characters[0]).toMatchObject({ libraryId: bobId, vibeIds: [81] })
    // 프로젝트 그림이 가리키는 히스토리 id 는 바꾸지 않는다
    expect(list[1].items['pc|smile'].images[0].id).toBe(H + 1)
    // 지금 고른 프로젝트는 그대로
    expect(pr.result.activeId).toBe('p1')
    expect(pr.result.presets).toEqual([{ id: 'cp', name: '변환' }])
  })

  it('takes the backup active project (and cast slots) on merge only when nothing is chosen now', () => {
    const inc: BackupData = { projects: { projects: [proj('p9', 'Backup')], activeId: 'p9' } }
    const empty = planRestore({ projects: { projects: [], activeId: null } }, inc, { mode: 'merge' })
    expect(empty.sections.projects!.result.activeId).toBe('p9')
    expect(empty.sections.projects!.notes).toEqual([])
    const chosen = planRestore({ projects: { projects: [proj('p1', 'Mine')], activeId: 'p1' } }, inc, { mode: 'merge' })
    expect(chosen.sections.projects!.result.activeId).toBe('p1')
  })

  it('overwrites or skips the projects section as a whole', () => {
    const cur: BackupData = { projects: { projects: [proj('p1', 'Mine')], activeId: 'p1' } }
    const inc: BackupData = { projects: { projects: [proj('p9', 'Backup')], activeId: 'p9' } }
    const over = planRestore(cur, inc, { mode: 'overwrite' })
    expect(over.sections.projects!.result).toEqual(inc.projects)
    expect(over.sections.projects!.stats).toMatchObject({ added: 1, removed: 1 })
    const skip = planRestore(cur, inc, { mode: 'selective', sections: { characters: 'merge' } })
    expect(skip.sections.projects).toBeUndefined()
  })

  it('on a history id collision the project keeps pointing at the same id (the image already on this device)', async () => {
    // 백업: 히스토리 H+1 과 그것을 채택한 프로젝트
    const src = await seeded()
    const bytes = await fullBackup(src, {
      projects: { projects: [proj('p2', 'New', { items: { k: { key: 'k', images: [{ id: H + 1, ts: 1, mark: 'adopted' }], queued: 0, generating: 0 } } })], activeId: null }
    })
    // 이 기기에도 H+1 이 있다 (같은 ms 에 만든 다른 그림이라고 해도 id 로만 구분된다)
    const dst = await fresh()
    await dst.repo.add(meta(H + 1, { prompt: 'this device' }), new Blob([png(300, 9) as BlobPart]))
    const reader = await openNaipBackup(bytesSource(bytes))
    const data = normalizeBackupData((await reader.readData()).data)
    const plan = planRestore({ projects: { projects: [], activeId: null } }, data, { mode: 'merge', hasHistory: true, hasOriginals: true })
    expect(plan.history).toEqual({ action: 'merge', originals: true })
    const r = await restoreHistorySafely(reader, historyImportPort(dst), { mode: 'merge', originals: true })
    expect(r.skippedExisting).toBe(1)
    const p = (plan.sections.projects!.result.projects as { items: Record<string, { images: { id: number }[] }> }[])[0]
    expect(p.items.k.images[0].id).toBe(H + 1)
    // → 프로젝트는 이 기기의 H+1 을 보여 준다 (다시 매기지 않는다 — 문서에 적은 동작)
    expect((await dst.repo.get(H + 1))!.prompt).toBe('this device')
  })

  it('applies projects to the store, resetting runtime counters and a dangling active id', () => {
    applyRestorePlan(
      planRestore(
        {},
        {
          projects: {
            projects: [proj('p5', 'Restored', { items: { k: { key: 'k', images: [], queued: 3, generating: 1 } } })],
            activeId: 'gone',
            create: 'not a function'
          }
        },
        { mode: 'overwrite' }
      )
    )
    const s = useProjects.getState()
    expect(s.projects.map((p) => p.id)).toEqual(['p5'])
    expect(s.projects[0].items.k).toMatchObject({ queued: 0, generating: 0 })
    expect(s.activeId).toBeNull()
    expect(typeof s.create).toBe('function')
  })
})

describe('credentials and the generation queue', () => {
  beforeEach(() => {
    useSettings.setState({ token: 'pst-SECRET123', githubToken: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', secretsLoaded: true, subscription: null })
  })

  it('never puts a token anywhere in a full backup made from the app stores', async () => {
    const src = await seeded()
    const data = collectStoreData()
    expect(Object.keys(data.settings!)).not.toContain('token')
    expect(Object.keys(data.settings!)).not.toContain('githubToken')
    expect(Object.keys(data.settings!)).not.toContain('secretsLoaded')
    const bytes = await fullBackup(src, data)
    const entries = await readAllEntries(bytes)
    expect(entries.size).toBeGreaterThan(10)
    for (const [path, body] of entries) {
      const text = Buffer.from(body).toString('latin1')
      expect(text, path).not.toContain('pst-SECRET123')
      expect(text, path).not.toContain('pst-')
      expect(text, path).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    }
    // 압축된 전체 파일에도 (보이는 글자로) 없다
    expect(Buffer.from(bytes).toString('latin1')).not.toContain('pst-SECRET123')
  })

  it('restoring settings never touches the tokens or runtime state', () => {
    const plan = planRestore({}, normalizeBackupData({ settings: { autoSave: true, token: 'pst-evil-evil-evil-evil', secretsLoaded: false, patch: 'x' } }), { mode: 'overwrite' })
    applyRestorePlan(plan)
    const s = useSettings.getState()
    expect(s.token).toBe('pst-SECRET123')
    expect(s.autoSave).toBe(true)
    expect(s.secretsLoaded).toBe(true)
    expect(typeof s.patch).toBe('function')
  })

  it('has no queue section: queue data is never written and an old queue section is skipped', async () => {
    const sink = memorySink()
    const r = await writeNaipBackup({ ...sampleData(), queue: { items: [{ base64: 'AAAA' }] } } as BackupData, sink, { mode: 'light', appVersion: '0.12.0' })
    expect(r.manifest.sections).not.toContain('queue')
    expect([...(await readAllEntries(sink.bytes())).keys()].some((p) => p.includes('queue'))).toBe(false)
    const withQueue = await rewriteZip(sink.bytes(), (path, data) =>
      path === 'manifest.json' ? utf8(JSON.stringify({ ...JSON.parse(fromUtf8(data)), sections: [...JSON.parse(fromUtf8(data)).sections, 'queue'] })) : data
    )
    const reader = await openNaipBackup(bytesSource(withQueue))
    expect(reader.unknownSections).toEqual(['queue'])
  })
})

describe('safety backups in app-private storage', () => {
  it('writes in parts, lists, reads back and prunes old ones', async () => {
    const files = memoryFileStore()
    const big = sampleData()
    // 조각이 여러 개가 되게 큰 바이브 그림
    const blob = new Uint8Array(150_000).map((_, i) => (i * 31) & 0xff)
    blob.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    ;(big.vibes!.vibes[0] as unknown as { image: string }).image = Buffer.from(blob).toString('base64')
    const names = ['before-restore-20261101-000000', 'before-restore-20261102-000000', 'before-restore-20261103-000000', 'before-restore-20261104-000000']
    for (const [i, name] of names.entries()) {
      const sink = safetySink(files, name, `복원 전 ${i}`, 64 * 1024)
      await writeNaipBackup(big, sink, { mode: 'light', appVersion: '0.12.0', createdAt: `2026-11-0${i + 1}T00:00:00.000Z` })
      expect(sink.info!.parts).toBeGreaterThan(2)
    }
    // 쓰다 만 조각 (목록 없음)
    await files.write('backups/before-restore-20261105-000000.naipbackup.p000', new Blob([new Uint8Array(10)]))
    let list = await listSafetyBackups(files)
    expect(list).toHaveLength(4)
    const reader = await openNaipBackup(safetySource(files, list[0]))
    expect((await reader.verify()).ok).toBe(true)
    expect((await reader.readData()).data.vibes!.vibes[0].image).toBe(big.vibes!.vibes[0].image)

    expect(await pruneSafetyBackups(files, 3)).toBe(1)
    list = await listSafetyBackups(files)
    expect(list.map((b) => b.name)).toEqual(names.slice(1).reverse())
    expect([...files.files.keys()].some((k) => k.includes('20261105') || k.includes('20261101'))).toBe(false)
  })

  it('removes written parts when aborted', async () => {
    const files = memoryFileStore()
    const sink = safetySink(files, 'before-restore-x', undefined, 1024)
    await sink.write(new Uint8Array(5000))
    expect(files.files.size).toBe(4)
    await sink.abort()
    expect(files.files.size).toBe(0)
    expect(await listSafetyBackups(files)).toEqual([])
  })
})
