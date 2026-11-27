import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NAMING,
  assignImageCodes,
  buildCodeList,
  buildManifest,
  columnSpecs,
  createProject,
  csvField,
  expandMatrix,
  formatDate,
  letterCode,
  manifestRows,
  planExport,
  previewPaths,
  projectCodeList,
  projectColumns,
  renderTemplate,
  sanitizeName,
  toCsv,
  toMarkdown,
  toTxt,
  toJson,
  truncateName,
  type NamingItem,
  type NamingSettings,
  type Project
} from '../src/project'
import { addImage, emptyItem, replaceAdopted, setMarks, setSlotCodes, markExported } from '../src/project/curation'

describe('template rendering', () => {
  const d = new Date(2026, 10, 27, 9, 5, 7)

  it('fills variables with format specs', () => {
    const vars = { index: 7, seed: 42, date: d, time: d, character: 'Minji', name: '가나다라마' }
    expect(renderTemplate('{index:03}_{index}_{seed:6}', vars).text).toBe('007_7_000042')
    expect(renderTemplate('{date}-{date:YYYY-MM-DD}-{time}-{time:HHmm}', vars).text).toBe('20261127-2026-11-27-090507-0905')
    expect(renderTemplate('{character:upper}/{character:lower}/{name:3}', vars).text).toBe('MINJI/minji/가나다')
    expect(renderTemplate('{{literal}} {INDEX}', vars).text).toBe('{literal} 7')
    expect(formatDate(d, 'YY.MM.DD HH:mm:ss')).toBe('26.11.27 09:05:07')
  })

  it('reports unknown variables and collapses empty ones with their separator', () => {
    const r = renderTemplate('{character}_{location}_{nope}_{index:02}', { character: '민지', location: '', index: 1 }, { collapse: true })
    expect(r.text).toBe('민지_01')
    expect(r.unknown).toEqual(['nope'])
    expect(renderTemplate('{a}-{b}-{c}', { a: '', b: 'x', c: '' }, { collapse: true }).text).toBe('x')
    expect(renderTemplate('{a} {b}', { a: 'x', b: '' }).text).toBe('x ')
  })
})

describe('name sanitization', () => {
  it('follows cleanFileName rules and handles Korean safely', () => {
    expect(sanitizeName('민지: 교복/여름?')).toBe('민지_ 교복_여름_')
    expect(sanitizeName('  ..하늘..  ')).toBe('하늘')
    expect(sanitizeName('a\u0000b\u200bc\td  e')).toBe('a_bc_d e')
    // NFD로 들어온 한글도 NFC로 맞춘다
    expect(sanitizeName('\u1100\u1161')).toBe('\uac00')
    expect(sanitizeName('con')).toBe('con_')
    expect(sanitizeName('NUL.txt')).toBe('NUL.txt_')
    expect(sanitizeName('...')).toBe('')
  })

  it('limits by characters and UTF-8 bytes without splitting characters', () => {
    const long = '가'.repeat(100)
    expect([...sanitizeName(long)].length).toBe(66) // 80자는 240바이트라 200바이트로 줄어든다
    expect(sanitizeName(long, { maxLength: 10 })).toBe('가'.repeat(10))
    expect(sanitizeName('a'.repeat(100))).toHaveLength(80)
    expect(truncateName('😀😀😀', 2, 100)).toBe('😀😀')
    expect(truncateName('😀😀😀', 10, 9)).toBe('😀😀')
  })
})

function settings(p: Partial<NamingSettings> = {}): NamingSettings {
  return { ...DEFAULT_NAMING, rootFolder: '', folderTemplate: '{character}', fileTemplate: '{character}_{emotion}_{index:03}', ...p }
}

const items: NamingItem[] = [
  { id: 1, vars: { character: '민지', emotion: '웃음' }, ext: 'png', characterKey: 'A', comboKey: 'A-smile' },
  { id: 2, vars: { character: '민지', emotion: '웃음' }, ext: 'png', characterKey: 'A', comboKey: 'A-smile' },
  { id: 3, vars: { character: '민지', emotion: '울음' }, ext: 'png', characterKey: 'A', comboKey: 'A-cry' },
  { id: 4, vars: { character: '하늘', emotion: '웃음' }, ext: 'png', characterKey: 'B', comboKey: 'B-smile' }
]

describe('path preview', () => {
  it('numbers per scope from the start number', () => {
    const paths = (p: Partial<NamingSettings>): string[] => previewPaths(items, settings(p)).entries.map((e) => e.path)
    expect(paths({ indexScope: 'global' })).toEqual(['민지/민지_웃음_001.png', '민지/민지_웃음_002.png', '민지/민지_울음_003.png', '하늘/하늘_웃음_004.png'])
    expect(paths({ indexScope: 'folder', startIndex: 0 })).toEqual(['민지/민지_웃음_000.png', '민지/민지_웃음_001.png', '민지/민지_울음_002.png', '하늘/하늘_웃음_000.png'])
    expect(paths({ indexScope: 'character', folderMode: 'flat' })).toEqual(['민지_웃음_001.png', '민지_웃음_002.png', '민지_울음_003.png', '하늘_웃음_001.png'])
    expect(paths({ indexScope: 'combination' })).toEqual(['민지/민지_웃음_001.png', '민지/민지_웃음_002.png', '민지/민지_울음_001.png', '하늘/하늘_웃음_001.png'])
  })

  it('continues numbering from saved counters', () => {
    const first = previewPaths(items.slice(0, 2), settings({ indexScope: 'folder' }))
    expect(first.counters).toEqual({ 'folder:민지': 2 })
    const next = previewPaths(items.slice(2), settings({ indexScope: 'folder' }), { counters: first.counters })
    expect(next.entries.map((e) => e.fileName)).toEqual(['민지_울음_003.png', '하늘_웃음_001.png'])
    // 시작 번호를 지난 번호보다 크게 바꾸면 시작 번호부터
    const jump = previewPaths(items.slice(2, 3), settings({ indexScope: 'folder', startIndex: 50 }), { counters: first.counters })
    expect(jump.entries[0].index).toBe(50)
    // {index}를 쓰지 않으면 번호를 기록하지 않는다
    expect(previewPaths(items, settings({ fileTemplate: '{character}' })).counters).toEqual({})
  })

  it('nests root and folder templates, drops empty segments and replaces spaces', () => {
    const p = previewPaths(
      [{ id: 1, vars: { project: '봄 이벤트', character: '민지', outfit: '여름 교복', emotion: '', index: 0 }, ext: '.PNG' }],
      settings({ rootFolder: '{project}', folderTemplate: '{character}/{emotion}/{outfit}', fileTemplate: '{outfit} {emotion}_{index:02}' })
    )
    expect(p.entries[0]).toMatchObject({ folder: '봄_이벤트/민지/여름_교복', fileName: '여름_교복_01.png' })
    const flat = previewPaths(
      [{ id: 1, vars: { project: 'P', character: '민지' }, ext: 'webp' }],
      settings({ rootFolder: '{project}', folderMode: 'flat', replaceSpaces: false })
    )
    expect(flat.entries[0].path).toBe('P/민지_001.webp')
  })

  it('warns about unknown variables, index in folders and empty names', () => {
    const p = previewPaths([{ id: 1, vars: {}, ext: 'png' }], settings({ folderTemplate: '{index}', fileTemplate: '{oops}' }))
    expect(p.entries[0].path).toBe('image_001.png')
    expect(p.warnings).toEqual(['폴더 템플릿의 {index}는 쓸 수 없어 비워 둡니다', '알 수 없는 변수 {oops}', '이름이 비어 "image_번호"로 정했습니다'])
  })

  it('handles collisions case-insensitively by policy', () => {
    const dup: NamingItem[] = [
      { id: 1, vars: { character: 'Mia' }, ext: 'png' },
      { id: 2, vars: { character: 'mia' }, ext: 'png' },
      { id: 3, vars: { character: 'MIA' }, ext: 'png' }
    ]
    const s = (duplicate: NamingSettings['duplicate']): NamingSettings =>
      settings({ fileTemplate: '{character}', folderMode: 'flat', duplicate })
    const suffix = previewPaths(dup, s('suffix'), { existing: ['mia_2.png'] })
    expect(suffix.entries.map((e) => [e.fileName, e.status, e.conflictWith])).toEqual([
      ['Mia.png', 'ok', undefined],
      ['mia_3.png', 'renamed', 1],
      ['MIA_4.png', 'renamed', 1]
    ])
    expect(suffix.collisions).toBe(2)
    expect(suffix.ok).toBe(true)
    expect(previewPaths(dup, s('overwrite')).entries.map((e) => e.status)).toEqual(['ok', 'overwrite', 'overwrite'])
    expect(previewPaths(dup, s('skip')).entries.map((e) => e.status)).toEqual(['ok', 'skip', 'skip'])
    const err = previewPaths(dup, s('error'))
    expect(err.ok).toBe(false)
    expect(err.entries.map((e) => e.status)).toEqual(['ok', 'error', 'error'])
    const existing = previewPaths(dup.slice(0, 1), s('skip'), { existing: ['MIA.PNG'] })
    expect(existing.entries[0]).toMatchObject({ status: 'skip', conflictWith: 'existing' })
    // 같은 그림을 같은 경로로 다시 내보내는 것은 갱신
    const again = previewPaths([{ ...dup[0], previousPath: 'Mia.png' }], s('error'), { existing: ['Mia.png'] })
    expect(again.entries[0].status).toBe('update')
    expect(again.ok).toBe(true)
  })

  it('keeps suffixed names within the length limit', () => {
    const long = 'a'.repeat(80)
    const p = previewPaths(
      [
        { id: 1, vars: { character: long }, ext: 'png' },
        { id: 2, vars: { character: long }, ext: 'png' }
      ],
      settings({ fileTemplate: '{character}', folderMode: 'flat' })
    )
    expect(p.entries[1].name).toBe(`${'a'.repeat(78)}_2`)
  })
})

describe('manifest', () => {
  const cols = columnSpecs(['fileName', 'character', 'prompt', 'fileSize'])
  const rows = [
    { fileName: 'a.png', character: '민지', prompt: 'smile, "happy"\nnext', fileSize: 1024 },
    { fileName: 'b.png', character: '하늘', prompt: '-1::sad::', fileSize: undefined }
  ]

  it('writes RFC 4180 CSV with optional BOM and formula guard', () => {
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('line\r\nbreak')).toBe('"line\r\nbreak"')
    expect(csvField(12)).toBe('12')
    expect(csvField(null)).toBe('')
    expect(csvField('=1+1', true)).toBe("'=1+1")
    expect(csvField('-1::x::,y', true)).toBe('"\'-1::x::,y"')
    const csv = toCsv(rows, cols, { bom: true })
    expect(csv.startsWith('\ufeff파일 이름,캐릭터,프롬프트,파일 크기\r\n')).toBe(true)
    expect(csv).toContain('a.png,민지,"smile, ""happy""\nnext",1024\r\n')
    expect(csv.endsWith('b.png,하늘,-1::sad::,\r\n')).toBe(true)
    expect(toCsv(rows, cols, { header: false }).startsWith('a.png')).toBe(true)
  })

  it('writes JSON, TXT and Markdown', () => {
    expect(JSON.parse(toJson(rows, cols))[1]).toEqual({ fileName: 'b.png', character: '하늘', prompt: '-1::sad::', fileSize: null })
    expect(toTxt(rows, cols).split('\n')[1]).toBe('a.png | 민지 | smile, "happy" next | 1024')
    const md = toMarkdown([{ fileName: 'a|b.png', character: 'x\ny' }], columnSpecs(['fileName', 'character']))
    expect(md).toBe('| 파일 이름 | 캐릭터 |\n| --- | --- |\n| a\\|b.png | x<br>y |\n')
    expect(buildManifest(rows, cols, 'csv', { bom: true })).toMatchObject({ ext: 'csv', mime: 'text/csv;charset=utf-8' })
    expect(buildManifest(rows, cols, 'md').ext).toBe('md')
  })

  it('makes letter codes and per-character image codes that stay put', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(letterCode)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA'])
    const codes = assignImageCodes(
      [
        { id: 'a1', group: 'A', groupCode: 'A' },
        { id: 'a2', group: 'A', groupCode: 'A', existing: 'A002' },
        { id: 'a3', group: 'A', groupCode: 'A' },
        { id: 'b1', group: 'B', groupCode: 'B' }
      ],
      '{char}{n:03}'
    )
    expect([...codes.values()]).toEqual(['A001', 'A002', 'A003', 'B001'])
    // 번호 변수가 없는 패턴은 뒤에 번호를 붙인다
    expect([...assignImageCodes([{ id: 1, group: '', groupCode: 'X' }, { id: 2, group: '', groupCode: 'X' }], 'IMG-{char}').values()]).toEqual(['IMG-X1', 'IMG-X2'])
    // 번호와 무관한 패턴도 끝나고, 코드는 겹치지 않는다
    const odd = [...assignImageCodes([{ id: 1, group: '', groupCode: '' }, { id: 2, group: '', groupCode: '' }], '{{n}}').values()]
    expect(odd[0]).toBe('{n}')
    expect(new Set(odd).size).toBe(2)
    expect(buildCodeList([{ code: 'A001', character: '민지', emotion: '웃음', file: 'a.png' }], '{code} | {character} | {emotion} | {file}')).toBe(
      'A001 | 민지 | 웃음 | a.png'
    )
  })
})

/** 캐릭터 2 × 표정 2, 채택 그림이 있는 프로젝트 */
function exportProject(): Project {
  const p = createProject('봄 이벤트')
  p.id = 'P'
  p.slug = 'spring'
  p.characters = [
    { id: 'A', libraryId: 1, name: '민지', vibeIds: [], refIds: [] },
    { id: 'B', libraryId: 2, name: '하늘', slug: 'haneul', vibeIds: [], refIds: [] }
  ]
  p.axes = [
    {
      id: 'e',
      kind: 'expression',
      name: '표정',
      key: 'face',
      target: 'character',
      values: [
        { id: 'smile', label: '웃음', slug: 'smile', prompt: 'smile' },
        { id: 'cry', label: '울음', prompt: 'crying' }
      ]
    }
  ]
  p.naming = { ...DEFAULT_NAMING, rootFolder: '{project}', folderTemplate: '{character}', fileTemplate: '{code}_{emotion}', indexScope: 'combination' }
  const combos = expandMatrix(p).combos
  let id = 100
  for (const c of combos) {
    let item = emptyItem(c.key)
    for (let i = 0; i < 2; i++) item = addImage(item, { id: ++id, ts: id, seed: id * 7, width: 832, height: 1216, mime: 'image/png' }, { fromQueue: false })
    p.items[c.key] = setMarks(item, [item.images[0].id], 'adopted')
  }
  return p
}

describe('export plan', () => {
  it('plans codes, paths, manifest rows and the code list', () => {
    const p = exportProject()
    const plan = planExport(p)
    expect(plan.entries.map((e) => e.path.path)).toEqual([
      'spring/민지/A001_smile.png',
      'spring/민지/A002_울음.png',
      'spring/haneul/B001_smile.png',
      'spring/haneul/B002_울음.png'
    ])
    expect(plan.newCodes.map((c) => c.code)).toEqual(['A001', 'A002', 'B001', 'B002'])
    const rows = manifestRows(p, plan, { outputs: new Map([[101, { width: 512, height: 748, bytes: 2048 }]]) })
    expect(rows[0]).toMatchObject({
      fileName: 'A001_smile.png',
      character: '민지',
      expression: '웃음',
      code: 'A001',
      resolution: '512x748',
      fileSize: 2048,
      seed: 707,
      prompt: 'smile',
      description: '민지 웃음',
      'axis:e': '웃음'
    })
    expect(projectColumns(p, ['code', 'axis:e']).map((c) => c.label)).toEqual(['이미지 코드', '표정'])
    expect(projectCodeList(p, plan).split('\n')[3]).toBe('B002 | 하늘 | 울음 | B002_울음.png')
  })

  it('keeps codes and paths when an adopted image is replaced', () => {
    let p = exportProject()
    const first = planExport(p)
    const key = first.entries[0].candidate.key
    // 코드 저장 + 내보내기 기록
    for (const c of first.newCodes) p.items[c.key] = setSlotCodes(p.items[c.key], { [c.slot]: c.code })
    for (const e of first.entries) p.items[e.candidate.key] = markExported(p.items[e.candidate.key], e.candidate.image.id, e.path.path, 1)
    // 새 그림으로 교체
    p = { ...p, items: { ...p.items, [key]: replaceAdopted(p.items[key], 101, 102) } }
    const again = planExport(p, { existing: first.entries.map((e) => e.path.path) })
    expect(again.newCodes).toEqual([])
    expect(again.entries[0]).toMatchObject({ code: 'A001' })
    expect(again.entries[0].candidate.image.id).toBe(102)
    // 교체한 새 그림은 이전 버전의 파일을 새로 쓴다 (이름·코드 그대로), 나머지도 지난번과 같은 경로라 갱신
    expect(again.entries[0].path).toMatchObject({ path: 'spring/민지/A001_smile.png', status: 'update' })
    expect(again.entries.map((e) => e.path.status)).toEqual(['update', 'update', 'update', 'update'])
    expect(again.preview.collisions).toBe(0)
    // 이전 기록과 상관없는 그림이 같은 이름을 원하면 충돌로 처리한다
    const clash = planExport({ ...p, naming: { ...p.naming, fileTemplate: 'same', duplicate: 'error' } }, { renameExported: true })
    expect(clash.preview.ok).toBe(false)
    // 템플릿을 바꿔도 내보낸 그림은 지난 이름을 지킨다 (renameExported면 새로)
    const renamed = { ...p, naming: { ...p.naming, fileTemplate: '{code}' } }
    expect(planExport(renamed).entries[0].path).toMatchObject({ path: 'spring/민지/A001_smile.png', kept: true, index: null })
    expect(planExport(renamed, { renameExported: true }).entries[0].path).toMatchObject({ path: 'spring/민지/A001.png', kept: false })
    expect(planExport(p, { onlyNotExported: true }).entries.map((e) => e.candidate.image.id)).toEqual([102])
  })

  it('continues numbering for new images while exported ones keep their names', () => {
    const p = exportProject()
    p.naming = { ...p.naming, fileTemplate: '{character}_{index:02}', indexScope: 'character', folderMode: 'flat' }
    const first = planExport(p, { ext: 'webp' })
    expect(first.entries.map((e) => e.path.fileName)).toEqual(['민지_01.webp', '민지_02.webp', 'haneul_01.webp', 'haneul_02.webp'])
    for (const e of first.entries) p.items[e.candidate.key] = markExported(p.items[e.candidate.key], e.candidate.image.id, e.path.path, 1)
    p.exportCounters = first.preview.counters
    expect(p.exportCounters).toEqual({ 'character:A': 2, 'character:B': 2 })
    // 민지 웃음에 한 장 더 채택
    const key = first.entries[0].candidate.key
    p.items[key] = setMarks(p.items[key], [102], 'adopted')
    const next = planExport(p, { ext: 'webp' })
    expect(next.entries.map((e) => [e.path.fileName, e.path.status])).toEqual([
      ['민지_01.webp', 'update'],
      ['민지_03.webp', 'ok'],
      ['민지_02.webp', 'update'],
      ['haneul_01.webp', 'update'],
      ['haneul_02.webp', 'update']
    ])
    expect(next.preview.counters).toEqual({ 'character:A': 3, 'character:B': 2 })
  })
})
