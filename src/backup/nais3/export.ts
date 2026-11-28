/**
 * NAIP → NAIS3 .nais 내보내기 (최선 노력). 캐릭터·프롬프트 프리셋·조각·씬(+작업 중인 프롬프트),
 * 원하면 바이브·정밀 레퍼런스까지 NAIS3 표 모양(src/main/db/migrations.ts)으로 바꾼다.
 * NAIS3 에 없는 NAIP 전용 데이터는 lost 목록으로 돌려준다 (내보내기 전에 보여 줄 것).
 *
 * NAIS3 가 이 파일을 가져오면 들어 있는 표를 통째로 바꾼다 (repo.ts restoreBackupDatabase).
 * 그래서 데이터가 없는 섹션의 표는 넣지 않는다.
 */
import { fromBase64, sniffImage, utf8 } from '../bytes'
import type { ByteSink } from '../io'
import type { ReportLine } from '../report'
import { DATA_SECTION_IDS, SECTION_LABELS, type BackupData, type DataSectionId } from '../types'
import { writeNaisArchive, type Nais3Output, type Nais3OutRow } from './archive'
import type { Nais3Table } from './types'
import { packVibeCache, type VibeCache } from './vibe-cache'

export type Nais3ExportSection = 'characters' | 'presets' | 'fragments' | 'scenes' | 'prompt' | 'vibes' | 'charRefs'

export const DEFAULT_NAIS3_EXPORT: readonly Nais3ExportSection[] = ['characters', 'presets', 'fragments', 'scenes', 'prompt']

export interface Nais3ExportPlan {
  output: Nais3Output
  exported: { section: DataSectionId; label: string; count: number }[]
  /** NAIS3 로 옮기지 못하는(잃게 되는) NAIP 데이터 */
  lost: ReportLine[]
}

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function items(v: unknown): Obj[] {
  return Array.isArray(v) ? v.filter(isObj) : []
}

function s(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function n(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function joinPrompt(...parts: string[]): string {
  return parts.filter((p) => p.trim()).join(', ')
}

const PARAM_KEYS = ['model', 'width', 'height', 'steps', 'cfgScale', 'cfgRescale', 'sampler', 'noiseSchedule', 'variety', 'qualityToggle', 'ucPreset']
/** NAIS3 메인 화면(GenerationRequest)에는 있지만 프리셋(PresetParams)에는 없는 파라미터 */
const MAIN_ONLY_PARAM_KEYS = ['transparentBackground']

class Lost {
  readonly lines: ReportLine[] = []
  private readonly byKey = new Map<string, ReportLine>()
  add(scope: string, text: string, item?: string, count = 1): void {
    const key = `${scope}\u0000${text}`
    let line = this.byKey.get(key)
    if (!line) {
      line = { scope, text, count: 0, items: [] }
      this.byKey.set(key, line)
      this.lines.push(line)
    }
    line.count = (line.count ?? 0) + count
    if (item !== undefined && line.items!.length < 20) line.items!.push(item)
  }
}

function extraKeys(item: Obj, known: string[]): string[] {
  return Object.keys(item).filter((k) => !known.includes(k) && item[k] !== undefined)
}

export function naipToNais3(data: BackupData, opts: { sections?: readonly Nais3ExportSection[] } = {}): Nais3ExportPlan {
  const want = new Set(opts.sections ?? DEFAULT_NAIS3_EXPORT)
  const lost = new Lost()
  const tables: Partial<Record<Nais3Table, Nais3OutRow[]>> = {}
  const included: Nais3Table[] = []
  const exported: Nais3ExportPlan['exported'] = []
  const use = (table: Nais3Table, rows: Nais3OutRow[]): void => {
    tables[table] = rows
    included.push(table)
  }
  // NAIS3 는 들어 있는 표를 통째로 바꾸므로, 항목이 하나도 없는 섹션은 표를 넣지 않는다 (NAIS3 쪽 것을 지우지 않게)
  const empty = (section: Nais3ExportSection, count: number): boolean => {
    if (count > 0) return false
    lost.add(SECTION_LABELS[section], '내보낼 항목이 없어 넣지 않음 — NAIS3 쪽 것은 그대로 둡니다')
    return true
  }

  // ── 캐릭터 ──
  let anyCenter = false
  const ch = want.has('characters') && isObj(data.characters) ? data.characters : null
  if (ch && !empty('characters', items(ch.characters).length)) {
    const folderIds = new Map<number, number>()
    const folderRows: Nais3OutRow[] = items(ch.folders).map((f, i) => {
      folderIds.set(n(f.id, NaN), i + 1)
      return { id: i + 1, name: s(f.name) || '폴더', sort_order: i, collapsed: 0, color: null }
    })
    const cast = new Map<number, { enabled: boolean; center: { x: number; y: number } | null; order: number }>()
    // ── Phase 4 UI: Phase 2 출연 슬롯(slots)도 받는다 — 고정 슬롯만 NAIS3 카드 켜기로 옮기고 나머지는 잃는 것으로
    const legacyCast = Array.isArray(ch.cast)
    const castEntries = legacyCast
      ? items(ch.cast)
      : items(ch.slots).flatMap((slot) => {
          if (slot.mode !== undefined && slot.mode !== 'fixed') {
            lost.add('캐릭터', '무작위·순차·확률 출연 슬롯 — NAIS3 에 없음')
            return []
          }
          return [{ charId: slot.charId, enabled: slot.enabled, center: slot.center }]
        })
    castEntries.forEach((e, order) => {
      if (typeof e.charId !== 'number' || cast.has(e.charId)) return
      const center = isObj(e.center) ? { x: n(e.center.x, 0.5), y: n(e.center.y, 0.5) } : null
      cast.set(e.charId, { enabled: e.enabled !== false, center, order })
    })
    const chars = items(ch.characters)
    const rows: Nais3OutRow[] = chars.map((c, i) => {
      const id = i + 1
      const name = s(c.name) || '이름 없음'
      const e = cast.get(n(c.id, NaN))
      if (e && !e.enabled) lost.add('캐릭터', '출연 목록에 넣고 꺼 둔 상태 — NAIS3 에는 카드 켜기/끄기만 있음', name)
      if (e?.enabled && !e.center) lost.add('캐릭터', '캐릭터별 AI 선택 위치 — NAIS3 는 위치 사용을 전체 설정 하나로만 정함', name)
      if (e?.enabled && e.center) anyCenter = true
      // Phase 2 캐릭터: 고정·(고정으로 고른 변형)·가변·디테일을 NAIS3 프롬프트 한 칸으로 (보내는 캡션과 같은 순서)
      const split = typeof c.prompt !== 'string' && (typeof c.base === 'string' || typeof c.additional === 'string' || typeof c.detail === 'string')
      const picked: string[] = []
      const groups = Array.isArray(c.variations) ? items(c.variations) : []
      if (groups.length) {
        for (const g of groups) {
          const list = items(g.items)
          if (g.mode === 'fixed') {
            const item = list.find((x) => x.id === g.fixedId) ?? list[0]
            if (item && s(item.prompt).trim()) picked.push(s(item.prompt))
          }
        }
        lost.add('캐릭터', '변형 그룹(복장·표정 등) — NAIS3 에 없어 고정으로 고른 항목만 프롬프트에 넣음', name)
      }
      if (split && (s(c.additional).trim() || s(c.detail).trim())) {
        lost.add('캐릭터', '고정·가변·디테일 3분할 — NAIS3 에서는 프롬프트 한 칸으로 합침', name)
      }
      const prompt = split ? joinPrompt(s(c.base), ...picked, s(c.additional), s(c.detail)) : s(c.prompt)
      const extra = extraKeys(c, ['id', 'name', 'folderId', 'prompt', 'negative', 'base', 'additional', 'detail', 'variations'])
      if (extra.length) lost.add('캐릭터', `NAIP 전용 캐릭터 항목(${extra.join(', ')})`, name)
      const folderId = typeof c.folderId === 'number' ? (folderIds.get(c.folderId) ?? null) : null
      return {
        id,
        name,
        prompt,
        negative_prompt: s(c.negative),
        settings_json: '{}',
        sort_order: i,
        enabled: e?.enabled ? 1 : 0,
        center_x: e?.center?.x ?? 0.5,
        center_y: e?.center?.y ?? 0.5,
        folder_id: folderId
      }
    })
    // 출연 순서가 목록 순서와 다르면 NAIS3 에서는 목록 순서로 보낸다
    const castOrder = [...cast.entries()].filter(([, e]) => e.enabled).sort((a, b) => a[1].order - b[1].order).map(([id]) => id)
    const listOrder = chars.map((c) => n(c.id, NaN)).filter((id) => castOrder.includes(id))
    if (castOrder.join(',') !== listOrder.join(',')) lost.add('캐릭터', '출연 순서 — NAIS3 는 캐릭터 목록 순서대로 보냄')
    const known = ['folders', 'characters', 'cast', 'version', ...(Array.isArray(ch.slots) ? ['slots', 'options'] : [])]
    const extraSection = Object.keys(ch).filter((k) => !known.includes(k))
    if (extraSection.length) lost.add('캐릭터', `NAIP 전용 캐릭터 데이터(${extraSection.join(', ')})`)
    const opts = isObj(ch.options) ? ch.options : null
    if (Array.isArray(ch.slots) && opts && (opts.allowDuplicates || opts.perScene || opts.autoCountTags || (opts.scope && opts.scope !== 'image'))) {
      lost.add('캐릭터', '출연 옵션(중복 허용·뽑기 범위·씬마다 뽑기·인원 태그 고치기) — NAIS3 에 없음')
    }
    use('character_folders', folderRows)
    use('character_prompts', rows)
    exported.push({ section: 'characters', label: SECTION_LABELS.characters, count: rows.length })
  }

  // ── 프롬프트 프리셋 ──
  const pr = want.has('presets') && isObj(data.presets) ? data.presets : null
  if (pr && !empty('presets', items(pr.presets).length)) {
    const rows: Nais3OutRow[] = items(pr.presets).map((p, i) => {
      const name = s(p.name) || '프리셋'
      const params = isObj(p.params) ? Object.fromEntries(PARAM_KEYS.filter((k) => p.params && (p.params as Obj)[k] !== undefined).map((k) => [k, (p.params as Obj)[k]])) : null
      const extra = extraKeys(p, ['id', 'name', 'base', 'detail', 'negative', 'params'])
      if (extra.length) lost.add('프롬프트 프리셋', `NAIP 전용 프리셋 항목(${extra.join(', ')})`, name)
      if (isObj(p.params) && p.params.transparentBackground === true) lost.add('프롬프트 프리셋', '배경 투명 — NAIS3 프리셋에는 이 설정이 없음', name)
      return {
        id: i + 1,
        name,
        prompt: joinPrompt(s(p.base), s(p.detail)),
        negative_prompt: s(p.negative),
        sort_order: i,
        params_json: params ? JSON.stringify(params) : null,
        prompt_parts_json: JSON.stringify({ base: s(p.base), additional: '', detail: s(p.detail) })
      }
    })
    use('prompt_presets', rows)
    exported.push({ section: 'presets', label: SECTION_LABELS.presets, count: rows.length })
  }

  // ── 조각 ──
  const fr = want.has('fragments') && isObj(data.fragments) ? data.fragments : null
  if (fr && !empty('fragments', items(fr.fragments).length)) {
    const folderIds = new Map<number, number>()
    const folderRows: Nais3OutRow[] = items(fr.folders).map((f, i) => {
      folderIds.set(n(f.id, NaN), i + 1)
      return { id: i + 1, name: s(f.name) || '폴더', sort_order: i, collapsed: 0, color: null }
    })
    // NAIS3 조각 이름은 전체에서 하나뿐이어야 한다 (fragments.name UNIQUE) — fragments/repo.ts uniqueName 규칙
    const taken = new Set<string>()
    const rows: Nais3OutRow[] = items(fr.fragments).map((f, i) => {
      const base = s(f.name) || '이름 없음'
      let name = base
      for (let k = 2; taken.has(name); k++) name = `${base}-${k}`
      taken.add(name)
      if (name !== base) lost.add('조각', 'NAIS3 는 폴더가 달라도 조각 이름이 겹칠 수 없어 이름을 바꿈 — <이름> 참조를 확인하세요', `${base} → ${name}`)
      return {
        id: i + 1,
        name,
        content: s(f.content),
        sort_order: i,
        folder_id: typeof f.folderId === 'number' ? (folderIds.get(f.folderId) ?? null) : null
      }
    })
    use('fragment_folders', folderRows)
    use('fragments', rows)
    exported.push({ section: 'fragments', label: SECTION_LABELS.fragments, count: rows.length })
  }

  // ── 씬 ──
  const prompt = isObj(data.prompt) ? data.prompt : null
  const mainSize = isObj(prompt?.params) ? { width: n(prompt!.params.width, 832), height: n(prompt!.params.height, 1216) } : { width: 832, height: 1216 }
  const sc = want.has('scenes') && isObj(data.scenes) ? data.scenes : null
  if (sc && !empty('scenes', items(sc.scenes).length)) {
    const folders = items(sc.folders)
    const scenes = items(sc.scenes)
    const presetIds = new Map<number, number>()
    folders.forEach((f, i) => presetIds.set(n(f.id, NaN), i + 1))
    const presetOf = (scene: Obj): number | null => (typeof scene.folderId === 'number' ? (presetIds.get(scene.folderId) ?? null) : null)
    // 묶음 없는 씬은 NAIS3 의 기본 묶음으로 (gen_scenes.preset_id 는 비울 수 없다)
    const needDefault = scenes.some((x) => presetOf(x) === null)
    const defaultId = folders.length + 1
    // 묶음의 캐릭터 지정(character_ids)은 NAIS3 1.0.33 이 생성에 쓰지 않는 값이라 채우지 않는다 — 씬 출연은 잃는 것으로 알린다
    const presetRows: Nais3OutRow[] = folders.map((f, i) => ({
      id: i + 1,
      name: s(f.name) || '묶음',
      sort_order: i,
      default_width: null,
      default_height: null,
      character_ids: null
    }))
    if (needDefault) presetRows.push({ id: defaultId, name: '기본', sort_order: presetRows.length, default_width: null, default_height: null, character_ids: null })
    const orderIn = new Map<number, number>()
    const rows: Nais3OutRow[] = scenes.map((x, i) => {
      const name = s(x.name) || '이름 없는 씬'
      const preset = presetOf(x) ?? defaultId
      const order = orderIn.get(preset) ?? 0
      orderIn.set(preset, order + 1)
      const size = isObj(x.size) ? { width: n(x.size.width, mainSize.width), height: n(x.size.height, mainSize.height) } : null
      if (!size) lost.add('씬', `메인 해상도를 따르던 씬 → 내보낼 때의 해상도(${mainSize.width}×${mainSize.height})로 고정`, name)
      if (Array.isArray(x.cast)) lost.add('씬', '씬별 출연 캐릭터 — NAIS3 에는 씬마다 쓰는 출연 지정이 없어, NAIS3 에서는 켜 둔 캐릭터 카드로 생성됩니다', name)
      if (isObj(x.castCenters) && Object.keys(x.castCenters).length) lost.add('씬', '씬별 출연 위치 — NAIS3 는 캐릭터 카드의 위치를 씀', name)
      const extra = extraKeys(x, ['id', 'name', 'folderId', 'prompt', 'negative', 'size', 'cast', 'castCenters', 'reserve'])
      if (extra.length) lost.add('씬', `NAIP 전용 씬 항목(${extra.join(', ')})`, name)
      const reserve = Math.max(0, Math.round(n(x.reserve, 0)))
      return {
        id: i + 1,
        preset_id: preset,
        name,
        prompt: s(x.prompt),
        negative_prompt: s(x.negative),
        width: size?.width ?? mainSize.width,
        height: size?.height ?? mainSize.height,
        sort_order: order,
        reserve_count: reserve,
        reserve_json: reserve > 0 ? JSON.stringify({ '': reserve }) : null
      }
    })
    use('scene_presets', presetRows)
    use('gen_scenes', rows)
    exported.push({ section: 'scenes', label: SECTION_LABELS.scenes, count: rows.length })
    lost.add('씬', 'NAIS3 에서 가져오면 NAIS3 쪽 씬과 생성 이미지의 연결이 풀립니다 (NAIS3 동작)')
  }

  // ── 바이브 ──
  const vb = want.has('vibes') && isObj(data.vibes) ? data.vibes : null
  if (vb && !empty('vibes', items(vb.vibes).length)) {
    const rows: Nais3OutRow[] = []
    for (const [i, v] of items(vb.vibes).entries()) {
      const name = s(v.name) || '바이브'
      const ie = n(v.infoExtracted, 1)
      // NAIS3 캐시는 모델마다 인코딩 하나 — 지금 정보 추출값의 것을 고르고 나머지는 잃는다
      const byModel = new Map<string, { ie: number; data: string }[]>()
      for (const [key, value] of Object.entries(isObj(v.encodings) ? v.encodings : {})) {
        const cut = key.lastIndexOf('|')
        const keyIe = Number(key.slice(cut + 1))
        if (cut <= 0 || typeof value !== 'string' || !Number.isFinite(keyIe)) continue
        const list = byModel.get(key.slice(0, cut)) ?? []
        list.push({ ie: keyIe, data: value })
        byModel.set(key.slice(0, cut), list)
      }
      const image = s(v.image)
      // 원본 없는 바이브는 NAIS3 에서 다시 인코딩할 수 없어 정보 추출값이 저장된 인코딩의 값으로 고정되고,
      // 그 값의 인코딩이 없으면 생성이 실패한다 — 행의 값을 인코딩이 있는 값으로 맞춘다
      // (지금 값의 인코딩이 있으면 그대로, 없으면 가장 많은 모델이 가진 값)
      let rowIe = ie
      if (!image && byModel.size && ![...byModel.values()].some((list) => list.some((e) => e.ie === ie))) {
        const tally = new Map<number, number>()
        for (const list of byModel.values()) for (const x of new Set(list.map((e) => e.ie))) tally.set(x, (tally.get(x) ?? 0) + 1)
        rowIe = [...tally.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0]
        lost.add('바이브', '원본 없는 바이브의 정보 추출값 → 저장된 인코딩의 값으로 (NAIS3 는 원본 없이 다시 인코딩할 수 없음)', `${name}: ${ie} → ${rowIe}`)
      }
      const cache: VibeCache = {}
      for (const [model, list] of byModel) {
        cache[model] = list.find((e) => e.ie === rowIe) ?? list[0]
        if (list.length > 1) {
          lost.add('바이브', '같은 모델의 다른 정보 추출값 인코딩 — NAIS3 는 모델마다 하나만 보관', `${name} (${model})`, list.length - 1)
        }
        if (!image && cache[model].ie !== rowIe) {
          lost.add('바이브', '원본이 없고 정보 추출값이 달라 NAIS3 에서 쓸 수 없는 인코딩', `${name} (${model}, ${cache[model].ie})`)
        }
      }
      const packed = Object.keys(cache).length ? packVibeCache(cache) : null
      let file: { file: Uint8Array; ext: string }
      if (image) {
        const bytes = fromBase64(image)
        file = { file: bytes, ext: `.${sniffImage(bytes)?.ext ?? 'png'}` }
      } else if (packed) {
        // 원본 없는 바이브 = NAIS3 의 인코딩 전용 바이브 (파일 내용이 곧 캐시)
        file = { file: utf8(packed), ext: '.nais3vibe' }
      } else {
        lost.add('바이브', '원본 그림도 인코딩도 없어 내보낼 수 없음', name)
        continue
      }
      const thumb = s(v.thumb)
      rows.push({
        id: rows.length + 1,
        name,
        file_path: file,
        thumbnail: thumb ? fromBase64(thumb) : null,
        enabled: v.enabled ? 1 : 0,
        strength: n(v.strength, 0.6),
        info_extracted: rowIe,
        encoded: packed,
        encoded_ie: packed ? rowIe : null,
        folder_id: null,
        sort_order: i
      })
    }
    if (!empty('vibes', rows.length)) {
      use('vibe_images', rows)
      exported.push({ section: 'vibes', label: SECTION_LABELS.vibes, count: rows.length })
    }
  }

  // ── 정밀 레퍼런스 ──
  const cr = want.has('charRefs') && isObj(data.charRefs) ? data.charRefs : null
  if (cr && !empty('charRefs', items(cr.charRefs).length)) {
    const rows: Nais3OutRow[] = []
    for (const [i, r] of items(cr.charRefs).entries()) {
      const name = s(r.name) || '레퍼런스'
      const image = s(r.image)
      if (!image) {
        lost.add('정밀 레퍼런스', '원본 그림이 없어 내보낼 수 없음', name)
        continue
      }
      const type = s(r.type) || 'character&style'
      const refType =
        type === 'character'
          ? r.sameOutfit === true
            ? 'character_mainoutfit'
            : 'character'
          : type === 'character&style'
            ? r.sameOutfit === false
              ? 'character&style_anyoutfit'
              : 'character&style'
            : type
      const bytes = fromBase64(image)
      const thumb = s(r.thumb)
      rows.push({
        id: rows.length + 1,
        name,
        file_path: { file: bytes, ext: `.${sniffImage(bytes)?.ext ?? 'png'}` },
        thumbnail: thumb ? fromBase64(thumb) : null,
        enabled: r.enabled ? 1 : 0,
        ref_type: refType,
        strength: n(r.strength, 1),
        fidelity: n(r.fidelity, 1),
        folder_id: null,
        sort_order: i
      })
    }
    if (!empty('charRefs', rows.length)) {
      use('charref_images', rows)
      exported.push({ section: 'charRefs', label: SECTION_LABELS.charRefs, count: rows.length })
    }
  }

  // ── 작업 중인 프롬프트 → mainParams ──
  let mainParams: string | null = null
  if (want.has('prompt') && prompt) {
    const params = isObj(prompt.params) ? prompt.params : {}
    const seedNum = Number(s(prompt.seed))
    const request: Obj = {
      prompt: joinPrompt(s(prompt.base), s(prompt.additional), s(prompt.detail)),
      promptParts: { base: s(prompt.base), additional: s(prompt.additional), detail: s(prompt.detail) },
      negativePrompt: s(prompt.negative),
      ...Object.fromEntries([...PARAM_KEYS, ...MAIN_ONLY_PARAM_KEYS].filter((k) => params[k] !== undefined).map((k) => [k, params[k]])),
      seed: s(prompt.seed).trim() && Number.isInteger(seedNum) && seedNum >= 0 ? seedNum : -1,
      useCoords: anyCenter
    }
    mainParams = JSON.stringify(request)
    const extra = Object.keys(prompt).filter((k) => !['base', 'additional', 'detail', 'negative', 'params', 'seed'].includes(k))
    if (extra.length) lost.add('작업 중인 프롬프트', `NAIS3 메인 화면에 없는 항목(${extra.join(', ')})`)
    exported.push({ section: 'prompt', label: SECTION_LABELS.prompt, count: 1 })
  }

  // ── NAIS3 에 없는 섹션 ──
  for (const id of DATA_SECTION_IDS) {
    const present = (data as Record<string, unknown>)[id] != null
    if (!present) continue
    const exportable = ['characters', 'presets', 'fragments', 'scenes', 'prompt', 'vibes', 'charRefs'].includes(id)
    if (exportable && want.has(id as Nais3ExportSection)) continue
    lost.add(SECTION_LABELS[id], exportable ? '내보내기에서 고르지 않음' : 'NAIS3 에 대응 항목이 없는 NAIP 전용 데이터')
  }
  lost.add('공통', 'NAIS3 에서 이 파일을 가져오면 들어 있는 항목(캐릭터·프리셋 등)이 NAIS3 쪽에서 이 내용으로 통째로 바뀝니다')

  return { output: { includedTables: included, tables, mainParams }, exported, lost: lost.lines }
}

/** NAIS3 가 읽을 수 있는 .nais 를 sink 에 쓴다 */
export async function exportNais3(
  data: BackupData,
  sink: ByteSink,
  opts: { appVersion: string; createdAt?: string; sections?: readonly Nais3ExportSection[]; signal?: AbortSignal }
): Promise<{ bytes: number } & Omit<Nais3ExportPlan, 'output'>> {
  const plan = naipToNais3(data, opts)
  const { bytes } = await writeNaisArchive(plan.output, sink, { appVersion: `${opts.appVersion} (NAIP)`, createdAt: opts.createdAt, signal: opts.signal })
  return { bytes, exported: plan.exported, lost: plan.lost }
}
