/// <reference types="node" />
import { createHash, randomBytes } from 'node:crypto'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import {
  BackupError,
  bytesSource,
  estimateBackupSize,
  fromLegacyNaipJson,
  memorySink,
  openAnyBackup,
  openNaipBackup,
  planRestore,
  previewRestore,
  restoreHistory,
  selectedSections,
  stripCredentials,
  writeNaipBackup,
  ZipReader,
  ZipWriter,
  type BackupData
} from '../src/backup'
import { fromUtf8, utf8 } from '../src/backup/bytes'
import { crc32, Sha256, sha256Hex } from '../src/backup/hash'
import { craftZip, readAllEntries, rewriteZip } from './helpers/zip-craft'
import { fakeHistory, GH_TOKEN, NAI_TOKEN, PNG_1X1, sampleData } from './helpers/sample'

async function expectCode(p: Promise<unknown>, code: string): Promise<BackupError> {
  try {
    await p
  } catch (error) {
    expect(error).toBeInstanceOf(BackupError)
    expect((error as BackupError).code).toBe(code)
    return error as BackupError
  }
  throw new Error(`expected BackupError(${code})`)
}

async function backupBytes(data: BackupData, opts: Partial<Parameters<typeof writeNaipBackup>[2]> = {}): Promise<Uint8Array> {
  const sink = memorySink()
  await writeNaipBackup(data, sink, { mode: 'light', appVersion: '0.12.0', createdAt: '2026-11-27T00:00:00.000Z', ...opts })
  expect(sink.closed).toBe(true)
  return sink.bytes()
}

describe('hash', () => {
  it('matches node crypto for SHA-256 across block boundaries and chunking', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 127, 128, 1000, 70_000]) {
      const data = new Uint8Array(randomBytes(n))
      const expected = createHash('sha256').update(data).digest('hex')
      expect(sha256Hex(data)).toBe(expected)
      const h = new Sha256()
      for (let i = 0; i < n; i += 7) h.update(data.subarray(i, i + 7))
      expect(h.digestHex()).toBe(expected)
    }
  })

  it('computes CRC-32', () => {
    expect(crc32(utf8('123456789'))).toBe(0xcbf43926)
  })
})

describe('zip writer/reader', () => {
  async function sample(opts: { forceZip64?: boolean } = {}): Promise<Uint8Array> {
    const sink = memorySink()
    const w = new ZipWriter(sink, opts)
    await w.add({ path: 'a.json', data: utf8('{"x":1}'.repeat(100)) })
    await w.add({ path: 'img/b.png', data: new Uint8Array(randomBytes(5000)), compress: false })
    async function* stream(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < 5; i++) yield utf8(`line ${i}\n`.repeat(50))
    }
    await w.add({ path: 'stream.txt', data: stream() })
    await w.add({ path: 'stream-stored.bin', data: stream(), compress: false })
    await w.add({ path: 'empty.txt', data: new Uint8Array(0) })
    await w.finish()
    return sink.bytes()
  }

  for (const forceZip64 of [false, true]) {
    it(`round-trips through our reader and JSZip${forceZip64 ? ' (ZIP64 records)' : ''}`, async () => {
      const bytes = await sample({ forceZip64 })
      const zip = await ZipReader.open(bytesSource(bytes))
      expect(zip.paths().sort()).toEqual(['a.json', 'empty.txt', 'img/b.png', 'stream-stored.bin', 'stream.txt'])
      expect(fromUtf8(await zip.read('a.json'))).toBe('{"x":1}'.repeat(100))
      expect(fromUtf8(await zip.read('stream.txt'))).toContain('line 4')
      const jz = await JSZip.loadAsync(bytes)
      expect(await jz.file('stream.txt')!.async('string')).toBe(fromUtf8(await zip.read('stream.txt')))
      expect(await jz.file('stream-stored.bin')!.async('string')).toBe(fromUtf8(await zip.read('stream-stored.bin')))
      expect((await jz.file('img/b.png')!.async('uint8array')).length).toBe(5000)
      expect(await jz.file('empty.txt')!.async('string')).toBe('')
    })
  }

  it('reads archives written by JSZip', async () => {
    const jz = new JSZip()
    jz.file('x/y.txt', 'hello '.repeat(1000))
    const bytes = await jz.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
    const zip = await ZipReader.open(bytesSource(bytes))
    expect(fromUtf8(await zip.read('x/y.txt'))).toBe('hello '.repeat(1000))
  })

  it('refuses unsafe paths when writing', async () => {
    const w = new ZipWriter(memorySink())
    await expectCode(w.add({ path: '../x', data: utf8('a') }), 'unsafe-path')
  })
})

describe('zip-slip and zip-bomb defenses', () => {
  const evil = ['../evil.txt', 'a/../../evil', '/etc/passwd', 'C:/x.txt', 'a\\b.txt', 'a\u0000b', 'a//b', './a']
  for (const name of evil) {
    it(`rejects ${JSON.stringify(name)}`, async () => {
      await expectCode(ZipReader.open(bytesSource(craftZip([{ name, data: utf8('x') }]))), 'unsafe-path')
    })
  }

  it('rejects duplicate entries', async () => {
    const bytes = craftZip([
      { name: 'a.txt', data: utf8('1') },
      { name: 'a.txt', data: utf8('2') }
    ])
    await expectCode(ZipReader.open(bytesSource(bytes)), 'duplicate-entry')
  })

  it('rejects too many entries / oversized entries / oversized total', async () => {
    const many = craftZip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, data: utf8('x') })))
    await expectCode(ZipReader.open(bytesSource(many), { maxEntries: 4 }), 'too-many-entries')
    const big = craftZip([{ name: 'big', data: new Uint8Array(2000) }])
    await expectCode(ZipReader.open(bytesSource(big), { maxEntrySize: 1000 }), 'entry-too-large')
    const two = craftZip([
      { name: 'a', data: new Uint8Array(600) },
      { name: 'b', data: new Uint8Array(600) }
    ])
    await expectCode(ZipReader.open(bytesSource(two), { maxTotalSize: 1000 }), 'total-too-large')
  })

  it('rejects a suspicious compression ratio before inflating', async () => {
    const bomb = craftZip([{ name: 'zeros.json', data: new Uint8Array(4 * 1024 * 1024), method: 8 }])
    await expectCode(ZipReader.open(bytesSource(bomb)), 'suspicious-ratio')
  })

  it('stops inflating as soon as data exceeds the declared size', async () => {
    // 100 바이트라고 속이고 2MB 가 풀리는 항목
    const liar = craftZip([{ name: 'liar.bin', data: new Uint8Array(2 * 1024 * 1024), method: 8, declaredSize: 100 }])
    const zip = await ZipReader.open(bytesSource(liar))
    await expectCode(zip.read('liar.bin'), 'size-mismatch')
  })

  it('rejects overlapping entries (several names for the same data)', async () => {
    const bytes = craftZip([
      { name: 'a.bin', data: new Uint8Array(100) },
      { name: 'b.bin', data: new Uint8Array(100), pointTo: 0 }
    ])
    await expectCode(ZipReader.open(bytesSource(bytes)), 'overlapping-entries')
  })

  it('rejects encrypted entries and CRC mismatches', async () => {
    await expectCode(ZipReader.open(bytesSource(craftZip([{ name: 'e', data: utf8('x'), flags: 0x0801 }]))), 'encrypted')
    const zip = await ZipReader.open(bytesSource(craftZip([{ name: 'c', data: utf8('hello'), crc: 1234 }])))
    await expectCode(zip.read('c'), 'crc-mismatch')
  })

  it('rejects non-zip input', async () => {
    await expectCode(ZipReader.open(bytesSource(utf8('{"not":"zip"} padding padding padding'))), 'not-zip')
  })
})

describe('credentials', () => {
  it('strips tokens by key and by value shape, but keeps data-keyed maps', () => {
    const { value, removed } = stripCredentials(sampleData())
    const settings = value.settings as Record<string, unknown>
    expect(settings.token).toBeUndefined()
    expect(settings.githubToken).toBeUndefined()
    expect((settings.nested as Record<string, unknown>).apiKey).toBeUndefined()
    expect((settings.nested as Record<string, unknown>).note).toBe('')
    expect((settings.nested as Record<string, unknown>).label).toBe('ok')
    expect(Object.keys(value.tagUsage!.entries)).toEqual(['1girl', 'secret', 'token'])
    expect(removed).toEqual(expect.arrayContaining(['settings.token', 'settings.githubToken', 'settings.nested.apiKey', 'settings.nested.note']))
  })

  it('never writes a token into any archive entry', async () => {
    const bytes = await backupBytes(sampleData(), { mode: 'full', history: fakeHistory(2) })
    const entries = await readAllEntries(bytes)
    expect(entries.size).toBeGreaterThan(5)
    for (const [path, data] of entries) {
      const text = Buffer.from(data).toString('latin1')
      expect(text, path).not.toContain(NAI_TOKEN)
      expect(text, path).not.toContain(GH_TOKEN)
      expect(text, path).not.toContain('githubToken')
      expect(text, path).not.toContain('apiKey')
      // tagUsage 의 "token" 은 태그 이름(데이터)이라 남는다 — 설정에서는 키가 없어야 한다
      if (path === 'sections/settings.json') expect(text).not.toMatch(/"token"\s*:/)
    }
  })

  it('strips tokens smuggled into a backup on read', async () => {
    const bytes = await backupBytes({ settings: { autoSave: true } })
    const evil = await rewriteZip(bytes, (path, data) => {
      if (path !== 'sections/settings.json') return data
      return utf8(JSON.stringify({ autoSave: true, token: 'pst-evil', githubToken: 'x' }))
    })
    // 내용을 바꿨으니 체크섬 목록도 새로 맞춰 준다 (조작자가 할 수 있는 일)
    const fixed = await rewriteZip(evil, (path, data) => {
      if (path !== 'checksums.json') return data
      const sums = JSON.parse(fromUtf8(data))
      const body = utf8(JSON.stringify({ autoSave: true, token: 'pst-evil', githubToken: 'x' }))
      sums['sections/settings.json'] = { sha256: sha256Hex(body), size: body.byteLength }
      return utf8(JSON.stringify(sums))
    })
    const reader = await openNaipBackup(bytesSource(fixed))
    const { data, removedCredentials } = await reader.readData()
    expect(data.settings).toEqual({ autoSave: true })
    expect(removedCredentials).toEqual(['settings.token', 'settings.githubToken'])
  })
})

describe('NAIP backup format', () => {
  it('round-trips every section and the history (full mode)', async () => {
    const src = sampleData()
    const history = fakeHistory(7, 3)
    const progress: number[] = []
    const sink = memorySink()
    const result = await writeNaipBackup(src, sink, {
      mode: 'full',
      appVersion: '0.12.0',
      createdAt: '2026-11-27T00:00:00.000Z',
      history,
      historyPageSize: 3,
      onProgress: (p) => progress.push(p.done)
    })
    expect(result.skippedOriginals).toBe(1)
    expect(result.manifest.counts).toMatchObject({ history: 7, historyOriginals: 6, characters: 2, vibes: 2, presets: 2 })
    expect(progress.at(-1)).toBe(result.manifest.sections.length - 2 + 7)

    const reader = await openNaipBackup(bytesSource(sink.bytes()))
    expect(reader.manifest).toMatchObject({ format: 'NAIP', formatVersion: 1, mode: 'full', appVersion: '0.12.0' })
    expect(reader.structuralProblems).toEqual([])
    const { data, problems } = await reader.readData()
    expect(problems).toEqual([])
    const expected = stripCredentials(src).value
    expect(data).toEqual(expected)

    // 그림은 따로 무압축 항목으로 들어간다
    const paths = reader.zip.paths()
    expect(paths).toEqual(expect.arrayContaining(['assets/vibes/0-81.png', 'assets/charrefs/0-91.png', 'assets/masks/0-101.png']))
    expect(reader.zip.entry('assets/vibes/0-81.png').method).toBe(0)

    // 히스토리: 기록은 페이지로, 원본은 한 장씩
    const target = fakeHistory(0)
    const restored = await restoreHistory(reader, target, { mode: 'replace', originals: true })
    expect(restored).toMatchObject({ added: 7, missingOriginals: 1, failed: 0 })
    for (const [id, r] of history.records) {
      expect(target.records.get(id)!.record).toEqual(r.record)
      expect(target.records.get(id)!.original).toEqual(r.original)
    }
    expect((await reader.verify()).ok).toBe(true)
  })

  it('merges history by skipping existing ids', async () => {
    const bytes = await backupBytes({}, { mode: 'full', history: fakeHistory(4) })
    const reader = await openNaipBackup(bytesSource(bytes))
    const target = fakeHistory(2)
    const r = await restoreHistory(reader, target, { mode: 'merge', originals: false })
    expect(r).toMatchObject({ added: 2, skippedExisting: 2 })
    expect(target.records.size).toBe(4)
  })

  it('selects sections by mode', async () => {
    expect(selectedSections('light')).not.toContain('history')
    expect(selectedSections('full')).toContain('historyOriginals')
    expect(selectedSections('custom', ['presets', 'historyOriginals'])).toEqual(['presets', 'history', 'historyOriginals'])
    const bytes = await backupBytes(sampleData(), { mode: 'custom', sections: ['presets', 'history'], history: fakeHistory(2) })
    const reader = await openNaipBackup(bytesSource(bytes))
    expect(reader.manifest.sections).toEqual(['presets', 'history'])
    expect(reader.zip.paths().some((p) => p.startsWith('history/originals/'))).toBe(false)
    const est = await estimateBackupSize(sampleData(), { mode: 'full', history: fakeHistory(3) })
    expect(est.bytes).toBeGreaterThan(3000)
    expect(est.sections.historyOriginals).toBeGreaterThan(3000)
  })

  it('reports checksum mismatches per entry and skips damaged sections', async () => {
    const bytes = await backupBytes(sampleData())
    const tampered = await rewriteZip(bytes, (path, data) => {
      if (path === 'sections/presets.json') return utf8(fromUtf8(data).replace('lowres', 'LOWRES'))
      if (path === 'assets/vibes/0-81.png') return data.map((b, i) => (i === 20 ? b ^ 0xff : b))
      return data
    })
    const reader = await openNaipBackup(bytesSource(tampered))
    const report = await reader.verify()
    expect(report.ok).toBe(false)
    expect(report.problems.map((p) => [p.path, p.kind]).sort()).toEqual([
      ['assets/vibes/0-81.png', 'checksum-mismatch'],
      ['sections/presets.json', 'checksum-mismatch']
    ])
    const { data, problems } = await reader.readData()
    expect(data.presets).toBeUndefined()
    expect(data.characters).toBeDefined()
    // 손상된 바이브 그림은 비우고 어느 바이브인지 알린다
    expect(data.vibes!.vibes[0].image).toBe('')
    expect(problems.some((p) => p.detail.includes('"수채화"'))).toBe(true)
    expect(problems.some((p) => p.path === 'sections/presets.json')).toBe(true)
  })

  it('reports entries missing from the archive or from the checksum list', async () => {
    const bytes = await backupBytes(sampleData())
    const dropped = await rewriteZip(bytes, (path, data) => (path === 'sections/masks.json' ? null : data))
    // 체크섬 목록에 없는 항목을 하나 끼워 넣는다
    const src = await ZipReader.open(bytesSource(dropped))
    const sink = memorySink()
    const w = new ZipWriter(sink)
    for (const path of src.paths()) await w.add({ path, data: await src.read(path) })
    await w.add({ path: 'sections/sneaky.json', data: utf8('{}') })
    await w.finish()
    const reader = await openNaipBackup(bytesSource(sink.bytes()))
    expect(reader.structuralProblems.map((p) => [p.path, p.kind]).sort()).toEqual([
      ['sections/masks.json', 'missing'],
      ['sections/sneaky.json', 'unlisted']
    ])
    const { data } = await reader.readData()
    expect(data.masks).toBeUndefined()
  })

  it('refuses newer format versions with a clear message', async () => {
    const bytes = await backupBytes({ presets: { presets: [] } })
    const newer = await rewriteZip(bytes, (path, data) => {
      if (path !== 'manifest.json') return data
      return utf8(JSON.stringify({ ...JSON.parse(fromUtf8(data)), formatVersion: 2 }))
    })
    const err = await expectCode(openNaipBackup(bytesSource(newer)), 'unsupported-version')
    expect(err.message).toContain('버전 2')
    expect(err.message).toContain('업데이트')
    const broken = await rewriteZip(bytes, (path, data) => (path === 'manifest.json' ? utf8(JSON.stringify({ format: 'NAIP', formatVersion: 'x', sections: [] })) : data))
    await expectCode(openNaipBackup(bytesSource(broken)), 'invalid-manifest')
    const nais = await rewriteZip(bytes, (path, data) => (path === 'manifest.json' ? utf8(JSON.stringify({ format: 'NAIS', app: 'NAIS3' })) : data))
    await expectCode(openNaipBackup(bytesSource(nais)), 'is-nais3')
  })

  it('aborts cleanly and removes the partial file', async () => {
    const ctrl = new AbortController()
    const sink = memorySink()
    const p = writeNaipBackup(sampleData(), sink, {
      mode: 'full',
      appVersion: '0.12.0',
      history: fakeHistory(5),
      signal: ctrl.signal,
      onProgress: (x) => x.phase === 'originals' && ctrl.abort()
    })
    await expectCode(p, 'aborted')
    expect(sink.aborted).toBe(true)
    expect(sink.closed).toBe(false)
  })

  it('opens old NAIP JSON backups', async () => {
    const old = {
      app: 'naip',
      version: 2,
      prompt: { base: 'a', additional: '', detail: '', negative: '', params: {}, presets: [{ id: 1, name: 'p' }] },
      characters: { folders: [], characters: [{ id: 2, name: 'c' }], cast: [] },
      fragments: { folders: [], fragments: [] },
      scenes: { folders: [], scenes: [] }
    }
    const opened = await openAnyBackup(bytesSource(utf8(JSON.stringify(old))))
    expect(opened.kind).toBe('naip-json')
    expect(fromLegacyNaipJson(old)).toMatchObject({ prompt: { base: 'a' }, presets: { presets: [{ id: 1 }] }, characters: { characters: [{ id: 2 }] } })
    const naip = await openAnyBackup(bytesSource(await backupBytes(sampleData())))
    expect(naip.kind).toBe('naip')
  })
})

describe('restore planning', () => {
  const current = (): BackupData => ({
    presets: { presets: [{ id: 11, name: '기본', base: 'changed', detail: '', negative: '', params: {} }] },
    prompt: { base: 'now', activePresetId: 11 },
    characters: {
      folders: [{ id: 21, name: '다른 폴더' }],
      characters: [
        { id: 31, name: 'Alice', folderId: 21, prompt: '1girl', negative: '' },
        { id: 40, name: 'Bob', folderId: null, prompt: 'other bob', negative: '' }
      ],
      cast: [{ charId: 40, enabled: true, center: null }]
    },
    scenes: { folders: [], scenes: [{ id: 59, name: '기존 씬', folderId: null, cast: [40], reserve: 0 }] },
    tagUsage: { entries: { '1girl': { n: 5, last: 10 }, solo: { n: 1, last: 1 } } },
    saveFolders: { saveFolders: ['a', 'z'], nameCounters: { 'a/alice': 7, 'z/x': 1 } }
  })

  it('overwrites sections with backup contents', () => {
    const plan = planRestore(current(), sampleData(), { mode: 'overwrite' })
    expect(plan.sections.characters!.result).toEqual(sampleData().characters)
    expect(plan.sections.characters!.stats).toMatchObject({ added: 1, replaced: 1, removed: 1 })
    expect(plan.sections.presets!.stats).toMatchObject({ replaced: 1, added: 1 })
    expect(plan.history).toBeNull()
  })

  it('merges with new ids on id conflicts, renames on name conflicts and fixes references', () => {
    let next = 1000
    const plan = planRestore(current(), sampleData(), { mode: 'merge', newId: () => ++next })
    const ch = plan.sections.characters!
    // 프리셋이 먼저 처리돼 1001 을 받는다. 폴더 21 은 이름이 달라 내용 충돌 → 새 id 1002, 이름은 그대로
    const folders = ch.result.folders as { id: number; name: string }[]
    expect(folders).toEqual([
      { id: 21, name: '다른 폴더' },
      { id: 1002, name: '주인공' }
    ])
    const chars = ch.result.characters as { id: number; name: string; folderId: number | null }[]
    // Alice(31): folderId 가 1002 로 바뀌어 지금 Alice 와 내용이 다름 → 새 id 1003, 같은 폴더가 아니므로 이름 유지
    expect(chars.find((c) => c.id === 1003)).toMatchObject({ name: 'Alice', folderId: 1002 })
    // Bob(32): 새 id 충돌은 없지만 같은 범위(미분류)에 Bob 이 있어 이름이 바뀜
    expect(chars.find((c) => c.id === 32)).toMatchObject({ name: 'Bob (2)', folderId: null })
    expect(ch.stats).toMatchObject({ added: 3, reassigned: 2, idConflicts: 2, renamed: 1 })
    // 합치기에서 출연·불투명 필드는 지금 것이 우선, 지금 없는 필드(slots)는 백업에서
    expect(ch.result.cast).toEqual(current().characters!.cast)
    expect(ch.result.slots).toEqual({ opaque: true })

    // 씬의 출연·위치가 바뀐 캐릭터 id 를 따라간다
    const scenes = plan.sections.scenes!.result.scenes as { id: number; cast?: number[]; castCenters?: Record<string, unknown> }[]
    const beach = scenes.find((s) => s.id === 51)!
    expect(beach.cast).toEqual([1003, 32])
    expect(Object.keys(beach.castCenters!)).toEqual(['1003'])

    // 프리셋 11 은 내용이 달라 새 id, 이름 "기본" 은 "기본 (2)"
    const presets = plan.sections.presets!.result.presets as { id: number; name: string }[]
    expect(presets.map((p) => p.name)).toEqual(['기본', '기본 (2)', 'V5'])
    // 작업 중인 프롬프트는 합치기에서 지금 것을 유지 (안내 문구)
    expect(plan.sections.prompt!.result).toMatchObject({ base: 'now', activePresetId: 11 })
    expect(plan.sections.prompt!.notes[0]).toContain('지금 값을 유지')

    // 태그 기록은 합치고, 저장 폴더는 합집합, 번호는 큰 쪽
    const entries = plan.sections.tagUsage!.result.entries as Record<string, { n: number; last: number }>
    expect(Object.keys(entries).sort()).toEqual(['1girl', 'secret', 'solo', 'token'])
    expect(entries['1girl']).toMatchObject({ n: 5, last: 100 })
    expect(plan.sections.saveFolders!.result).toMatchObject({ saveFolders: ['a', 'z', 'b'], nameCounters: { 'a/alice': 7, 'z/x': 1 } })
  })

  it('treats identical items as duplicates', () => {
    const data = sampleData()
    const plan = planRestore(data, data, { mode: 'merge' })
    expect(plan.sections.characters!.stats).toMatchObject({ identical: 3, added: 0, renamed: 0, reassigned: 0 })
    expect(plan.sections.characters!.result.characters).toEqual(data.characters!.characters)
    expect(plan.sections.vibes!.result.vibes).toEqual(data.vibes!.vibes)
  })

  it('applies selective per-section actions and warns about dangling references', () => {
    const plan = planRestore(current(), sampleData(), {
      mode: 'selective',
      sections: { characters: 'overwrite', fragments: 'merge', history: 'merge' },
      hasHistory: true,
      hasOriginals: true
    })
    expect(Object.keys(plan.sections).sort()).toEqual(['characters', 'fragments'])
    // 지금 씬은 남는데, 그 씬이 가리키던 Bob(40) 은 덮어쓴 캐릭터에서 사라진다
    expect(plan.warnings).toHaveLength(1)
    expect(plan.warnings[0]).toContain('씬')
    expect(plan.history).toEqual({ action: 'merge', originals: true })
    const noOriginals = planRestore({}, {}, { mode: 'overwrite', sections: { historyOriginals: 'skip' }, hasHistory: true, hasOriginals: true })
    expect(noOriginals.history).toEqual({ action: 'replace', originals: false })
  })

  it('drops references to items that will not exist', () => {
    const incoming: BackupData = {
      characters: { folders: [], characters: [{ id: 1, name: 'A', folderId: 999 }], cast: [{ charId: 1 }, { charId: 77 }] },
      prompt: { activePresetId: 5 }
    }
    const plan = planRestore({}, incoming, { mode: 'overwrite' })
    expect(plan.sections.characters!.result).toEqual({ folders: [], characters: [{ id: 1, name: 'A', folderId: null }], cast: [{ charId: 1 }] })
    expect(plan.sections.characters!.stats.dangling).toBe(2)
    expect(plan.sections.prompt!.result.activePresetId).toBeNull()
  })

  it('previews contents and conflicts', () => {
    const preview = previewRestore(current(), sampleData())
    const ch = preview.find((p) => p.section === 'characters')!
    expect(ch).toMatchObject({ incoming: 2, current: 2, idConflicts: 2, nameConflicts: 1, newItems: 1, removedOnOverwrite: 1 })
    expect(ch.conflicts.map((c) => c.kind).sort()).toEqual(['new-id', 'new-id', 'renamed'])
    expect(preview.find((p) => p.section === 'queue')!.mergeable).toBe(false)
    expect(preview.map((p) => p.section)).toContain('vibes')
  })

  it('keeps images in planned vibes untouched (plain data in/out)', () => {
    const plan = planRestore({}, sampleData(), { mode: 'merge' })
    expect((plan.sections.vibes!.result.vibes as { image: string }[])[0].image).toBe(PNG_1X1)
  })
})
