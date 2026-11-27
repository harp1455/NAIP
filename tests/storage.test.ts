import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { HistoryMeta } from '../src/lib/db'
import { openIdb } from '../src/lib/db'
import { memoryFileStore } from '../src/storage/files'
import { createHistoryRepo, originalPath } from '../src/storage/history-repo'
import { setStorageForTests, type Storage } from '../src/storage'
import { idbLegacySource, migrateLegacy, MIGRATION_KEY } from '../src/storage/legacy'
import { createSqlJsDriver } from '../src/storage/sqljs'
import { checkStorage } from '../src/storage/check'
import { MIGRATIONS, migrate, userVersion } from '../src/storage/schema'

const THUMB = 'data:image/jpeg;base64,/9j/AAAA'

function meta(id: number, patch: Partial<HistoryMeta> = {}): HistoryMeta {
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
  }
}

function png(n: number): Blob {
  return new Blob([new Uint8Array(n).fill(7)], { type: 'image/png' })
}

async function fresh(): Promise<Storage & { files: ReturnType<typeof memoryFileStore> }> {
  const driver = await createSqlJsDriver()
  const files = memoryFileStore()
  return (await setStorageForTests(driver, files)) as Storage & { files: ReturnType<typeof memoryFileStore> }
}

describe('schema', () => {
  it('applies every migration once and records user_version', async () => {
    const driver = await createSqlJsDriver()
    expect(await migrate(driver)).toBe(MIGRATIONS.length)
    expect(await userVersion(driver)).toBe(MIGRATIONS.length)
    // 두 번 불러도 아무것도 하지 않는다
    expect(await migrate(driver)).toBe(MIGRATIONS.length)
  })

  it('refuses a database from a newer app', async () => {
    const driver = await createSqlJsDriver()
    await driver.exec('PRAGMA user_version = 99')
    await expect(migrate(driver)).rejects.toThrow(/새롭습니다/)
  })
})

describe('history repository', () => {
  let s: Awaited<ReturnType<typeof fresh>>
  beforeEach(async () => {
    s = await fresh()
  })

  it('stores the original and thumbnail as files and pages newest first', async () => {
    for (let i = 1; i <= 25; i++) await s.history.add(meta(1000 + i), png(100 + i))
    expect(s.files.files.get('images/1001.png')?.byteLength).toBe(101)
    expect(s.files.files.has('thumbs/1001.jpg')).toBe(true)
    const first = await s.history.list({}, 10)
    expect(first.map((m) => m.id)).toEqual([1025, 1024, 1023, 1022, 1021, 1020, 1019, 1018, 1017, 1016])
    expect(first[0].thumb).toBe('memory://thumbs/1025.jpg')
    const next = await s.history.list({}, 10, first[first.length - 1].id)
    expect(next[0].id).toBe(1015)
    const last = await s.history.list({}, 10, 1006)
    expect(last.map((m) => m.id)).toEqual([1005, 1004, 1003, 1002, 1001])
    expect(await s.history.count()).toBe(25)
    const blob = await s.history.readOriginal(1010, 'image/png')
    expect(blob?.size).toBe(110)
  })

  it('round-trips every HistoryMeta field, including fields it does not know', async () => {
    const m: HistoryMeta & { futureField: { a: number } } = {
      ...meta(5000),
      sceneId: 7,
      sceneName: '바다',
      fav: 1,
      snap: { base: 'b', additional: 'a', detail: 'd', negative: 'n', params: { steps: 28 }, chars: [{ name: 'c', prompt: 'p', negative: '', center: { x: 0.3, y: 0.5 } }] },
      sent: { prompt: 'sent p', negative: 'sent n', chars: [{ name: 'Alice', prompt: 'blue eyes', negative: '' }] },
      saved: 'folder/x.png',
      parentId: 4999,
      requestId: 'req-1',
      futureField: { a: 1 }
    }
    delete m.unsaved
    await s.history.add(m, png(10))
    const got = (await s.history.get(5000))!
    expect({ ...got, thumb: m.thumb }).toEqual(m)
  })

  it('filters by favorite, unsaved, scene, model, kind, lineage and date', async () => {
    await s.history.add(meta(1, { fav: 1, sceneId: 3 }), png(1))
    await s.history.add(meta(2, { kind: 'i2i', parentId: 1 }), png(1))
    await s.history.add(meta(3, { model: 'nai-diffusion-5', sceneId: 3 }), png(1))
    await s.history.add(meta(4, { unsaved: undefined, saved: 'a.png' }), png(1))
    const ids = async (q: Parameters<typeof s.history.list>[0]): Promise<number[]> => (await s.history.list(q, 100)).map((m) => m.id)
    expect(await ids({ fav: true })).toEqual([1])
    expect(await ids({ unsaved: true })).toEqual([3, 2, 1])
    expect(await ids({ sceneId: 3 })).toEqual([3, 1])
    expect(await ids({ model: 'nai-diffusion-5' })).toEqual([3])
    expect(await ids({ kind: 'i2i' })).toEqual([2])
    expect(await ids({ parentId: 1 })).toEqual([2])
    expect(await ids({ from: 2, to: 3 })).toEqual([3, 2])
    expect(await s.history.count({ sceneId: 3 })).toBe(2)
    expect(await s.history.savedCount()).toBe(1)
  })

  it('searches substrings like before: every comma term, case-insensitive, _ as space', async () => {
    await s.history.add(meta(1, { prompt: 'Blue_Eyes, beach', sceneName: '해변' }), png(1))
    await s.history.add(meta(2, { prompt: 'blue eyes, city' }), png(1))
    await s.history.add(meta(3, { prompt: 'red eyes', sent: { prompt: '', negative: '', chars: [{ name: 'Alice', prompt: 'twintails', negative: '' }] } }), png(1))
    await s.history.add(meta(4, { prompt: 'x', seed: 987654, saved: 'mine/hello.png', unsaved: undefined }), png(1))
    const ids = async (q: string): Promise<number[]> => (await s.history.list({ search: q }, 100)).map((m) => m.id)
    expect(await ids('blue ey')).toEqual([2])
    // 저장된 글은 소문자 그대로라 "blue_eyes"의 _는 그대로 남는다 (예전과 같다)
    expect(await ids('blue_eyes')).toEqual([2])
    expect(await ids('BLUE')).toEqual([2, 1])
    expect(await ids('blue, beach')).toEqual([1])
    expect(await ids('해변')).toEqual([1])
    expect(await ids('alice')).toEqual([3])
    expect(await ids('twin')).toEqual([3])
    expect(await ids('987654')).toEqual([4])
    expect(await ids('hello.png')).toEqual([4])
    expect(await ids('  ,  ')).toEqual([])
    expect(await s.history.count({ search: 'eyes' })).toBe(3)
    // 검색 페이지도 커서로 이어진다
    const page = await s.history.list({ search: 'eyes' }, 2)
    expect(page.map((m) => m.id)).toEqual([3, 2])
    expect((await s.history.list({ search: 'eyes' }, 2, 2)).map((m) => m.id)).toEqual([1])
    // 즐겨찾기 표시를 바꾸면 검색 글도 함께 바뀐다 (저장 이름)
    const m2 = (await s.history.get(2))!
    await s.history.put({ ...m2, saved: 'zzz/renamed.png' })
    expect(await ids('renamed')).toEqual([2])
  })

  it('updates flags without touching files, removes rows then files, and keeps favorites when trimming', async () => {
    await s.history.add(meta(1), png(5))
    await s.history.add(meta(2), png(5))
    await s.history.add(meta(3), png(5))
    const m1 = (await s.history.get(1))!
    await s.history.put({ ...m1, fav: 1 })
    expect((await s.history.get(1))!.fav).toBe(1)
    expect(await s.history.oldestIds(2)).toEqual([2, 3])
    await s.history.remove([2])
    expect(s.files.files.has('images/2.png')).toBe(false)
    expect(s.files.files.has('thumbs/2.jpg')).toBe(false)
    expect(await s.history.get(2)).toBeNull()
    expect((await s.history.getMany([3, 2, 1])).map((m) => m.id)).toEqual([3, 1])
    await s.history.clear()
    expect(await s.history.count()).toBe(0)
    expect(s.files.files.size).toBe(0)
  })

  it('splits long IN lists under the Android variable limit', async () => {
    for (let i = 1; i <= 30; i++) await s.history.add(meta(i), png(1))
    const ids = Array.from({ length: 1500 }, (_, i) => i + 1)
    expect((await s.history.getMany(ids)).length).toBe(30)
    await s.history.remove(ids)
    expect(await s.history.count()).toBe(0)
  })

  it('uses indexes for the paged filters', async () => {
    const plan = async (sql: string): Promise<string> =>
      (await s.driver.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)).map((r) => r.detail).join(' | ')
    expect(await plan('SELECT i.* FROM images i WHERE i.fav = 1 AND i.id < 5 ORDER BY i.id DESC LIMIT 60')).toMatch(/idx_images_fav/)
    expect(await plan('SELECT i.* FROM images i WHERE i.unsaved = 1 ORDER BY i.id DESC LIMIT 60')).toMatch(/idx_images_unsaved/)
    expect(await plan('SELECT i.* FROM images i WHERE i.scene_id = 3 ORDER BY i.id DESC LIMIT 60')).toMatch(/idx_images_scene/)
    expect(await plan('SELECT i.* FROM images i WHERE i.parent_id = 3')).toMatch(/idx_images_parent/)
    // 최신순 첫 페이지는 정렬 없이 기본 키를 거꾸로 읽는다
    expect(await plan('SELECT i.* FROM images i WHERE 1 ORDER BY i.id DESC LIMIT 60')).not.toMatch(/TEMP B-TREE/)
  })

  it('reports orphan files and broken rows without deleting anything', async () => {
    await s.history.add(meta(1), png(5))
    await s.history.add(meta(2), png(5))
    await s.files.write('images/99.png', png(9))
    await s.files.write('thumbs/98.jpg', png(1))
    await s.files.write('images/3.png.tmp', png(1))
    s.files.files.delete('images/2.png')
    s.files.files.set('images/1.png', new Uint8Array(4))
    const before = s.files.files.size
    const r = await checkStorage(s)
    expect(r.rows).toBe(2)
    expect(r.orphanOriginals).toEqual([{ path: 'images/99.png', size: 9 }])
    expect(r.orphanThumbs).toEqual(['thumbs/98.jpg'])
    expect(r.leftovers).toEqual(['images/3.png.tmp'])
    expect(r.missingOriginals).toEqual([2])
    expect(r.sizeMismatch).toEqual([1])
    expect(s.files.files.size).toBe(before)
  })
})

/** 예전 IndexedDB 히스토리에 그림을 넣는다 (v4 스키마 그대로) */
async function seedLegacy(metas: HistoryMeta[], sizes: (number | null)[]): Promise<void> {
  const db = await openIdb()
  const tx = db.transaction(['meta', 'blobs', 'text', 'kv'], 'readwrite')
  metas.forEach((m, i) => {
    tx.objectStore('meta').put(m)
    const size = sizes[i]
    if (size !== null) tx.objectStore('blobs').put(new Uint8Array(size).fill(i % 255).buffer, m.id)
    tx.objectStore('text').put(m.prompt, m.id)
  })
  tx.objectStore('kv').put('{"refs":1}', 'naip-refs')
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function legacyCounts(): Promise<{ meta: number; blobs: number; text: number; kv: number }> {
  const db = await openIdb()
  const tx = db.transaction(['meta', 'blobs', 'text', 'kv'])
  const count = (name: string): Promise<number> =>
    new Promise((resolve) => {
      const req = tx.objectStore(name).count()
      req.onsuccess = () => resolve(req.result)
    })
  return { meta: await count('meta'), blobs: await count('blobs'), text: await count('text'), kv: await count('kv') }
}

async function clearLegacy(): Promise<void> {
  const db = await openIdb()
  const tx = db.transaction(['meta', 'blobs', 'text', 'kv'], 'readwrite')
  for (const n of ['meta', 'blobs', 'text', 'kv']) tx.objectStore(n).clear()
  await new Promise<void>((resolve) => (tx.oncomplete = () => resolve()))
}

describe('IndexedDB → SQLite migration', () => {
  beforeEach(clearLegacy)

  it('copies every image, verifies sizes, then clears only the old history stores', async () => {
    const metas = Array.from({ length: 40 }, (_, i) =>
      meta(2000 + i, i === 5 ? { fav: 1, unsaved: undefined, saved: 'a/b.png' } : i === 6 ? { unsaved: undefined } : {})
    )
    const sizes = metas.map((_, i) => (i === 9 ? null : 300 + i))
    await seedLegacy(metas, sizes)
    const s = await fresh()
    const progress: string[] = []
    const r = await migrateLegacy({ storage: s, source: idbLegacySource(), freeSpace: async () => 1e12, onProgress: (p) => progress.push(p.phase) })
    expect(r).toMatchObject({ status: 'done', count: 40, missing: 1 })
    expect(await s.history.count()).toBe(40)
    expect(s.files.files.get(originalPath(2003, 'image/png'))?.byteLength).toBe(303)
    expect(s.files.files.has('images/2009.png')).toBe(false)
    expect(s.files.files.has('thumbs/2003.jpg')).toBe(true)
    const fav = (await s.history.get(2005))!
    expect(fav.fav).toBe(1)
    expect(fav.saved).toBe('a/b.png')
    expect(fav.unsaved).toBeUndefined()
    // 예전 판에서 저장 기록도 미저장 표시도 없던 것은 미저장으로 (v3 규칙)
    expect((await s.history.get(2006))!.unsaved).toBe(1)
    expect(progress).toContain('verify')
    expect(await legacyCounts()).toEqual({ meta: 0, blobs: 0, text: 0, kv: 1 })
    const [kv] = await s.driver.query<{ value: string }>('SELECT value FROM app_kv WHERE key = ?', [MIGRATION_KEY])
    expect(JSON.parse(kv.value).count).toBe(40)
  })

  it('leaves the old data untouched when it crashes midway, and resumes by id', async () => {
    const metas = Array.from({ length: 60 }, (_, i) => meta(3000 + i))
    await seedLegacy(metas, metas.map((_, i) => 100 + i))
    const s = await fresh()
    // 31번째 파일을 쓰다가 "앱이 죽는다"
    let writes = 0
    const crashing = {
      ...s.files,
      write: async (path: string, data: Blob | string): Promise<number> => {
        if (path.startsWith('images/') && ++writes > 30) throw new Error('killed')
        return s.files.write(path, data)
      }
    }
    const r1 = await migrateLegacy({ storage: { driver: s.driver, files: crashing }, source: idbLegacySource(), freeSpace: async () => 1e12 })
    expect(r1.status).toBe('failed')
    expect((await legacyCounts()).meta).toBe(60)
    const partial = await s.history.count()
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(60)
    // 다시 열면 남은 것만 옮긴다
    let rewritten = 0
    const counting = {
      ...s.files,
      write: async (path: string, data: Blob | string): Promise<number> => {
        if (path.startsWith('images/')) rewritten++
        return s.files.write(path, data)
      }
    }
    const r2 = await migrateLegacy({ storage: { driver: s.driver, files: counting }, source: idbLegacySource(), freeSpace: async () => 1e12 })
    expect(r2).toMatchObject({ status: 'done', count: 60 })
    expect(rewritten).toBe(60 - partial)
    expect(await s.history.count()).toBe(60)
    expect((await legacyCounts()).meta).toBe(0)
  })

  it('re-copies an image whose file is missing or the wrong size', async () => {
    const metas = Array.from({ length: 5 }, (_, i) => meta(4000 + i))
    await seedLegacy(metas, metas.map(() => 50))
    const s = await fresh()
    // 행은 있는데 파일이 짧은 상태 (예: 이름 바꾸기 전 죽음은 생기지 않지만 외부 손상 대비)
    await s.history.add(meta(4001), png(50))
    s.files.files.set('images/4001.png', new Uint8Array(10))
    const r = await migrateLegacy({ storage: s, source: idbLegacySource(), freeSpace: async () => 1e12 })
    expect(r.status).toBe('done')
    expect(s.files.files.get('images/4001.png')?.byteLength).toBe(50)
  })

  it('does not start without enough free space and says how much is needed', async () => {
    const metas = Array.from({ length: 10 }, (_, i) => meta(5000 + i))
    await seedLegacy(metas, metas.map(() => 1024 * 1024))
    const s = await fresh()
    const r = await migrateLegacy({ storage: s, source: idbLegacySource(), freeSpace: async () => 5 * 1024 * 1024 })
    expect(r.status).toBe('nospace')
    if (r.status === 'nospace') expect(r.need).toBeGreaterThan(10 * 1024 * 1024)
    expect(await s.history.count()).toBe(0)
    expect((await legacyCounts()).meta).toBe(10)
  })

  it('does nothing when there is no old history', async () => {
    const s = await fresh()
    expect(await migrateLegacy({ storage: s, source: idbLegacySource(), freeSpace: async () => 1e12 })).toEqual({ status: 'none' })
  })
})

describe('repository without the singleton', () => {
  it('works against any driver/file store pair', async () => {
    const driver = await createSqlJsDriver()
    await migrate(driver)
    const repo = createHistoryRepo(driver, memoryFileStore())
    await repo.add(meta(1), png(3))
    expect(await repo.count()).toBe(1)
  })
})

describe('history store on the repository', () => {
  it('pages, filters, searches and keeps counts in step with changes', async () => {
    const s = await fresh()
    const { useHistory } = await import('../src/stores/history')
    for (let i = 1; i <= 200; i++) {
      await s.history.add(meta(i, { prompt: i % 2 ? 'cat ears' : 'dog', ...(i % 50 === 0 ? { fav: 1 as const } : {}) }), png(2))
    }
    await useHistory.getState().init()
    expect(useHistory.getState().items).toHaveLength(90)
    expect(useHistory.getState().total).toBe(200)
    expect(useHistory.getState().hasMore).toBe(true)
    // 스크롤이 빨라 두 번 불려도 한 페이지만 읽는다
    await Promise.all([useHistory.getState().loadMore(), useHistory.getState().loadMore()])
    expect(useHistory.getState().items).toHaveLength(180)
    await useHistory.getState().loadMore()
    expect(useHistory.getState().items.map((m) => m.id).slice(-2)).toEqual([2, 1])
    expect(useHistory.getState().hasMore).toBe(false)

    await useHistory.getState().setFilter({ search: 'cat' })
    expect(useHistory.getState().matchCount).toBe(100)
    expect(useHistory.getState().items[0].id).toBe(199)
    await useHistory.getState().setFilter({ fav: true })
    expect(useHistory.getState().items.map((m) => m.id)).toEqual([200, 150, 100, 50])

    // 미저장만 보는 중에 저장하면 목록에서 빠지고 장수가 줄어든다
    await useHistory.getState().setFilter({ unsaved: true })
    expect(useHistory.getState().matchCount).toBe(200)
    useHistory.getState().view(200)
    await useHistory.getState().markSaved(200, 'NAIP/x.png')
    expect(useHistory.getState().items[0].id).toBe(199)
    expect(useHistory.getState().viewing).toBe(199)
    expect(useHistory.getState().matchCount).toBe(199)
    expect((await s.history.get(200))!.saved).toBe('NAIP/x.png')

    // 지우면 파일도 사라진다
    await useHistory.getState().remove([199])
    expect(useHistory.getState().total).toBe(199)
    expect(s.files.files.has('images/199.png')).toBe(false)
  })
})
