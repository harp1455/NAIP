import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 내보내기 ZIP은 메모리에 쓴다 (기기의 파일 고르기 대신)
const sinks: { name: string; sink: ReturnType<typeof import('../src/backup/io').memorySink> }[] = []
vi.mock('../src/backup/files', async () => {
  const io = await import('../src/backup/io')
  return {
    createFile: vi.fn(async (name: string) => {
      const sink = io.memorySink()
      sinks.push({ name, sink })
      return { name, ...sink, write: sink.write, close: sink.close, abort: sink.abort }
    })
  }
})

import { setStorageForTests, getStorage } from '../src/storage'
import { createSqlJsDriver } from '../src/storage/sqljs'
import { memoryFileStore } from '../src/storage/files'
import { bytesSource } from '../src/backup/io'
import { ZipReader } from '../src/backup/zip/reader'
import { expandMatrix, useProjects, type Project } from '../src/project'
import { commonFolder, exportExt, runExport } from '../src/project/save'

const project = (id: string): Project => useProjects.getState().projects.find((p) => p.id === id)!
const text = (b: Uint8Array): string => new TextDecoder('utf-8', { ignoreBOM: true }).decode(b)

beforeEach(async () => {
  sinks.length = 0
  await setStorageForTests(await createSqlJsDriver(), memoryFileStore())
  useProjects.setState({ projects: [], activeId: null, presets: [] })
})

describe('export helpers', () => {
  it('finds the common folder for the manifest', () => {
    expect(commonFolder(['봄/민지', '봄/하늘'])).toBe('봄')
    expect(commonFolder(['봄/민지', '봄/민지'])).toBe('봄/민지')
    expect(commonFolder(['a', 'b'])).toBe('')
    expect(commonFolder(['', 'a'])).toBe('')
    expect(commonFolder([])).toBe('')
  })

  it('picks the output extension from the preset or metadata stripping', () => {
    const p = { exportStripMeta: false } as Project
    expect(exportExt(p, null)).toBeUndefined()
    expect(exportExt({ ...p, exportStripMeta: true }, null)).toBe('png')
    expect(exportExt(p, { id: 'x', name: 'x', format: 'webp' })).toBe('webp')
    expect(exportExt(p, { id: 'x', name: 'x', format: 'jpeg' })).toBe('jpg')
  })
})

describe('export run (zip)', () => {
  it('writes adopted originals untouched under templated paths, a manifest and code list, and records the export', async () => {
    const s = useProjects.getState()
    const id = s.create('봄 이벤트')
    s.addCharacter(id, { name: '민지' })
    const e = s.addAxis(id, 'expression')!
    s.addValue(id, e, { label: '웃음', slug: 'smile', prompt: 'smile' })
    s.addValue(id, e, { label: '울음', slug: 'cry', prompt: 'crying' })
    const [k1, k2] = expandMatrix(project(id)).combos.map((c) => c.key)
    const { history } = await getStorage()
    const bytes = (n: number): Uint8Array<ArrayBuffer> => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n, n, n])
    for (const [img, key] of [
      [101, k1],
      [102, k2],
      [103, k2]
    ] as const) {
      await history.add(
        { id: img, ts: img, thumb: '', width: 832, height: 1216, seed: img, model: 'm', kind: 't2i', prompt: `p${img}`, negative: '', mime: 'image/png' },
        new Blob([bytes(img)], { type: 'image/png' })
      )
      s.addImage(id, key, { id: img, ts: img, seed: img, width: 832, height: 1216, mime: 'image/png' }, { fromQueue: false })
    }
    s.setMarks(id, k1, [101], 'adopted')
    s.setMarks(id, k2, [102, 103], 'adopted')

    const progress: number[] = []
    const r = await runExport(project(id), [], { target: 'zip', onlyNotExported: false, renameExported: false }, {
      signal: new AbortController().signal,
      onProgress: (done) => progress.push(done)
    })
    expect(r).toMatchObject({ saved: 3, failed: 0, skipped: 0, cancelled: false, where: '봄_이벤트.zip' })
    expect(progress.at(-1)).toBe(3)
    const zip = await ZipReader.open(bytesSource(sinks[0].sink.bytes()))
    expect([...zip.entries.keys()].sort()).toEqual(
      [
        '봄_이벤트/민지/민지_smile_01.png',
        '봄_이벤트/민지/민지_cry_01.png',
        '봄_이벤트/민지/민지_cry_02.png',
        '봄_이벤트/민지/봄_이벤트_manifest.csv',
        '봄_이벤트/민지/봄_이벤트_codes.txt'
      ].sort()
    )
    // 원본 바이트 그대로 (변환·메타데이터 제거를 고르지 않았다)
    expect([...(await zip.read('봄_이벤트/민지/민지_smile_01.png'))]).toEqual([...bytes(101)])
    const csv = text(await zip.read('봄_이벤트/민지/봄_이벤트_manifest.csv'))
    expect(csv.startsWith('﻿이미지 코드,파일 이름')).toBe(true)
    expect(csv).toContain('A001,민지_smile_01.png,봄_이벤트/민지/민지_smile_01.png,민지')
    expect(csv).toContain('A003,민지_cry_02.png')
    expect(text(await zip.read('봄_이벤트/민지/봄_이벤트_codes.txt'))).toContain('A002 | 민지 | 울음 | 민지_cry_01.png')

    const after = project(id)
    expect(after.items[k1].images[0].exported?.path).toBe('봄_이벤트/민지/민지_smile_01.png')
    expect(after.items[k2].codes).toEqual({ 1: 'A002', 2: 'A003' })
    // 원본(히스토리)은 그대로
    expect((await history.readOriginal(101, 'image/png'))?.size).toBe(7)

    // 다시 내보내면 지난 이름을 그대로 새로 쓴다
    const again = await runExport(after, [], { target: 'zip', onlyNotExported: false, renameExported: false }, { signal: new AbortController().signal, onProgress: () => {} })
    expect(again.saved).toBe(3)
    const zip2 = await ZipReader.open(bytesSource(sinks[1].sink.bytes()))
    expect(zip2.entries.has('봄_이벤트/민지/민지_cry_02.png')).toBe(true)
  })

  it('reports an image that is no longer in history instead of failing the whole export', async () => {
    const s = useProjects.getState()
    const id = s.create('빠짐')
    s.addCharacter(id, { name: 'A' })
    const key = expandMatrix(project(id)).combos[0].key
    s.addImage(id, key, { id: 555, ts: 1, mime: 'image/png' }, { fromQueue: false })
    s.setMarks(id, key, [555], 'adopted')
    const r = await runExport(project(id), [], { target: 'zip', onlyNotExported: false, renameExported: false }, { signal: new AbortController().signal, onProgress: () => {} })
    expect(r.saved).toBe(0)
    expect(r.failed).toBe(1)
    expect(r.errors[0]).toContain('원본을 찾을 수 없습니다')
  })

  it('cancelling a zip export leaves nothing recorded', async () => {
    const s = useProjects.getState()
    const id = s.create('취소')
    s.addCharacter(id, { name: 'A' })
    const key = expandMatrix(project(id)).combos[0].key
    const { history } = await getStorage()
    await history.add(
      { id: 9, ts: 9, thumb: '', width: 1, height: 1, seed: 1, model: 'm', kind: 't2i', prompt: '', negative: '', mime: 'image/png' },
      new Blob([new Uint8Array(4)], { type: 'image/png' })
    )
    s.addImage(id, key, { id: 9, ts: 9, mime: 'image/png' }, { fromQueue: false })
    s.setMarks(id, key, [9], 'adopted')
    const ac = new AbortController()
    ac.abort()
    const r = await runExport(project(id), [], { target: 'zip', onlyNotExported: false, renameExported: false }, { signal: ac.signal, onProgress: () => {} })
    expect(r.cancelled).toBe(true)
    expect(r.saved).toBe(0)
    expect(sinks[0].sink.aborted).toBe(true)
    expect(project(id).items[key].images[0].exported).toBeUndefined()
  })
})
