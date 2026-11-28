/// <reference types="node" />
/**
 * NAIS3 가져오기·내보내기. tests/fixtures/nais3/*.nais 는 NAIS3 자신의 코드(마이그레이션 + writeNaisArchive)로
 * 만든 진짜 아카이브다 (tests/fixtures/nais3/build-fixtures.mjs).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BackupError,
  bytesSource,
  exportNais3,
  importNais3,
  memorySink,
  naipToNais3,
  nais3ArchiveFromLegacyJson,
  openAnyBackup,
  planRestore,
  readNaisArchive,
  reportText,
  stripCredentials,
  type BackupData,
  type ConversionReport
} from '../src/backup'
import { fromUtf8, sniffImage, toBase64, utf8 } from '../src/backup/bytes'
import { sha256Hex } from '../src/backup/hash'
import { parseVibeCache, packVibeCache } from '../src/backup/nais3/vibe-cache'
import { nais3ReadNaisArchive, nais3ValidateRows } from './helpers/nais3-reference'
import { craftZip, rewriteZip } from './helpers/zip-craft'
import { PARAMS, PNG_1X1, sampleData } from './helpers/sample'

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/nais3/${name}`, import.meta.url))))

type Item = Record<string, unknown>
const list = (section: unknown, key: string): Item[] => (section as Record<string, Item[]>)[key]
const line = (lines: ConversionReport['transformed'], scope: string, text: string): { count?: number; items?: string[] } | undefined =>
  lines.find((l) => l.scope === scope && l.text.includes(text))

async function importFixture(name: string): Promise<{ data: BackupData; report: ConversionReport }> {
  const archive = await readNaisArchive(bytesSource(fixture(name)))
  return importNais3(archive)
}

describe('NAIS3 .nais import (real archive written by NAIS3)', () => {
  it('reads the archive with all tables and no integrity problems', async () => {
    const archive = await readNaisArchive(bytesSource(fixture('workspace.nais')))
    expect(archive.manifest).toMatchObject({ format: 'NAIS', app: 'NAIS3', formatVersion: 1, appVersion: '1.0.33' })
    expect(archive.problems).toEqual([])
    expect(Object.keys(archive.tables)).toHaveLength(13)
    expect(archive.tables.charref_images).toHaveLength(7)
  })

  it('maps characters, folders and enabled cards', async () => {
    const { data, report } = await importFixture('workspace.nais')
    expect(list(data.characters, 'folders')).toEqual([{ id: 1, name: '주인공들' }])
    expect(list(data.characters, 'characters')).toEqual([
      { id: 2, name: 'Bob', folderId: null, prompt: '1boy, black hair', negative: '' },
      { id: 1, name: 'Alice', folderId: 1, prompt: '1girl, blonde hair, blue eyes', negative: 'bad hands' },
      { id: 3, name: 'Alice', folderId: null, prompt: '1girl, school uniform', negative: 'extra arms' }
    ])
    // NAIS3 메인 설정에 위치 사용(useCoords)이 없으니 AI 선택 위치
    expect(data.characters!.cast).toEqual([
      { charId: 2, enabled: true, center: null },
      { charId: 1, enabled: true, center: null }
    ])
    expect(line(report.transformed, '캐릭터', '폴더 색')?.items).toEqual(['주인공들'])
    expect(line(report.transformed, '캐릭터', 'AI 선택 위치')).toBeDefined()
    expect(line(report.notImported, '캐릭터', '썸네일')?.items).toEqual(['Alice'])
    expect(line(report.notImported, '캐릭터', 'settings_json')?.items).toEqual(['Alice'])
  })

  it('maps prompt presets including params and the 3-way split', async () => {
    const { data, report } = await importFixture('workspace.nais')
    const presets = list(data.presets, 'presets')
    expect(presets.map((p) => p.name)).toEqual(['기본 프리셋', '예전 프리셋', 'V5 일부', '깨진 파라미터'])
    expect(presets[0]).toEqual({ id: 1, name: '기본 프리셋', base: 'masterpiece, 1girl', detail: 'smile', negative: 'lowres', params: PARAMS })
    expect(presets[1]).toMatchObject({ base: 'old prompt', detail: '', params: PARAMS })
    expect(presets[2].params).toEqual({ ...PARAMS, model: 'nai-diffusion-5-full', steps: 23 })
    expect(line(report.transformed, '프롬프트 프리셋', '가변 칸')?.items).toEqual(['기본 프리셋'])
    expect(line(report.transformed, '프롬프트 프리셋', '파라미터 없이')?.items).toEqual(['예전 프리셋'])
    expect(line(report.transformed, '프롬프트 프리셋', '저장되지 않은 파라미터')?.items).toEqual(['V5 일부'])
    expect(line(report.notImported, '프롬프트 프리셋', '읽을 수 없어')?.items).toEqual(['깨진 파라미터'])
  })

  it('maps fragments (including NAIS3 default Danbooru fragments) and folders', async () => {
    const { data } = await importFixture('workspace.nais')
    expect(list(data.fragments, 'folders')).toEqual([
      { id: 1, name: 'Default' },
      { id: 50, name: '포즈' }
    ])
    const frags = list(data.fragments, 'fragments')
    expect(frags).toHaveLength(10)
    expect(frags.find((f) => f.name === 'pose')).toEqual({ id: expect.any(Number), name: 'pose', folderId: 50, content: 'standing\nsitting\n# 주석 줄\nlying' })
    expect(frags.find((f) => f.name === 'Hair color')!.folderId).toBe(1)
  })

  it('maps scene presets to scene folders and reports what has no equivalent', async () => {
    const { data, report } = await importFixture('workspace.nais')
    expect(list(data.scenes, 'folders')).toEqual([
      { id: 1, name: '기본' },
      { id: 2, name: '야외' }
    ])
    expect(list(data.scenes, 'scenes')).toEqual([
      { id: 1, name: '교실', folderId: 1, prompt: 'classroom, desk', negative: 'lowres', size: { width: 832, height: 1216 }, reserve: 3 },
      { id: 2, name: '해변', folderId: 2, prompt: 'beach, ocean', negative: '', size: { width: 1216, height: 832 }, reserve: 2 },
      { id: 3, name: '숲', folderId: 2, prompt: 'forest', negative: '', size: { width: 1024, height: 1024 }, reserve: 0 }
    ])
    expect(line(report.notImported, '씬', '기본 해상도')?.items).toEqual(['야외 (1024×1024)'])
    // NAIS3 1.0.33 은 묶음의 캐릭터 지정(character_ids)을 생성에 쓰지 않는다 — 씬 출연으로 옮기면 생성 캐릭터가 달라진다
    expect(line(report.notImported, '씬', '묶음의 캐릭터 지정')?.items).toEqual(['야외'])
    expect(line(report.transformed, '씬', '출연 캐릭터로')).toBeUndefined()
    expect(line(report.transformed, '씬', '합계 예약')?.items).toEqual(['해변'])
  })

  it('maps vibes with their encoding cache, legacy encodings and encoded-only vibes', async () => {
    const { data, report } = await importFixture('workspace.nais')
    const vibes = list(data.vibes, 'vibes')
    expect(vibes.map((v) => v.name)).toEqual(['watercolor', 'legacy', '메타데이터 바이브 1', 'raw'])
    expect(vibes[0]).toMatchObject({
      strength: 0.55,
      infoExtracted: 0.7,
      enabled: true,
      encodings: { 'nai-diffusion-4-5-full|0.7': 'ENC45FULL07', 'nai-diffusion-4-5-curated|1': 'ENC45CUR10' }
    })
    expect(sniffImage(Uint8Array.from(atob(vibes[0].image as string), (c) => c.charCodeAt(0)))?.mime).toBe('image/png')
    expect(vibes[0].thumb).toMatch(/^data:image\/png;base64,/)
    expect(vibes[1].encodings).toEqual({ 'nai-diffusion-4-5-full|1': 'LEGACYENC' })
    expect(vibes[2]).toMatchObject({ image: '', encodings: { 'nai-diffusion-4-5-full|1': 'METAENC' } })
    expect(vibes[2].thumb).toMatch(/^data:image\//)
    expect(vibes[3]).toMatchObject({ encodings: {} })
    expect((vibes[3].image as string).length).toBeGreaterThan(10)
    expect(line(report.transformed, '바이브', '예전 형식')?.items).toEqual(['legacy'])
    expect(line(report.transformed, '바이브', '인코딩 전용')?.items).toEqual(['메타데이터 바이브 1'])
    expect(line(report.notImported, '바이브', '폴더')?.items).toEqual(['watercolor (스타일)'])
  })

  it('maps precise references incl. V5 types and reports delta', async () => {
    const { data, report } = await importFixture('workspace.nais')
    const refs = list(data.charRefs, 'charRefs')
    expect(refs.map((r) => [r.name, r.type, r.sameOutfit, r.strength, r.enabled])).toEqual([
      ['ref-character', 'character', false, 0.5, false],
      ['ref-character_mainoutfit', 'character', true, 1, true],
      ['ref-style', 'style', undefined, 1.5, false],
      ['ref-character&style', 'character&style', true, 2, true],
      ['ref-character&style_anyoutfit', 'character&style', false, 2.5, false],
      ['ref-costume', 'costume', undefined, 3, true]
    ])
    expect(refs[0]).toMatchObject({ fidelity: 0.8 })
    expect(line(report.notImported, '정밀 레퍼런스', 'delta')?.items).toEqual(['ref-delta'])
    expect(line(report.transformed, '정밀 레퍼런스', '같은 의상 선호')?.count).toBe(2)
    expect(line(report.notImported, '정밀 레퍼런스', '폴더')?.items).toEqual(['ref-costume (의상)'])
  })

  it('maps mainParams to the working prompt and reports library images', async () => {
    const { data, report } = await importFixture('workspace.nais')
    expect(data.prompt).toEqual({
      base: 'masterpiece',
      additional: '1girl, smile',
      detail: 'outdoors',
      negative: 'lowres, bad anatomy',
      params: {
        model: 'nai-diffusion-5-full',
        width: 1024,
        height: 1024,
        steps: 23,
        cfgScale: 4.5,
        cfgRescale: 0.1,
        sampler: 'k_euler_ancestral',
        noiseSchedule: 'karras',
        variety: true,
        qualityToggle: true,
        ucPreset: 1,
        transparentBackground: true
      },
      seed: ''
    })
    // NAIS3 의 V5 투명 배경은 NAIP 의 배경 투명으로 옮긴다 (예전에는 "옮기지 못한 것"이었다)
    expect(line(report.notImported, '작업 중인 프롬프트', 'transparentBackground')).toBeUndefined()
    expect(line(report.transformed, '작업 중인 프롬프트', 'transparentBackground')).toBeUndefined()
    expect(line(report.transformed, '작업 중인 프롬프트', '시드')?.items).toEqual(['시드 12345'])
    expect(line(report.notImported, '라이브러리', '그림')?.items).toEqual(['lib-1', 'lib-2'])
    expect(line(report.notImported, '라이브러리', '묶음')?.items).toEqual(['모음'])
    expect(report.imported.map((x) => [x.section, x.count])).toEqual([
      ['characters', 3],
      ['presets', 4],
      ['fragments', 10],
      ['scenes', 3],
      ['vibes', 4],
      ['charRefs', 6],
      ['prompt', 1]
    ])
    expect(report.problems).toEqual([])
    const text = reportText(report)
    expect(text[0]).toContain('캐릭터 3개')
    expect(text.some((l) => l.includes('옮기지 못한 것'))).toBe(true)
  })

  it('uses processImage and newId when given', async () => {
    const archive = await readNaisArchive(bytesSource(fixture('workspace.nais')))
    let next = 5000
    const seen: string[] = []
    const { data } = await importNais3(archive, {
      newId: () => ++next,
      processImage: async (bytes, mime, kind) => {
        seen.push(`${kind}:${mime}`)
        return { base64: toBase64(bytes), thumb: 'data:image/jpeg;base64,THUMB' }
      }
    })
    expect(seen.filter((s) => s.startsWith('vibe')).length).toBe(3)
    expect(seen.filter((s) => s.startsWith('charRef')).length).toBe(6)
    const chars = list(data.characters, 'characters')
    expect(chars.every((c) => (c.id as number) > 5000)).toBe(true)
    // 출연(켜 둔 카드)도 같은 새 id 를 가리킨다
    expect((data.characters!.cast as { charId: number }[]).map((c) => c.charId)).toEqual([chars.find((c) => c.name === 'Bob')!.id, chars.find((c) => c.name === 'Alice' && c.folderId !== null)!.id])
    expect(list(data.charRefs, 'charRefs')[0].thumb).toBe('data:image/jpeg;base64,THUMB')
  })

  it('reads a partial archive (subset of tables, a file skipped by NAIS3)', async () => {
    const { data, report } = await importFixture('partial.nais')
    expect(Object.keys(data).sort()).toEqual(['characters', 'vibes'])
    expect(list(data.vibes, 'vibes').map((v) => v.name)).toEqual(['watercolor', 'legacy', '메타데이터 바이브 1'])
    expect(report.problems).toEqual([])
  })

  it('reports damaged entries instead of silently dropping them', async () => {
    const tampered = await rewriteZip(fixture('workspace.nais'), (path, data) => {
      if (path === 'assets/files/charref_images/2.png') return data.map((b, i) => (i === 30 ? b ^ 1 : b))
      if (path === 'data/tables/prompt_presets.json') return utf8(fromUtf8(data).replace('lowres', 'highres'))
      return data
    })
    const archive = await readNaisArchive(bytesSource(tampered))
    expect(archive.problems.map((p) => [p.path, p.kind])).toEqual([['data/tables/prompt_presets.json', 'checksum-mismatch']])
    const { data, report } = await importNais3(archive)
    expect(data.presets).toBeUndefined()
    expect(line(report.notImported, '프롬프트 프리셋', '손상')).toBeDefined()
    expect(list(data.charRefs, 'charRefs').map((r) => r.name)).not.toContain('ref-character_mainoutfit')
    expect(line(report.notImported, '정밀 레퍼런스', '원본 그림을 읽지 못함')?.items).toEqual(['ref-character_mainoutfit'])
    expect(report.problems.map((p) => p.path)).toContain('assets/files/charref_images/2.png')
  })

  it('rejects unsupported versions, NAIP archives and unsafe paths', async () => {
    const newer = await rewriteZip(fixture('workspace.nais'), (path, data) =>
      path === 'manifest.json' ? utf8(JSON.stringify({ ...JSON.parse(fromUtf8(data)), formatVersion: 3 })) : data
    )
    await expect(readNaisArchive(bytesSource(newer))).rejects.toMatchObject({ code: 'unsupported-version' })
    const slip = craftZip([
      { name: 'manifest.json', data: utf8('{}') },
      { name: 'assets/../../evil', data: utf8('x') }
    ])
    await expect(readNaisArchive(bytesSource(slip))).rejects.toMatchObject({ code: 'unsafe-path' })
    const opened = await openAnyBackup(bytesSource(fixture('workspace.nais')))
    expect(opened.kind).toBe('nais3')
  })

  it('opens legacy NAIS3 JSON backups', async () => {
    const legacy = {
      _app: 'NAIS3',
      _version: 1,
      mainParams: null,
      tables: {
        character_prompts: [{ id: 1, name: 'A', prompt: 'p', negative_prompt: '', thumbnail: { __blob: PNG_1X1 }, enabled: 0, center_x: 0.5, center_y: 0.5, folder_id: null, sort_order: 0, settings_json: '{}' }],
        vibe_images: [{ id: 1, name: 'v', file_path: '/x/y.png', __image: PNG_1X1, enabled: 1, strength: 0.6, info_extracted: 1, encoded: null, encoded_ie: null, folder_id: null, sort_order: 0 }],
        charref_images: [{ id: 1, name: 'r', file_path: '/x/r.png', __image: null, enabled: 1, ref_type: 'style', strength: 1, fidelity: 1, folder_id: null, sort_order: 0 }]
      }
    }
    const opened = await openAnyBackup(bytesSource(utf8(JSON.stringify(legacy))))
    expect(opened.kind).toBe('nais3-json')
    const { data, report } = await importNais3(nais3ArchiveFromLegacyJson(legacy))
    expect(list(data.characters, 'characters')).toHaveLength(1)
    expect(list(data.vibes, 'vibes')[0].image).toBe(toBase64(Uint8Array.from(atob(PNG_1X1), (c) => c.charCodeAt(0))))
    expect(list(data.charRefs, 'charRefs')).toEqual([])
    expect(line(report.notImported, '정밀 레퍼런스', '원본 그림을 읽지 못함')?.items).toEqual(['r'])
  })

  it('uses split prompt parts only when they still join to the prompt (like NAIS3)', async () => {
    const legacy = {
      _app: 'NAIS3',
      _version: 1,
      mainParams: JSON.stringify({ prompt: 'current main prompt', promptParts: { base: 'stale', additional: '', detail: '' } }),
      tables: {
        prompt_presets: [
          // 3분할을 끈 뒤 prompt 만 고친 프리셋 — 조각은 예전 것
          { id: 1, name: '고친 것', prompt: 'NEW edited prompt', negative_prompt: '', sort_order: 0, params_json: null, prompt_parts_json: JSON.stringify({ base: 'old base', additional: 'old add', detail: 'old detail' }) },
          { id: 2, name: '그대로', prompt: 'a, b, c', negative_prompt: '', sort_order: 1, params_json: null, prompt_parts_json: JSON.stringify({ base: 'a', additional: 'b', detail: 'c' }) }
        ]
      }
    }
    const { data, report } = await importNais3(nais3ArchiveFromLegacyJson(legacy))
    const presets = list(data.presets, 'presets')
    expect(presets[0]).toMatchObject({ base: 'NEW edited prompt', detail: '' })
    expect(presets[1]).toMatchObject({ base: 'a, b', detail: 'c' })
    expect(line(report.transformed, '프롬프트 프리셋', '3분할 정보가 지금 프롬프트와 달라')?.items).toEqual(['고친 것'])
    expect(data.prompt).toMatchObject({ base: 'current main prompt', additional: '', detail: '' })
  })

  it('skips rows whose id repeats instead of merging them into one item', async () => {
    const row = (id: number, name: string) => ({ id, name, prompt: name, negative_prompt: '', enabled: 0, center_x: 0.5, center_y: 0.5, folder_id: null, sort_order: 0, settings_json: '{}' })
    const legacy = { _app: 'NAIS3', _version: 1, mainParams: null, tables: { character_prompts: [row(5, 'A'), row(5, 'B'), row(6, 'C')] } }
    const archive = nais3ArchiveFromLegacyJson(legacy)
    expect(archive.tables.character_prompts!.map((r) => r.name)).toEqual(['A', 'C'])
    expect(archive.problems.some((p) => p.detail.includes('id 5'))).toBe(true)
    let next = 100
    const { data } = await importNais3(archive, { newId: () => ++next })
    const ids = list(data.characters, 'characters').map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)

    // .nais 도 같게
    const sink = memorySink()
    await exportNais3({ fragments: { folders: [], fragments: [{ id: 1, name: 'x', folderId: null, content: 'a' }, { id: 2, name: 'y', folderId: null, content: 'b' }] } }, sink, { appVersion: '0.12.0' })
    let table: Uint8Array = new Uint8Array()
    const dup = await rewriteZip(sink.bytes(), (path, data) => {
      if (path !== 'data/tables/fragments.json') return data
      table = utf8(fromUtf8(data).replace('"id": 2', '"id": 1'))
      return table
    })
    // 체크섬도 맞춰 준다 (손으로 고친 파일)
    const resummed = await rewriteZip(dup, (path, data) => {
      if (path !== 'checksums.json') return data
      const sums = JSON.parse(fromUtf8(data)) as Record<string, { sha256: string; bytes: number }>
      sums['data/tables/fragments.json'] = { sha256: sha256Hex(table), bytes: table.byteLength }
      return utf8(JSON.stringify(sums))
    })
    const nais = await readNaisArchive(bytesSource(resummed))
    expect(nais.tables.fragments!.map((r) => r.name)).toEqual(['x'])
    expect(nais.problems.some((p) => p.path === 'data/tables/fragments.json' && p.detail.includes('id 1'))).toBe(true)
  })

  it('plans a merge of the imported data like any other backup', async () => {
    const { data } = await importFixture('workspace.nais')
    const plan = planRestore(sampleData(), data, { mode: 'merge' })
    expect((plan.sections.characters!.result.characters as Item[]).length).toBe(5)
    expect((plan.sections.scenes!.result.scenes as Item[]).length).toBe(6)
  })
})

describe('NAIS3 vibe cache format', () => {
  it('parses and packs like NAIS3', () => {
    const packed = packVibeCache({ b: { ie: 1, data: 'B' }, a: { ie: 0.7, data: 'A' } })
    expect(packed).toBe('nais3-vibe-cache-v1:{"a":{"ie":0.7,"data":"A"},"b":{"ie":1,"data":"B"}}')
    expect(parseVibeCache(packed, null)).toEqual({ a: { ie: 0.7, data: 'A' }, b: { ie: 1, data: 'B' } })
    expect(parseVibeCache('RAW', 0.5)).toEqual({ 'nai-diffusion-4-5-full': { ie: 0.5, data: 'RAW' } })
    expect(parseVibeCache('nais3-vibe-cache-v1:{broken', null)).toEqual({})
  })
})

describe('NAIS3 .nais export', () => {
  const ALL = ['characters', 'presets', 'fragments', 'scenes', 'prompt', 'vibes', 'charRefs'] as const

  async function exported(): Promise<{ bytes: Uint8Array; result: Awaited<ReturnType<typeof exportNais3>> }> {
    const sink = memorySink()
    const result = await exportNais3(stripCredentials(sampleData()).value, sink, { appVersion: '0.12.0', createdAt: '2026-11-27T00:00:00.000Z', sections: ALL })
    const bytes = sink.bytes()
    // 실제 NAIS3 로 복원해 보는 수동 확인용 (build-fixtures.mjs --verify)
    if (process.env.NAIP_EXPORT_NAIS) writeFileSync(process.env.NAIP_EXPORT_NAIS, bytes)
    return { bytes, result }
  }

  it('produces an archive that NAIS3’s own reader and row validation accept', async () => {
    const { bytes } = await exported()
    const db = await nais3ReadNaisArchive(Buffer.from(bytes))
    expect(db.includedTables).toEqual([
      'character_folders',
      'character_prompts',
      'prompt_presets',
      'fragment_folders',
      'fragments',
      'scene_presets',
      'gen_scenes',
      'vibe_images',
      'charref_images'
    ])
    nais3ValidateRows(db)
    expect(db.files.map((f) => `${f.table}${f.extension}`)).toEqual(['vibe_images.png', 'vibe_images.nais3vibe', 'charref_images.png', 'charref_images.png'])
    expect(JSON.parse(db.mainParams!)).toMatchObject({ prompt: 'masterpiece, 1girl, smile', model: 'nai-diffusion-4-5-full', seed: -1, useCoords: true })
    // 조각 이름은 전체에서 하나뿐이어야 한다
    const names = db.tables.fragments!.map((f) => f.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('round-trips characters, presets, fragments, scenes, vibes and references', async () => {
    const { bytes } = await exported()
    const { data } = await importNais3(await readNaisArchive(bytesSource(bytes)))
    const src = sampleData()
    const strip = (items: Item[], keys: string[]): Item[] => items.map((x) => Object.fromEntries(keys.map((k) => [k, x[k]])))
    expect(strip(list(data.characters, 'characters'), ['name', 'prompt', 'negative'])).toEqual(strip(src.characters!.characters!, ['name', 'prompt', 'negative']))
    expect(list(data.characters, 'folders').map((f) => f.name)).toEqual(['주인공'])
    expect(data.characters!.cast).toEqual([
      { charId: 1, enabled: true, center: { x: 0.5, y: 0.5 } },
      { charId: 2, enabled: true, center: { x: 0.3, y: 0.5 } }
    ])
    expect(strip(list(data.presets, 'presets'), ['name', 'base', 'detail', 'negative', 'params'])).toEqual(
      strip(src.presets!.presets, ['name', 'base', 'detail', 'negative', 'params'])
    )
    expect(list(data.fragments, 'fragments').map((f) => [f.name, f.content])).toEqual([
      ['pose', 'standing\nsitting'],
      ['pose-2', 'lying']
    ])
    expect(list(data.scenes, 'folders').map((f) => f.name)).toEqual(['야외', '기본'])
    expect(list(data.scenes, 'scenes').map((s) => [s.name, s.size, s.reserve])).toEqual([
      ['해변', { width: 832, height: 1216 }, 2],
      ['숲', { width: 1024, height: 1024 }, 0],
      ['방', { width: 832, height: 1216 }, 1]
    ])
    const vibes = list(data.vibes, 'vibes')
    expect(vibes.map((v) => [v.name, v.image ? 'image' : '', v.encodings])).toEqual([
      ['수채화', 'image', { 'nai-diffusion-4-5-full|1': 'ENC1' }],
      ['복원', '', { 'nai-diffusion-4-5-curated|1': 'ENC2' }]
    ])
    expect(list(data.charRefs, 'charRefs').map((r) => [r.name, r.type, r.sameOutfit, r.strength])).toEqual([
      ['의상', 'costume', undefined, 2],
      ['캐릭터', 'character', true, 1]
    ])
    expect(data.prompt).toMatchObject({ base: 'masterpiece', additional: '1girl', detail: 'smile', negative: 'lowres', params: PARAMS })
  })

  it('lists the NAIP-only data that will be lost', async () => {
    const { result } = await exported()
    const lost = result.lost.map((l) => `[${l.scope}] ${l.text}`)
    for (const label of ['앱 설정', '자주 쓴 태그', '보관한 마스크', '저장 폴더·이름 번호', '즐겨찾기·모음', '내보내기 템플릿', '에셋 프로젝트']) {
      expect(lost.some((l) => l.startsWith(`[${label}]`))).toBe(true)
    }
    const has = (scope: string, text: string): boolean => result.lost.some((l) => l.scope === scope && l.text.includes(text))
    expect(has('캐릭터', '변형 그룹')).toBe(true)
    expect(has('캐릭터', 'NAIP 전용 캐릭터 데이터(slots)')).toBe(true)
    expect(has('캐릭터', 'AI 선택 위치')).toBe(true)
    expect(has('캐릭터', '출연 순서')).toBe(true)
    expect(has('조각', '이름을 바꿈')).toBe(true)
    expect(has('씬', '씬별 출연 캐릭터')).toBe(true)
    expect(has('씬', '씬별 출연 위치')).toBe(true)
    expect(has('씬', '메인 해상도를 따르던 씬')).toBe(true)
    expect(has('바이브', '모델마다 하나만')).toBe(true)
    expect(has('작업 중인 프롬프트', 'count')).toBe(true)
    expect(result.exported.map((e) => e.section)).toEqual(['characters', 'presets', 'fragments', 'scenes', 'vibes', 'charRefs', 'prompt'])
  })

  it('only includes tables for the sections it exports (NAIS3 replaces included tables)', () => {
    const plan = naipToNais3({ fragments: sampleData().fragments })
    expect(plan.output.includedTables).toEqual(['fragment_folders', 'fragments'])
    expect(plan.output.mainParams).toBeNull()
  })

  it('reports scene casts as lost instead of writing the scene-preset binding NAIS3 ignores', () => {
    const data: BackupData = {
      characters: { folders: [], characters: [{ id: 7, name: 'A', folderId: null, prompt: '', negative: '' }], cast: [] },
      scenes: {
        folders: [{ id: 1, name: 'g' }],
        scenes: [
          { id: 2, name: 's1', folderId: 1, prompt: '', negative: '', size: { width: 512, height: 512 }, cast: [7], reserve: 0 },
          { id: 3, name: 's2', folderId: 1, prompt: '', negative: '', size: { width: 512, height: 512 }, cast: [7], reserve: 0 }
        ]
      }
    }
    const plan = naipToNais3(data)
    expect(plan.output.tables.scene_presets).toEqual([{ id: 1, name: 'g', sort_order: 0, default_width: null, default_height: null, character_ids: null }])
    expect(plan.lost.find((l) => l.text.includes('씬별 출연 캐릭터'))?.items).toEqual(['s1', 's2'])
  })

  it('leaves out empty sections so NAIS3 keeps its own tables', () => {
    const plan = naipToNais3(
      {
        presets: { presets: [{ id: 1, name: 'p', base: 'a', detail: '', negative: '', params: PARAMS }] },
        characters: { folders: [{ id: 1, name: 'f' }], characters: [], slots: [], options: {} },
        fragments: { folders: [], fragments: [] },
        scenes: { folders: [{ id: 2, name: '묶음' }], scenes: [] },
        vibes: { vibes: [{ id: 3, name: '빈 바이브', image: '', thumb: '', strength: 0.6, infoExtracted: 1, enabled: true, encodings: {} }] },
        charRefs: { charRefs: [] }
      },
      { sections: ALL }
    )
    expect(plan.output.includedTables).toEqual(['prompt_presets'])
    expect(plan.exported.map((e) => e.section)).toEqual(['presets'])
    for (const label of ['캐릭터', '조각', '씬', '바이브', '정밀 레퍼런스']) {
      expect(plan.lost.some((l) => l.scope === label && l.text.includes('NAIS3 쪽 것은 그대로'))).toBe(true)
    }
  })

  it('exports Phase 2 characters (split prompt, fixed slots) with their prompt and enabled cards', () => {
    const plan = naipToNais3({
      characters: {
        folders: [],
        characters: [
          { id: 5, name: 'Alice', folderId: null, base: '1girl, blonde hair', additional: 'smile', detail: '', negative: 'bad', variations: [] },
          { id: 6, name: 'Bob', folderId: null, base: '1boy', additional: '', detail: '', negative: '', variations: [] }
        ],
        slots: [
          { id: 1, mode: 'fixed', charId: 5, enabled: true, center: { x: 0.3, y: 0.5 }, candidates: [] },
          { id: 2, mode: 'random', charId: null, enabled: true, center: null, candidates: [{ kind: 'char', id: 6 }] }
        ],
        options: {}
      }
    })
    expect(plan.output.tables.character_prompts!.map((r) => [r.name, r.prompt, r.enabled, r.center_x])).toEqual([
      ['Alice', '1girl, blonde hair, smile', 1, 0.3],
      ['Bob', '1boy', 0, 0.5]
    ])
    expect(plan.lost.some((l) => l.text.includes('무작위·순차·확률 출연 슬롯'))).toBe(true)
  })

  it('pins an image-less vibe to the information-extracted value its encodings were made with', async () => {
    const data: BackupData = {
      vibes: {
        vibes: [
          // 슬라이더는 1 이지만 인코딩은 0.7 뿐 — NAIS3 는 원본 없이 다시 인코딩할 수 없다
          { id: 1, name: '복원', image: '', thumb: '', strength: 0.5, infoExtracted: 1, enabled: true, encodings: { 'nai-diffusion-4-5-full|0.7': 'E07', 'nai-diffusion-4-5-curated|0.5': 'C05' } },
          // 원본이 있으면 NAIS3 가 다시 인코딩하므로 슬라이더 값을 그대로 둔다
          { id: 2, name: '그림', image: PNG_1X1, thumb: '', strength: 0.5, infoExtracted: 1, enabled: true, encodings: { 'nai-diffusion-4-5-full|0.7': 'E07' } }
        ]
      }
    }
    const plan = naipToNais3(data, { sections: ['vibes'] })
    const [restored, pictured] = plan.output.tables.vibe_images!
    expect(restored).toMatchObject({ info_extracted: 0.7, encoded_ie: 0.7 })
    expect(parseVibeCache(restored.encoded as string, null)['nai-diffusion-4-5-full']).toEqual({ ie: 0.7, data: 'E07' })
    expect(pictured).toMatchObject({ info_extracted: 1 })
    expect(plan.lost.find((l) => l.text.includes('원본 없는 바이브의 정보 추출값'))?.items).toEqual(['복원: 1 → 0.7'])
    expect(plan.lost.find((l) => l.text.includes('NAIS3 에서 쓸 수 없는 인코딩'))?.items).toEqual(['복원 (nai-diffusion-4-5-curated, 0.5)'])
  })
})

describe('errors', () => {
  it('uses BackupError codes for NAIS3 manifests', async () => {
    const bad = craftZip([{ name: 'manifest.json', data: utf8(JSON.stringify({ format: 'NAIP' })) }])
    await expect(readNaisArchive(bytesSource(bad))).rejects.toBeInstanceOf(BackupError)
  })
})
