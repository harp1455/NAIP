/**
 * 파일 이름·폴더 템플릿.
 *
 * - 변수: {project} {character} {scene} {emotion} {outfit} {action} {location} {index} {seed} {date} {time}
 *   {custom} {code} {width} {height} {slot} {version} + 축 이름({표정})·축 key({hair}). 대소문자 무시
 * - 형식: {index:03} → 001 (숫자는 자릿수만큼 0 채움), {date:YYYY-MM-DD}, {time:HHmm},
 *   {character:upper} / {character:lower}, {character:4} → 앞 4글자. {{ }} 는 글자 그대로
 * - 빈 변수는 옆의 구분자와 함께 사라진다: "{character}_{location}_{index}" + 장소 없음 → "민지_01"
 * - 이름 정리는 lib/native.ts cleanFileName과 같은 규칙(금지 문자 → _, 앞뒤 점·공백 제거, 80자)에
 *   안드로이드·PC 복사용 규칙(제어·방향 문자 제거, NFC 정규화, CON·NUL 같은 예약 이름, UTF-8 바이트 한도)을 더했다
 */
import type { DuplicatePolicy, IndexScope, NamingSettings } from './types'

export type TemplateValue = string | number | Date | null | undefined
export type TemplateVars = Record<string, TemplateValue>

/** 템플릿에 쓸 수 있는 기본 변수 (화면의 도움말용) */
export const TEMPLATE_VARIABLES: { name: string; label: string }[] = [
  { name: 'project', label: '프로젝트' },
  { name: 'character', label: '캐릭터' },
  { name: 'outfit', label: '의상' },
  { name: 'emotion', label: '표정' },
  { name: 'scene', label: '상황' },
  { name: 'action', label: '동작' },
  { name: 'location', label: '장소' },
  { name: 'index', label: '번호 ({index:03} → 001)' },
  { name: 'code', label: '이미지 코드' },
  { name: 'seed', label: '시드' },
  { name: 'date', label: '날짜 ({date:YYYY-MM-DD})' },
  { name: 'time', label: '시각 ({time:HHmmss})' },
  { name: 'width', label: '가로' },
  { name: 'height', label: '세로' },
  { name: 'slot', label: '채택 칸' },
  { name: 'version', label: '버전' },
  { name: 'custom', label: '사용자 지정 글자' }
]

const TOKEN = /\{\{|\}\}|\{([^{}:]+)(?::([^{}]*))?\}/g

function pad(n: number, width: number): string {
  const s = String(Math.abs(Math.trunc(n))).padStart(width, '0')
  return n < 0 ? `-${s}` : s
}

/** YYYY YY MM DD HH mm ss 를 바꾼 날짜 문자열 (기기 현지 시각) */
export function formatDate(d: Date, pattern: string): string {
  const map: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    YY: pad(d.getFullYear() % 100, 2),
    MM: pad(d.getMonth() + 1, 2),
    DD: pad(d.getDate(), 2),
    HH: pad(d.getHours(), 2),
    mm: pad(d.getMinutes(), 2),
    ss: pad(d.getSeconds(), 2)
  }
  return pattern.replace(/YYYY|YY|MM|DD|HH|mm|ss/g, (t) => map[t])
}

function formatValue(name: string, value: TemplateValue, spec: string | undefined): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return ''
    return formatDate(value, spec || (name === 'time' ? 'HHmmss' : 'YYYYMMDD'))
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return ''
    const m = spec ? /^0?(\d+)$/.exec(spec) : null
    return m ? pad(value, Math.min(Number(m[1]), 20)) : String(value)
  }
  const s = String(value)
  if (!spec) return s
  if (spec === 'upper') return s.toUpperCase()
  if (spec === 'lower') return s.toLowerCase()
  if (/^\d+$/.test(spec)) return [...s].slice(0, Number(spec)).join('')
  return s
}

export interface RenderOptions {
  /** 문자열 값을 넣기 전에 바꾼다 (예: 공백 → 구분자) */
  transform?: (value: string) => string
  /** 빈 변수 자리를 지우면서 옆의 구분자도 지운다 (이름용). 기본 false */
  collapse?: boolean
  /** collapse에서 구분자로 볼 글자들 */
  separators?: string
}

export interface RenderResult {
  text: string
  /** 정의되지 않은 변수 이름 */
  unknown: string[]
  /** 쓰인 변수 이름 (소문자) */
  used: string[]
}

const EMPTY = '\u0000'

function lookup(vars: TemplateVars): Map<string, TemplateValue> {
  const m = new Map<string, TemplateValue>()
  for (const [k, v] of Object.entries(vars)) {
    const key = k.trim().toLowerCase()
    // 먼저 넣은 것이 이긴다 (기본 변수 → 축 key → 축 이름 순으로 넣는다)
    if (!m.has(key)) m.set(key, v)
  }
  return m
}

function escapeClass(chars: string): string {
  return [...new Set(chars)].map((c) => c.replace(/[\\\]^-]/g, '\\$&')).join('')
}

/** 템플릿을 채운다 */
export function renderTemplate(template: string, vars: TemplateVars, opts: RenderOptions = {}): RenderResult {
  const table = lookup(vars)
  const unknown: string[] = []
  const used: string[] = []
  let text = template.replace(TOKEN, (whole, rawName: string | undefined, spec: string | undefined) => {
    if (whole === '{{') return '{'
    if (whole === '}}') return '}'
    const name = rawName!.trim().toLowerCase()
    used.push(name)
    if (!table.has(name)) {
      unknown.push(rawName!.trim())
      return opts.collapse ? EMPTY : ''
    }
    const raw = table.get(name)
    let out = formatValue(name, raw, spec?.trim())
    if (typeof raw === 'string' && opts.transform) out = opts.transform(out)
    return out === '' && opts.collapse ? EMPTY : out
  })
  if (opts.collapse) {
    const cls = escapeClass(opts.separators || '_- .')
    // 빈 자리와 그 앞의 구분자를 함께 지우고, 남은 앞뒤 구분자를 정리한다
    text = text
      .replace(new RegExp(`[${cls}]*${EMPTY}`, 'g'), '')
      .replace(new RegExp(`^[${cls}]+|[${cls}]+$`, 'g'), '')
  }
  return { text, unknown: [...new Set(unknown)], used: [...new Set(used)] }
}

// ── 이름 정리 ────────────────────────────────────────────────────────────────

/** Windows에서 파일 이름으로 못 쓰는 예약 이름 (PC로 옮길 때를 위해) */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

export interface SanitizeOptions {
  /** 최대 글자 수 (코드 포인트, 기본 80 — cleanFileName과 같음) */
  maxLength?: number
  /** 최대 UTF-8 바이트 (기본 200 — 안드로이드 파일 이름 한도 255에서 확장자·접미사 몫을 남김) */
  maxBytes?: number
}

function utf8Length(s: string): number {
  let n = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

/** 글자 수·바이트 한도에 맞게 자른다 (서로게이트 쌍을 쪼개지 않음) */
export function truncateName(s: string, maxLength: number, maxBytes: number): string {
  let out = ''
  let bytes = 0
  let count = 0
  for (const ch of s) {
    const b = utf8Length(ch)
    if (count + 1 > maxLength || bytes + b > maxBytes) break
    out += ch
    bytes += b
    count++
  }
  return out
}

const TRIM_EDGES = /^[.\s]+|[.\s]+$/g

/** 파일·폴더 이름 한 단계를 안드로이드(와 PC)에서 안전하게 */
export function sanitizeName(name: string, opts: SanitizeOptions = {}): string {
  const maxLength = Math.max(1, opts.maxLength ?? 80)
  const maxBytes = Math.max(4, opts.maxBytes ?? 200)
  let s = name
    .normalize('NFC')
    // 보이지 않는 폭 없는 문자·방향 제어 문자·BOM
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    // cleanFileName과 같은 금지 문자 (+ DEL)
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(TRIM_EDGES, '')
  s = truncateName(s, maxLength, maxBytes).replace(TRIM_EDGES, '')
  if (RESERVED.test(s)) s = `${s}_`
  return s
}

// ── 경로 미리보기 ────────────────────────────────────────────────────────────

export interface NamingItem {
  id: number | string
  vars: TemplateVars
  /** 확장자 (점 없이, 예: png) */
  ext: string
  /** 번호 범위 열쇠 — 캐릭터 / 조합 */
  characterKey?: string
  comboKey?: string
  /** 지난번에 내보낸 경로 — 같은 경로로 다시 내보내는 것은 충돌이 아니라 갱신 */
  previousPath?: string
}

export type PathStatus = 'ok' | 'renamed' | 'update' | 'overwrite' | 'skip' | 'error'

export interface PathEntry {
  id: number | string
  /** 루트부터의 폴더 (예: 프로젝트/민지). 없으면 '' */
  folder: string
  /** 확장자 없는 이름 */
  name: string
  fileName: string
  /** 상대 경로 (폴더/이름.확장자) */
  path: string
  /** 매긴 번호 (지난 경로를 그대로 쓴 항목은 null) */
  index: number | null
  /**
   * 번호 범위 열쇠 (파일 템플릿이 {index}를 쓰고 새로 번호를 받은 항목만). 실제로 저장한 항목의 번호만
   * exportCounters에 남기도록 — 취소·실패한 항목의 번호를 건너뛰지 않게 (save.ts)
   */
  scope?: string
  /** 지난번 경로를 그대로 썼는가 (keepPrevious) */
  kept: boolean
  status: PathStatus
  /** 겹친 상대 — 같은 묶음 항목의 id, 이미 있는 파일이면 'existing' */
  conflictWith?: number | string
}

export interface NamingPreview {
  entries: PathEntry[]
  /** 오류(중복 처리 = error)가 없으면 true */
  ok: boolean
  /** 겹쳐서 처리한 항목 수 (갱신은 빼고) */
  collisions: number
  /** 다음 번호를 이어 매기기 위한 범위별 마지막 번호 (다음 미리보기에 counters로 넘긴다) */
  counters: Record<string, number>
  warnings: string[]
}

export interface PreviewOptions {
  /** 이미 있는 파일의 상대 경로들 */
  existing?: Iterable<string>
  /** 지난번까지 쓴 번호 (범위 열쇠 → 마지막 번호) */
  counters?: Record<string, number>
  /**
   * previousPath가 있는 항목은 이름을 새로 짓지 않고 그 경로를 그대로 쓴다 (확장자만 지금 것으로).
   * 이미 내보낸 파일의 이름이 다시 내보낼 때 바뀌지 않고, 번호는 새 항목만 이어서 받는다
   */
  keepPrevious?: boolean
}

/** 경로 비교용 (안드로이드 저장소는 대소문자를 구분하지 않는다) */
export function pathKey(path: string): string {
  return path.normalize('NFC').toLowerCase()
}

function scopeKey(scope: IndexScope, item: NamingItem, folder: string): string {
  switch (scope) {
    case 'global':
      return 'global'
    case 'folder':
      return `folder:${pathKey(folder)}`
    case 'character':
      return `character:${item.characterKey ?? ''}`
    case 'combination':
      return `combination:${item.comboKey ?? String(item.id)}`
  }
}

function usesIndex(template: string): boolean {
  return /\{\s*index\s*(:[^{}]*)?\}/i.test(template)
}

function splitPath(path: string): { folder: string; name: string } {
  const slash = path.lastIndexOf('/')
  const file = slash >= 0 ? path.slice(slash + 1) : path
  const dot = file.lastIndexOf('.')
  return { folder: slash >= 0 ? path.slice(0, slash) : '', name: dot > 0 ? file.slice(0, dot) : file }
}

/**
 * 항목들의 최종 상대 경로를 정하고 충돌을 찾는다. 같은 입력이면 늘 같은 결과 (순서대로 번호를 매긴다).
 * 경로 비교는 NFC·대소문자 무시. 지난 경로를 그대로 쓰는 항목(keepPrevious)이 자리를 먼저 차지한다.
 */
export function previewPaths(
  items: readonly NamingItem[],
  settings: NamingSettings,
  opts: PreviewOptions = {}
): NamingPreview {
  const sep = settings.separator
  // 구분자는 이름 정리(sanitizeName)가 끝난 뒤의 중복 접미사·빈 이름 대체에도 쓰이니 금지 문자를 미리 걷는다 ('/'면 폴더가 생긴다)
  const safeSep = sep.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
  const separators = `${sep}_- .`
  const transform = settings.replaceSpaces ? (v: string): string => v.trim().replace(/\s+/g, sep || ' ') : undefined
  const sanitize = { maxLength: settings.maxLength }
  const warnings = new Set<string>()
  const counters: Record<string, number> = { ...(opts.counters ?? {}) }
  const start = Math.max(0, Math.floor(settings.startIndex))
  const indexed = usesIndex(settings.fileTemplate)

  const renderSegments = (template: string, vars: TemplateVars): string[] => {
    if (!template.trim()) return []
    if (usesIndex(template)) warnings.add('폴더 템플릿의 {index}는 쓸 수 없어 비워 둡니다')
    return template
      .split('/')
      .map((seg) => {
        const r = renderTemplate(seg, { ...vars, index: undefined }, { transform, collapse: true, separators })
        for (const u of r.unknown) warnings.add(`알 수 없는 변수 {${u}}`)
        return sanitizeName(r.text, sanitize)
      })
      .filter(Boolean)
  }

  const raw = items.map((item) => {
    const ext = item.ext.replace(/^\./, '').toLowerCase() || 'png'
    if (opts.keepPrevious && item.previousPath) {
      const prev = splitPath(item.previousPath)
      return { item, folder: prev.folder, name: prev.name, ext, index: null, kept: true, scope: undefined }
    }
    const folders = [
      ...renderSegments(settings.rootFolder, item.vars),
      ...(settings.folderMode === 'nested' ? renderSegments(settings.folderTemplate, item.vars) : [])
    ]
    const folder = folders.join('/')
    const key = scopeKey(settings.indexScope, item, folder)
    const index = counters[key] !== undefined ? Math.max(start, counters[key] + 1) : start
    if (indexed) counters[key] = index
    const r = renderTemplate(settings.fileTemplate, { ...item.vars, index }, { transform, collapse: true, separators })
    for (const u of r.unknown) warnings.add(`알 수 없는 변수 {${u}}`)
    let name = sanitizeName(r.text, sanitize)
    if (!name) {
      warnings.add('이름이 비어 "image_번호"로 정했습니다')
      name = `image${safeSep || '_'}${pad(index, 3)}`
    }
    return { item, folder, name, ext, index, kept: false, scope: indexed ? key : undefined }
  })

  const taken = new Map<string, number | string>()
  for (const p of opts.existing ?? []) taken.set(pathKey(p), 'existing')
  const join = (folder: string, file: string): string => (folder ? `${folder}/${file}` : file)
  const entries: PathEntry[] = new Array(raw.length)
  let collisions = 0
  let ok = true
  // 지난 경로를 지키는 항목부터 자리를 잡는다
  const order = [...raw.keys()].sort((a, b) => Number(raw[b].kept) - Number(raw[a].kept) || a - b)
  for (const i of order) {
    const { item, folder, name, ext, index, kept, scope } = raw[i]
    let finalName = name
    let path = join(folder, `${name}.${ext}`)
    let status: PathStatus = 'ok'
    let conflictWith: number | string | undefined
    const owner = taken.get(pathKey(path))
    const own = item.previousPath !== undefined && pathKey(item.previousPath) === pathKey(path)
    if (own && (owner === undefined || owner === 'existing')) {
      status = 'update'
    } else if (owner !== undefined) {
      conflictWith = owner
      status = resolveStatus(settings.duplicate)
      // 덮어쓰기는 기기에 이미 있는 파일에만 — 같은 묶음의 두 그림이 같은 이름이면 서로 덮어써 한 장이 사라지고
      // (갤러리) ZIP은 같은 항목을 두 번 쓸 수 없어 통째로 실패하니, 번호를 붙여 둘 다 남긴다
      if (status === 'overwrite' && owner !== 'existing') status = 'renamed'
      if (status === 'renamed') {
        const joiner = safeSep || '_'
        for (let n = 2; ; n++) {
          const suffix = `${joiner}${n}`
          const stem = truncateName(name, Math.max(1, settings.maxLength - [...suffix].length), 200 - suffix.length)
          finalName = `${stem}${suffix}`
          path = join(folder, `${finalName}.${ext}`)
          if (!taken.has(pathKey(path))) break
        }
      }
      if (status === 'error') ok = false
      collisions++
    }
    if (status !== 'skip' && status !== 'error') taken.set(pathKey(path), item.id)
    entries[i] = {
      id: item.id,
      folder,
      name: finalName,
      fileName: `${finalName}.${ext}`,
      path,
      index,
      kept,
      status,
      ...(scope !== undefined ? { scope } : {}),
      ...(conflictWith !== undefined ? { conflictWith } : {})
    }
  }
  return { entries, ok, collisions, counters: indexed ? counters : { ...(opts.counters ?? {}) }, warnings: [...warnings] }
}

function resolveStatus(policy: DuplicatePolicy): PathStatus {
  switch (policy) {
    case 'suffix':
      return 'renamed'
    case 'overwrite':
      return 'overwrite'
    case 'skip':
      return 'skip'
    case 'error':
      return 'error'
  }
}

export const PATH_STATUS_LABEL: Record<PathStatus, string> = {
  ok: '',
  renamed: '이름이 겹쳐 번호를 붙임',
  update: '지난번 파일을 새로 씀',
  overwrite: '같은 이름을 덮어씀',
  skip: '같은 이름이 있어 건너뜀',
  error: '같은 이름이 있어 내보낼 수 없음'
}
