/**
 * 갤러리(휴대폰) 내보내기 회귀 테스트 — 네이티브 저장은 메모리 갤러리로 흉내 낸다 (실제 기기·네트워크 없음)
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** 메모리 갤러리 — 경로(대소문자 무시) → 저장한 파일 */
const gallery = new Map<string, { path: string; bytes: number }>()
/** Download/NAIP 아래 글 파일 */
const texts = new Map<string, string>()
/** 저장할 때마다 부르는 훅 (도중 취소·기록 확인용) */
let onSave: ((path: string) => void) | null = null

vi.mock('../src/lib/native', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/lib/native')>()
  return {
    ...orig,
    listSavedImages: vi.fn(async () => [...gallery.values()].map((g) => g.path)),
    saveImageAt: vi.fn(async (blob: Blob, folder: string, fileName: string, overwrite = false) => {
      let path = folder ? `${folder}/${fileName}` : fileName
      let name = fileName
      let renamed = false
      if (gallery.has(path.toLowerCase()) && !overwrite) {
        // MediaStore처럼 "이름 (1).확장자"
        name = fileName.replace(/(\.[^.]+)$/, ' (1)$1')
        path = folder ? `${folder}/${name}` : name
        renamed = true
      }
      const had = gallery.has(path.toLowerCase())
      gallery.set(path.toLowerCase(), { path, bytes: blob.size })
      onSave?.(path)
      return { uri: `content://${path}`, name, path, overwritten: had, renamed }
    }),
    saveTextAt: vi.fn(async (text: string, _mime: string, folder: string, fileName: string) => {
      const path = folder ? `${folder}/${fileName}` : fileName
      texts.set(path, text)
      return { uri: `content://${path}`, name: fileName, path, overwritten: false, renamed: false }
    })
  }
})

// ZIP은 메모리에 쓴다 (기기의 파일 고르기 대신)
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
import * as db from '../src/lib/db'
import { useHistory } from '../src/stores/history'
import { expandMatrix, planExport, useProjects, type Project } from '../src/project'
import { tagHistoryImages } from '../src/project/assign'
import { runExport, type ExportSettings } from '../src/project/save'

const project = (id: string): Project => useProjects.getState().projects.find((p) => p.id === id)!
const all: ExportSettings = { target: 'gallery', onlyNotExported: false, renameExported: false }
const run = (id: string, s: ExportSettings = all, signal = new AbortController().signal) =>
  runExport(project(id), [], s, { signal, onProgress: () => {} })
const rows = (csv: string): string[] => csv.replace(/^﻿/, '').trim().split('\r\n').slice(1)

beforeEach(async () => {
  gallery.clear()
  texts.clear()
  sinks.length = 0
  onSave = null
  await setStorageForTests(await createSqlJsDriver(), memoryFileStore())
  useProjects.setState({ projects: [], activeId: null, presets: [] })
  useHistory.setState({ items: [] })
})

async function addHistory(id: number, extra: Partial<db.HistoryMeta> = {}): Promise<void> {
  const { history } = await getStorage()
  await history.add(
    { id, ts: id, thumb: '', width: 832, height: 1216, seed: id, model: 'm', kind: 't2i', prompt: `p${id}`, negative: '', mime: 'image/png', ...extra },
    new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, id % 256])], { type: 'image/png' })
  )
}

/** 프로젝트 하나에 그림을 넣고 채택 — 조합 키 → 그림 id들 */
async function adopt(id: string, key: string, ids: number[]): Promise<void> {
  const s = useProjects.getState()
  for (const img of ids) {
    await addHistory(img)
    s.addImage(id, key, { id: img, ts: img, seed: img, width: 832, height: 1216, mime: 'image/png' }, { fromQueue: false })
  }
  s.setMarks(id, key, ids, 'adopted')
}

function setup(name: string, expressions: string[] = ['웃음', '울음']): { id: string; keys: string[] } {
  const s = useProjects.getState()
  const id = s.create(name)
  s.addCharacter(id, { name: '민지' })
  const e = s.addAxis(id, 'expression')!
  for (const label of expressions) s.addValue(id, e, { label, prompt: label })
  return { id, keys: expandMatrix(project(id)).combos.map((c) => c.key) }
}

describe('gallery export', () => {
  it('keeps earlier exports in the manifest and code list after an "only new" export', async () => {
    const { id, keys } = setup('봄')
    await adopt(id, keys[0], [101])
    await adopt(id, keys[1], [102])
    const first = await run(id)
    expect(first).toMatchObject({ saved: 2, failed: 0 })
    const manifestPath = [...texts.keys()].find((k) => k.endsWith('_manifest.csv'))!
    expect(rows(texts.get(manifestPath)!)).toHaveLength(2)

    await adopt(id, keys[0], [103])
    const next = await run(id, { ...all, onlyNotExported: true })
    expect(next).toMatchObject({ saved: 1, failed: 0 })
    const csv = rows(texts.get(manifestPath)!)
    expect(csv).toHaveLength(3)
    expect(csv.map((r) => r.split(',')[0]).sort()).toEqual(['A001', 'A002', 'A003'])
    const codes = texts.get(manifestPath.replace('_manifest.csv', '_codes.txt'))!
    expect(codes.trim().split('\n')).toHaveLength(3)
  })

  it('records each saved file at once and keeps numbering for files that were never saved', async () => {
    const { id, keys } = setup('취소', ['웃음'])
    await adopt(id, keys[0], [201, 202, 203])
    const ac = new AbortController()
    onSave = () => ac.abort()
    const r = await run(id, all, ac.signal)
    expect(r).toMatchObject({ saved: 1, cancelled: true })
    onSave = null
    expect(project(id).items[keys[0]].images[0].exported?.path).toBe('취소/민지/민지_웃음_01.png')
    // 저장하지 못한 두 장의 번호(_02, _03)는 남기지 않는다
    expect(project(id).exportCounters).toEqual({ [`combination:${keys[0]}`]: 1 })
    const rest = planExport(project(id), { onlyNotExported: true, existing: [...gallery.values()].map((g) => g.path) })
    expect(rest.entries.map((e) => e.path.fileName)).toEqual(['민지_웃음_02.png', '민지_웃음_03.png'])
    // 두 번째 실행이 첫 장을 "다른 앱 파일"로 보고 _2를 만들지 않는다
    const again = planExport(project(id), { existing: [...gallery.values()].map((g) => g.path) })
    expect(again.entries[0].path).toMatchObject({ path: '취소/민지/민지_웃음_01.png', status: 'update' })
  })

  it('records an export before the next file is saved', async () => {
    const { id, keys } = setup('기록', ['웃음'])
    await adopt(id, keys[0], [301, 302])
    const seen: (string | undefined)[] = []
    onSave = (path) => {
      if (path.endsWith('_02.png')) seen.push(project(id).items[keys[0]].images.find((i) => i.id === 301)?.exported?.path)
    }
    await run(id)
    expect(seen).toEqual(['기록/민지/민지_웃음_01.png'])
  })

  it('never lets two adopted images of one run overwrite each other', async () => {
    const { id, keys } = setup('겹침', ['웃음'])
    useProjects.getState().patch(id, { naming: { ...project(id).naming, fileTemplate: '{character}_{emotion}', duplicate: 'overwrite' } })
    await adopt(id, keys[0], [401, 402])
    const r = await run(id)
    expect(r).toMatchObject({ saved: 2, failed: 0 })
    const paths = project(id).items[keys[0]].images.map((i) => i.exported?.path)
    expect(new Set(paths).size).toBe(2)
    expect([...gallery.values()].map((g) => g.path).sort()).toEqual(['겹침/민지/민지_웃음.png', '겹침/민지/민지_웃음_2.png'])
  })

  it('keeps a character\'s code letter after characters are reordered', async () => {
    const s = useProjects.getState()
    const id = s.create('글자')
    const minji = s.addCharacter(id, { name: '민지' })!
    const haneul = s.addCharacter(id, { name: '하늘' })!
    const e = s.addAxis(id, 'expression')!
    s.addValue(id, e, { label: '웃음', prompt: 'smile' })
    const key = (charId: string): string => expandMatrix(project(id)).combos.find((c) => c.character?.id === charId)!.key
    await adopt(id, key(minji), [501])
    await adopt(id, key(haneul), [502])
    await run(id)
    expect(project(id).items[key(haneul)].codes).toEqual({ 1: 'B001' })
    expect(project(id).characters.map((c) => c.code)).toEqual(['A', 'B'])
    // 하늘을 앞으로 옮긴 뒤 하늘에 한 장 더 채택
    s.moveCharacter(id, haneul, -1)
    await adopt(id, key(haneul), [503])
    const plan = planExport(project(id), { onlyNotExported: true })
    expect(plan.newCodes.map((c) => c.code)).toEqual(['B002'])
  })
})

describe('zip export', () => {
  it('does not fail the whole ZIP when two images of one run would get the same name under "overwrite"', async () => {
    const { id, keys } = setup('압축', ['웃음'])
    useProjects.getState().patch(id, { naming: { ...project(id).naming, fileTemplate: '{character}_{emotion}', duplicate: 'overwrite' } })
    await adopt(id, keys[0], [601, 602])
    const r = await run(id, { ...all, target: 'zip' })
    expect(r.errors).toEqual([])
    expect(r.saved).toBe(2)
    const zip = await ZipReader.open(bytesSource(sinks[0].sink.bytes()))
    expect([...zip.entries.keys()].filter((k) => k.endsWith('.png')).sort()).toEqual(['압축/민지/민지_웃음.png', '압축/민지/민지_웃음_2.png'])
  })
})

describe('classifying history images', () => {
  it('adds only the project tag to the current meta and to the open history list', async () => {
    await addHistory(701)
    const tag = { projectId: 'P', key: 'character:x', coords: { character: 'x' } }
    // 히스토리 화면이 열어 둔 사본 (분류 시트가 살펴본 때의 meta)
    useHistory.setState({ items: [(await db.getMeta(701))!] })
    // 살펴본 뒤 자동 저장이 저장 표시를 남겼다
    await useHistory.getState().markSaved(701, 'NAIP/a.png')
    const tagged = await tagHistoryImages([{ id: 701, tag }])
    expect(tagged.map((m) => m.id)).toEqual([701])
    expect(await db.getMeta(701)).toMatchObject({ saved: 'NAIP/a.png', project: tag })
    expect(useHistory.getState().items[0].project).toEqual(tag)
    // 즐겨찾기를 눌러도 분류 표시가 지워지지 않는다
    await useHistory.getState().toggleFav(701)
    expect(await db.getMeta(701)).toMatchObject({ fav: 1, saved: 'NAIP/a.png', project: tag })
  })
})
