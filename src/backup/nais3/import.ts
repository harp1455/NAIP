/**
 * NAIS3 .nais → NAIP 데이터 + 변환 보고서.
 * 표 구조는 NAIS3 (© sunanakgo, GPL-3.0) src/main/db/migrations.ts, 해석 규칙은 각 repo
 * (characters/prompts/scenes/refs, shared/precise-reference.ts) 를 따른다.
 *
 * | NAIS3                                | NAIP                                                          |
 * |--------------------------------------|---------------------------------------------------------------|
 * | character_folders / character_prompts| characters.folders / characters.characters, enabled → cast     |
 * | prompt_presets (+params, 3분할)       | presets.presets (가변 칸은 고정 칸 끝에 붙임)                    |
 * | fragment_folders / fragments         | fragments.folders / fragments.fragments                       |
 * | scene_presets / gen_scenes           | scenes.folders(묶음) / scenes.scenes (묶음 캐릭터 지정은 뺌)        |
 * | vibe_images (+인코딩 캐시, .nais3vibe) | vibes.vibes (encodings `${model}|${ie}`)                       |
 * | charref_images (V5 종류 포함)          | charRefs.charRefs (type + sameOutfit)                          |
 * | data/settings.json mainParams        | prompt (작업 중인 프롬프트)                                      |
 * | vibe/charref 폴더, library_*, delta 레퍼런스, 썸네일, 기본 해상도 등 | 보고서의 "옮기지 못한 것"                |
 */
import { fromUtf8, sniffImage, toBase64 } from '../bytes'
import { ReportBuilder, type ConversionReport } from '../report'
import { throwIfAborted, type BackupData, type BackupItem } from '../types'
import { isNais3AssetRef, type Nais3Archive } from './archive'
import type { Nais3Row, Nais3Table, Nais3Value } from './types'
import { isVibeCacheString, parseVibeCache } from './vibe-cache'

export interface Nais3ImportOptions {
  /**
   * 바이브·레퍼런스 원본 → NAIP 가 저장하는 모양 (PNG base64 + 썸네일 data URL).
   * 앱에서는 lib/image 의 toPngBase64(바이브 1536, 레퍼런스 2048) + makeThumb(256) 로 만든다.
   * 없으면 원본 바이트를 그대로 base64 로 두고 썸네일은 NAIS3 썸네일을 쓴다.
   */
  processImage?: (bytes: Uint8Array, mime: string, kind: 'vibe' | 'charRef') => Promise<{ base64: string; thumb: string }>
  /** 새 id 발급 (앱에서는 uid). 없으면 NAIS3 의 id 를 그대로 쓴다 */
  newId?: () => number
  signal?: AbortSignal
}

/** NAIP prompt 스토어의 기본 파라미터 (src/stores/prompt.ts DEFAULT_PARAMS 와 같게 유지) */
export const NAIP_DEFAULT_PARAMS = {
  model: 'nai-diffusion-4-5-full',
  width: 832,
  height: 1216,
  steps: 28,
  cfgScale: 5,
  cfgRescale: 0,
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  variety: false,
  qualityToggle: true,
  ucPreset: 0
} as const

type Params = { -readonly [K in keyof typeof NAIP_DEFAULT_PARAMS]: (typeof NAIP_DEFAULT_PARAMS)[K] extends boolean ? boolean : (typeof NAIP_DEFAULT_PARAMS)[K] extends number ? number : string }

const PARAM_TYPES: Record<keyof Params, 'string' | 'number' | 'boolean'> = {
  model: 'string',
  width: 'number',
  height: 'number',
  steps: 'number',
  cfgScale: 'number',
  cfgRescale: 'number',
  sampler: 'string',
  noiseSchedule: 'string',
  variety: 'boolean',
  qualityToggle: 'boolean',
  ucPreset: 'number'
}

/** NAIS3 정밀 레퍼런스 종류 → NAIP (shared/precise-reference.ts 의 토글 규칙) */
const REF_TYPES: Record<string, { type: 'character' | 'style' | 'character&style' | 'costume'; sameOutfit?: boolean }> = {
  character: { type: 'character', sameOutfit: false },
  character_mainoutfit: { type: 'character', sameOutfit: true },
  style: { type: 'style' },
  'character&style': { type: 'character&style', sameOutfit: true },
  'character&style_anyoutfit': { type: 'character&style', sameOutfit: false },
  costume: { type: 'costume' }
}

const TABLE_LABELS: Record<Nais3Table, string> = {
  character_folders: '캐릭터 폴더',
  character_prompts: '캐릭터',
  fragment_folders: '조각 폴더',
  fragments: '조각',
  vibe_folders: '바이브 폴더',
  vibe_images: '바이브',
  charref_folders: '레퍼런스 폴더',
  charref_images: '정밀 레퍼런스',
  scene_presets: '씬 묶음',
  gen_scenes: '씬',
  prompt_presets: '프롬프트 프리셋',
  library_stacks: '라이브러리 묶음',
  library_images: '라이브러리 그림'
}

function str(v: Nais3Value | undefined): string {
  return typeof v === 'string' ? v : ''
}

function num(v: Nais3Value | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function sorted(rows: Nais3Row[] | undefined): Nais3Row[] {
  return [...(rows ?? [])].sort((a, b) => num(a.sort_order, 0) - num(b.sort_order, 0) || num(a.id, 0) - num(b.id, 0))
}

function parseObject(raw: Nais3Value | undefined): { value: Record<string, unknown> | null; broken: boolean } {
  if (typeof raw !== 'string' || !raw.trim()) return { value: null, broken: false }
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? { value: v as Record<string, unknown>, broken: false } : { value: null, broken: true }
  } catch {
    return { value: null, broken: true }
  }
}

function joinPrompt(...parts: string[]): string {
  return parts.filter((p) => p.trim()).join(', ')
}

/**
 * 3분할 조각을 쓸지 — NAIS3 는 조각을 합친 것이 prompt 와 똑같을 때만 조각을 쓴다
 * (prompt-presets-store partsForApply, generation-store setPromptSplitEnabled). 3분할을 끈 채 prompt 만 고치면
 * 조각은 예전 내용으로 남으므로, 다르면 prompt 가 진짜다.
 */
function freshParts(prompt: string, base: string, additional: string, detail: string): boolean {
  return joinPrompt(base, additional, detail) === prompt
}

function dataUrl(bytes: Uint8Array): string {
  const mime = sniffImage(bytes)?.mime ?? 'image/webp'
  return `data:${mime};base64,${toBase64(bytes)}`
}

/** 파라미터 객체 → NAIP Params (빠진 것은 기본값) */
function mapParams(src: Record<string, unknown>): { params: Params; missing: string[]; invalid: string[] } {
  const params = { ...NAIP_DEFAULT_PARAMS } as Params
  const missing: string[] = []
  const invalid: string[] = []
  for (const [key, type] of Object.entries(PARAM_TYPES) as [keyof Params, string][]) {
    const v = src[key]
    if (v === undefined || v === null) {
      missing.push(key)
      continue
    }
    if (typeof v !== type || (type === 'number' && !Number.isFinite(v))) {
      invalid.push(key)
      continue
    }
    ;(params as Record<string, unknown>)[key] = v
  }
  return { params, missing, invalid }
}

export async function importNais3(archive: Nais3Archive, opts: Nais3ImportOptions = {}): Promise<{ data: BackupData; report: ConversionReport }> {
  const rb = new ReportBuilder()
  const data: BackupData = {}
  const t = archive.tables
  const has = (table: Nais3Table): boolean => Array.isArray(t[table])

  for (const table of archive.manifest.tables) {
    if (!has(table)) rb.notImported(TABLE_LABELS[table], '파일이 손상돼 이 표를 읽지 못했습니다')
  }

  // id: 표마다 NAIS3 id → NAIP id
  const idMaps = new Map<string, Map<number, number>>()
  const idFor = (table: Nais3Table, id: number): number => {
    if (!opts.newId) return id
    let m = idMaps.get(table)
    if (!m) idMaps.set(table, (m = new Map()))
    let n = m.get(id)
    if (n === undefined) m.set(id, (n = opts.newId()))
    return n
  }

  const readAsset = async (v: Nais3Value | undefined): Promise<Uint8Array | null> => {
    throwIfAborted(opts.signal)
    return isNais3AssetRef(v) ? archive.readAsset(v.__asset) : null
  }

  const toImage = async (bytes: Uint8Array, kind: 'vibe' | 'charRef', scope: string, name: string): Promise<{ image: string; thumb: string }> => {
    const sniffed = sniffImage(bytes)
    if (opts.processImage) {
      const r = await opts.processImage(bytes, sniffed?.mime ?? 'application/octet-stream', kind)
      return { image: r.base64, thumb: r.thumb }
    }
    if (sniffed && sniffed.mime !== 'image/png') rb.transformed(scope, `원본이 ${sniffed.ext.toUpperCase()} 라 PNG 로 바꾸지 않고 그대로 보관`, name)
    return { image: toBase64(bytes), thumb: '' }
  }

  // 메인 화면 설정 — 캐릭터 위치 사용 여부(useCoords)가 출연 위치 해석에 필요하다
  let main: Record<string, unknown> | null = null
  if (archive.mainParams) {
    const parsed = parseObject(archive.mainParams)
    main = parsed.value
    if (parsed.broken) rb.notImported('작업 중인 프롬프트', '메인 화면 설정(mainParams)을 읽을 수 없습니다')
  }
  const useCoords = main?.useCoords === true

  // ── 캐릭터 ──
  if (has('character_prompts') || has('character_folders')) {
    const folders: BackupItem[] = []
    const folderIds = new Map<number, number>()
    const folderByName = new Map<string, number>()
    for (const f of sorted(t.character_folders)) {
      const id = idFor('character_folders', f.id as number)
      const name = str(f.name) || '폴더'
      folders.push({ id, name })
      folderIds.set(f.id as number, id)
      folderByName.set(name, id)
      if (f.color || f.collapsed) rb.transformed('캐릭터', '폴더 색·접힘 상태는 NAIP 에 없어 옮기지 않음', name)
    }
    const characters: BackupItem[] = []
    const cast: { charId: number; enabled: boolean; center: { x: number; y: number } | null }[] = []
    for (const c of sorted(t.character_prompts)) {
      const id = idFor('character_prompts', c.id as number)
      const name = str(c.name) || '이름 없음'
      let folderId: number | null = null
      if (typeof c.folder_id === 'number') {
        folderId = folderIds.get(c.folder_id) ?? null
        if (folderId === null) rb.transformed('캐릭터', '없는 폴더를 가리켜 미분류로', name)
      } else if (str(c.folder).trim()) {
        // v1 시절의 글자 폴더 — 같은 이름 폴더에 넣거나 새로 만든다
        const fname = str(c.folder).trim()
        folderId = folderByName.get(fname) ?? null
        if (folderId === null) {
          folderId = opts.newId ? opts.newId() : Math.max(0, ...folders.map((x) => x.id)) + 1
          folders.push({ id: folderId, name: fname })
          folderByName.set(fname, folderId)
        }
        rb.transformed('캐릭터', '예전 형식 폴더 이름을 폴더로', name)
      }
      characters.push({ id, name, folderId, prompt: str(c.prompt), negative: str(c.negative_prompt) })
      if (c.enabled === 1) {
        cast.push({ charId: id, enabled: true, center: useCoords ? { x: num(c.center_x, 0.5), y: num(c.center_y, 0.5) } : null })
      }
      if (c.thumbnail !== null && c.thumbnail !== undefined) rb.notImported('캐릭터', '썸네일 — NAIP 캐릭터에는 썸네일이 없습니다', name)
      const extra = parseObject(c.settings_json)
      if (extra.broken || (extra.value && Object.keys(extra.value).length)) {
        rb.notImported('캐릭터', '캐릭터별 추가 설정(settings_json) — NAIP 에 대응 항목이 없습니다', name)
      }
    }
    if (cast.length) {
      rb.transformed(
        '캐릭터',
        useCoords ? '켜 둔 캐릭터 카드 → 출연(위치 포함, 목록 순서대로)' : '켜 둔 캐릭터 카드 → 출연 (NAIS3 에서 위치 지정이 꺼져 있어 AI 선택 위치로)'
      )
    }
    data.characters = { folders, characters, cast }
    rb.imported('characters', characters.length)
  }

  // ── 프롬프트 프리셋 ──
  if (has('prompt_presets')) {
    const presets: BackupItem[] = []
    for (const p of sorted(t.prompt_presets)) {
      const name = str(p.name) || '프리셋'
      let base = str(p.prompt)
      let detail = ''
      const parts = parseObject(p.prompt_parts_json)
      if (parts.value && typeof parts.value.base === 'string') {
        const additional = typeof parts.value.additional === 'string' ? parts.value.additional : ''
        const partDetail = typeof parts.value.detail === 'string' ? parts.value.detail : ''
        if (!freshParts(base, parts.value.base, additional, partDetail)) {
          rb.transformed('프롬프트 프리셋', '3분할 정보가 지금 프롬프트와 달라(3분할을 끈 뒤 고친 프리셋) NAIS3 처럼 프롬프트 전체를 고정 칸에', name)
        } else {
          base = parts.value.base
          detail = partDetail
          if (additional.trim()) {
            base = joinPrompt(base, additional)
            rb.transformed('프롬프트 프리셋', 'NAIP 프리셋에는 가변 칸이 없어 고정 칸 끝에 붙임 (합친 프롬프트는 같음)', name)
          }
        }
      } else if (parts.broken) {
        rb.transformed('프롬프트 프리셋', '3분할 정보를 읽을 수 없어 합친 프롬프트를 고정 칸에', name)
      }
      const rawParams = parseObject(p.params_json)
      let params: Params = { ...NAIP_DEFAULT_PARAMS }
      if (rawParams.value) {
        const m = mapParams(rawParams.value)
        params = m.params
        if (m.missing.length) rb.transformed('프롬프트 프리셋', `저장되지 않은 파라미터(${m.missing.join(', ')})는 NAIP 기본값으로`, name)
        if (m.invalid.length) rb.notImported('프롬프트 프리셋', `값이 잘못된 파라미터(${m.invalid.join(', ')}) — 기본값을 씀`, name)
        const extra = Object.keys(rawParams.value).filter((k) => !(k in PARAM_TYPES))
        if (extra.length) rb.notImported('프롬프트 프리셋', `NAIP 프리셋에 없는 파라미터(${extra.join(', ')})`, name)
      } else if (rawParams.broken) {
        rb.notImported('프롬프트 프리셋', '파라미터를 읽을 수 없어 NAIP 기본값을 씀', name)
      } else {
        rb.transformed('프롬프트 프리셋', '파라미터 없이 저장된 프리셋 → NAIP 기본값으로', name)
      }
      presets.push({ id: idFor('prompt_presets', p.id as number), name, base, detail, negative: str(p.negative_prompt), params })
    }
    data.presets = { presets }
    rb.imported('presets', presets.length)
  }

  // ── 조각 ──
  if (has('fragments') || has('fragment_folders')) {
    const folders: BackupItem[] = []
    const folderIds = new Map<number, number>()
    for (const f of sorted(t.fragment_folders)) {
      const id = idFor('fragment_folders', f.id as number)
      const name = str(f.name) || '폴더'
      folders.push({ id, name })
      folderIds.set(f.id as number, id)
      if (f.color || f.collapsed) rb.transformed('조각', '폴더 색·접힘 상태는 NAIP 에 없어 옮기지 않음', name)
    }
    const fragments: BackupItem[] = []
    for (const f of sorted(t.fragments)) {
      const name = str(f.name) || '이름 없음'
      let folderId: number | null = null
      if (typeof f.folder_id === 'number') {
        folderId = folderIds.get(f.folder_id) ?? null
        if (folderId === null) rb.transformed('조각', '없는 폴더를 가리켜 미분류로', name)
      }
      fragments.push({ id: idFor('fragments', f.id as number), name, folderId, content: str(f.content) })
    }
    data.fragments = { folders, fragments }
    rb.imported('fragments', fragments.length)
  }

  // ── 씬 ──
  if (has('gen_scenes') || has('scene_presets')) {
    const folders: BackupItem[] = []
    const presetInfo = new Map<number, { id: number; name: string; order: number }>()
    sorted(t.scene_presets).forEach((p, order) => {
      const id = idFor('scene_presets', p.id as number)
      const name = str(p.name) || '묶음'
      folders.push({ id, name })
      // 묶음의 캐릭터 지정(character_ids)은 NAIS3 1.0.33 이 생성에 쓰지 않는 예전 값이다 — NAIS3 의 씬은
      // 사이드바에서 켠 캐릭터(또는 씬 출연)로 생성된다. NAIP 씬 출연(cast)으로 옮기면 생성되는 캐릭터가 달라지므로
      // 옮기지 않는다 (씬은 프롬프트 화면 출연을 따른다 — NAIS3 와 같게)
      if (typeof p.character_ids === 'string' && p.character_ids.trim()) {
        rb.notImported('씬', '묶음의 캐릭터 지정 — NAIS3 가 생성에 쓰지 않는 예전 값이라 가져오지 않음 (씬은 프롬프트 화면 출연을 따름)', name)
      }
      presetInfo.set(p.id as number, { id, name, order })
      if (p.default_width !== null && p.default_width !== undefined) {
        rb.notImported('씬', '묶음의 새 씬 기본 해상도 — NAIP 에 대응 항목이 없습니다', `${name} (${String(p.default_width)}×${String(p.default_height)})`)
      }
    })
    const scenes: BackupItem[] = []
    const rows = [...(t.gen_scenes ?? [])].sort(
      (a, b) =>
        (presetInfo.get(a.preset_id as number)?.order ?? 1e9) - (presetInfo.get(b.preset_id as number)?.order ?? 1e9) ||
        num(a.sort_order, 0) - num(b.sort_order, 0) ||
        num(a.id, 0) - num(b.id, 0)
    )
    for (const s of rows) {
      const name = str(s.name) || '이름 없는 씬'
      const preset = presetInfo.get(s.preset_id as number)
      if (!preset) rb.transformed('씬', '없는 묶음을 가리켜 미분류로', name)
      const scene: BackupItem = {
        id: idFor('gen_scenes', s.id as number),
        name,
        folderId: preset?.id ?? null,
        prompt: str(s.prompt),
        negative: str(s.negative_prompt),
        size: { width: num(s.width, 832), height: num(s.height, 1216) },
        reserve: Math.min(999, Math.max(0, Math.round(num(s.reserve_count, 0))))
      }
      const reserves = parseObject(s.reserve_json).value
      if (reserves && Object.entries(reserves).some(([k, v]) => k !== '' && typeof v === 'number' && v > 0)) {
        rb.transformed('씬', '출연(캐스트)별 예약 → 합계 예약으로 (캐스트 구성은 .nais 에 없음)', name)
      }
      if (num(s.reserve_count, 0) > 999) rb.transformed('씬', '예약 수를 NAIP 최대(999)로 줄임', name)
      scenes.push(scene)
    }
    data.scenes = { folders, scenes }
    rb.imported('scenes', scenes.length)
  }

  // ── 바이브 ──
  if (has('vibe_images')) {
    const folderNames = new Map((t.vibe_folders ?? []).map((f) => [f.id as number, str(f.name)]))
    const vibes: BackupItem[] = []
    for (const v of sorted(t.vibe_images)) {
      const name = str(v.name) || '바이브'
      const path = isNais3AssetRef(v.file_path) ? v.file_path.__asset : ''
      const encodedOnly = /\.nais3vibe$/i.test(path)
      const bytes = await readAsset(v.file_path)
      const encodedIe = typeof v.encoded_ie === 'number' ? v.encoded_ie : null
      const encodedCol = typeof v.encoded === 'string' ? v.encoded : null
      const cache = parseVibeCache(encodedCol, encodedIe)
      if (encodedCol && !isVibeCacheString(encodedCol) && encodedIe !== null) {
        rb.transformed('바이브', '예전 형식 인코딩 → 4.5 Full 인코딩으로', name)
      }
      if (encodedOnly && bytes) {
        let fileText = ''
        try {
          fileText = fromUtf8(bytes)
        } catch {
          fileText = ''
        }
        // 파일과 열이 다르면 열(마지막 저장값)을 우선한다
        Object.assign(cache, { ...parseVibeCache(fileText, null), ...cache })
      }
      const encodings: Record<string, string> = {}
      for (const [model, e] of Object.entries(cache)) encodings[`${model}|${e.ie}`] = e.data
      let image = ''
      let thumb = ''
      if (!encodedOnly && bytes) ({ image, thumb } = await toImage(bytes, 'vibe', '바이브', name))
      if (!thumb) {
        const tb = await readAsset(v.thumbnail)
        if (tb) thumb = dataUrl(tb)
      }
      if (!image && !Object.keys(encodings).length) {
        rb.notImported('바이브', '원본 그림과 인코딩이 모두 없어 쓸 수 없음', name)
        continue
      }
      if (encodedOnly) rb.transformed('바이브', '메타데이터에서 되살린 인코딩 전용 바이브 → 원본 없는 바이브로 (저장된 모델·정보 추출값으로만 사용)', name)
      else if (!bytes) rb.transformed('바이브', '원본 그림을 읽지 못해 인코딩만 가져옴 (다시 인코딩할 수 없음)', name)
      if (typeof v.folder_id === 'number') {
        rb.notImported('바이브', 'NAIP 에는 바이브 폴더가 없어 폴더 구분 없이 가져옴', `${name} (${folderNames.get(v.folder_id) ?? '?'})`)
      }
      vibes.push({
        id: idFor('vibe_images', v.id as number),
        name,
        image,
        thumb,
        strength: num(v.strength, 0.6),
        infoExtracted: num(v.info_extracted, 1),
        enabled: v.enabled === 1,
        encodings
      })
    }
    data.vibes = { vibes }
    rb.imported('vibes', vibes.length)
  }

  // ── 정밀 레퍼런스 ──
  if (has('charref_images')) {
    const folderNames = new Map((t.charref_folders ?? []).map((f) => [f.id as number, str(f.name)]))
    const charRefs: BackupItem[] = []
    for (const r of sorted(t.charref_images)) {
      const name = str(r.name) || '레퍼런스'
      const refType = str(r.ref_type) || 'character&style'
      const mapped = REF_TYPES[refType]
      if (!mapped) {
        rb.notImported('정밀 레퍼런스', `NAIP 가 지원하지 않는 레퍼런스 종류(${refType})`, name)
        continue
      }
      const bytes = await readAsset(r.file_path)
      if (!bytes) {
        rb.notImported('정밀 레퍼런스', '원본 그림을 읽지 못함', name)
        continue
      }
      let { image, thumb } = await toImage(bytes, 'charRef', '정밀 레퍼런스', name)
      if (!thumb) {
        const tb = await readAsset(r.thumbnail)
        if (tb) thumb = dataUrl(tb)
      }
      if (refType === 'character_mainoutfit' || refType === 'character&style_anyoutfit') {
        rb.transformed('정밀 레퍼런스', 'V5 "같은 의상 선호" 종류 → 종류 + 같은 의상 선호 켬/끔', `${name}: ${refType}`)
      }
      if (typeof r.folder_id === 'number') {
        rb.notImported('정밀 레퍼런스', 'NAIP 에는 레퍼런스 폴더가 없어 폴더 구분 없이 가져옴', `${name} (${folderNames.get(r.folder_id) ?? '?'})`)
      }
      charRefs.push({
        id: idFor('charref_images', r.id as number),
        name,
        image,
        thumb,
        type: mapped.type,
        ...(mapped.sameOutfit === undefined ? {} : { sameOutfit: mapped.sameOutfit }),
        strength: num(r.strength, 1),
        fidelity: num(r.fidelity, 1),
        enabled: r.enabled === 1
      })
    }
    data.charRefs = { charRefs }
    rb.imported('charRefs', charRefs.length)
  }

  // ── 폴더만 있는 표·라이브러리 ──
  if (has('vibe_folders') && !has('vibe_images')) {
    for (const f of t.vibe_folders ?? []) rb.notImported('바이브', 'NAIP 에는 바이브 폴더가 없음', str(f.name))
  }
  if (has('charref_folders') && !has('charref_images')) {
    for (const f of t.charref_folders ?? []) rb.notImported('정밀 레퍼런스', 'NAIP 에는 레퍼런스 폴더가 없음', str(f.name))
  }
  for (const s of t.library_stacks ?? []) rb.notImported('라이브러리', 'NAIP 에는 라이브러리가 없어 묶음을 가져오지 않음', str(s.name))
  for (const img of t.library_images ?? []) rb.notImported('라이브러리', 'NAIP 에는 라이브러리가 없어 그림을 가져오지 않음', str(img.name) || `#${String(img.id)}`)

  // ── 작업 중인 프롬프트 (mainParams) ──
  if (main) {
    const s = (v: unknown): string => (typeof v === 'string' ? v : '')
    let parts = main.promptParts && typeof main.promptParts === 'object' ? (main.promptParts as Record<string, unknown>) : null
    // 조각이 지금 prompt 와 다르면(3분할을 끈 뒤 고친 것) NAIS3 처럼 prompt 를 쓴다
    if (parts && !(typeof parts.base === 'string' && freshParts(s(main.prompt), parts.base, s(parts.additional), s(parts.detail)))) {
      parts = null
      rb.transformed('작업 중인 프롬프트', '3분할 정보가 지금 프롬프트와 달라(3분할을 끈 뒤 고친 것) NAIS3 처럼 프롬프트 전체를 고정 칸에')
    }
    const m = mapParams(main)
    if (m.missing.length) rb.transformed('작업 중인 프롬프트', `저장되지 않은 파라미터(${m.missing.join(', ')})는 NAIP 기본값으로`)
    if (m.invalid.length) rb.notImported('작업 중인 프롬프트', `값이 잘못된 파라미터(${m.invalid.join(', ')}) — 기본값을 씀`)
    data.prompt = {
      base: parts && typeof parts.base === 'string' ? parts.base : s(main.prompt),
      additional: parts ? s(parts.additional) : '',
      detail: parts ? s(parts.detail) : '',
      negative: s(main.negativePrompt),
      params: m.params,
      seed: ''
    }
    if (typeof main.seed === 'number' && main.seed >= 0) {
      rb.transformed('작업 중인 프롬프트', '시드 고정 여부는 .nais 에 없어 무작위(빈 칸)로', `시드 ${main.seed}`)
    }
    const known = new Set([...Object.keys(PARAM_TYPES), 'prompt', 'promptParts', 'negativePrompt', 'seed', 'useCoords', 'characterPrompts'])
    for (const [k, v] of Object.entries(main)) {
      if (known.has(k) || v === undefined || v === null || v === false) continue
      rb.notImported('작업 중인 프롬프트', `NAIP 에 없는 생성 설정(${k})`)
    }
    rb.imported('prompt', 1)
  }

  if (Object.keys(data).some((k) => ['characters', 'scenes', 'fragments', 'presets'].includes(k))) {
    rb.transformed('공통', '생성·수정 시각과 정렬 번호는 저장하지 않고 목록 순서로만 옮김')
  }
  // 그림은 읽는 동안 문제가 쌓이므로 끝에서 모은다
  for (const p of archive.problems) rb.problem(p)
  return { data, report: rb.report }
}
