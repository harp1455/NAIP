/**
 * 복원 계획 — 순수 함수. 지금 데이터(BackupData)와 백업 데이터를 받아 섹션별 최종 상태를 계산한다.
 * 스토어에 넣는 일은 하지 않는다: 호출하는 쪽이 plan.sections[id].result 를 각 스토어에 setState 한다.
 *
 * - overwrite(덮어쓰기): 섹션을 백업 내용으로 바꾼다
 * - merge(합치기): 지금 것은 그대로 두고 백업 항목을 더한다. 같은 id 에 내용이 다르면 새 id,
 *   같은 범위(폴더)에 같은 이름이 있으면 "이름 (2)" 로 바꾼다. id·내용이 같은 항목은 한 번만 둔다.
 *   새 id 로 바뀐 항목을 가리키던 백업 안의 참조(폴더·출연·씬 캐스트·활성 프리셋)도 함께 고친다.
 * - selective(골라서): 섹션마다 overwrite / merge / skip
 *
 * 섹션의 모양은 RESTORE_SCHEMA 로만 안다 — Phase 2 처럼 필드가 늘면 표에 컬렉션·참조를 더하면 된다.
 *
 * ── Phase 4 UI 에서 더한 것:
 * - Phase 2 출연 슬롯(slots[].charId, slots[].candidates[].id — kind 'char' 는 캐릭터, 'folder' 는 폴더, null = 미분류)
 * - 에셋 프로젝트(projects): id 가 문자열이라 addMissing — 합치면 지금 없는 id 의 프로젝트만 더하고 같은 id 는 지금 것을 유지.
 *   프로젝트 캐릭터의 libraryId·vibeIds·refIds 는 바뀐 id 를 따라가고, 프로젝트 그림(AssetImage.id = 히스토리 id)은
 *   바꾸지 않는다 — 히스토리 id 는 만든 시각(ms)이라 같은 id 를 같은 그림으로 본다 (restoreHistory 의 합치기도 같은 규칙).
 * - 합치기에서 컬렉션이 아닌 값(출연 슬롯·고른 프로젝트 등)은 지금 것이 비어 있을 때(빈 배열·null)만 백업 것을 쓴다.
 */
import { countSection } from './format'
import { DATA_SECTION_IDS, SECTION_LABELS, type BackupData, type DataSectionId, type SectionId } from './types'

export type SectionAction = 'overwrite' | 'merge' | 'skip'
export type RestoreMode = 'overwrite' | 'merge' | 'selective'

export interface CollectionSchema {
  /** 섹션 데이터 안의 배열 키 (항목마다 숫자 id) */
  key: string
  /** 이름 충돌을 볼 필드 */
  nameField?: string
  /** 이름이 겹치는지 따지는 범위 (예: 같은 폴더 안에서만) */
  scopeField?: string
}

export interface SectionSchema {
  collections?: CollectionSchema[]
  /** 키가 데이터인 맵을 합칠 때: usage = 태그 사용 기록(더 많이·더 최근), max = 숫자 큰 쪽 */
  maps?: { key: string; resolve: 'usage' | 'max' }[]
  /** 문자열 목록 — 합칠 때 합집합 */
  lists?: string[]
  /** false = 합치기를 지원하지 않는 섹션 (합치기를 고르면 지금 것을 유지) */
  mergeable?: boolean
  /**
   * id(문자열도 됨)로만 합치는 배열 — 지금 없는 id 의 항목만 더하고 같은 id 는 지금 것을 유지한다
   * (새 id·이름 바꾸기 없음). 에셋 프로젝트처럼 id 가 다른 데이터에 박혀 있어 바꿀 수 없는 것용 — Phase 4 UI
   */
  addMissing?: { key: string; nameField?: string }[]
}

export interface RefSchema {
  section: DataSectionId
  /**
   * 참조가 든 위치. `characters[].folderId`(배열 항목의 필드), `scenes[].cast[]`(id 배열),
   * `scenes[].castCenters{}`(id 가 키인 맵), `activePresetId`(최상위 필드)
   */
  path: string
  target: { section: DataSectionId; key: string }
  /** 가리키는 것이 없어지면: null 로 두기(기본, 예: 미분류 폴더) 또는 그 배열 항목을 빼기 */
  onMissing?: 'null' | 'drop'
  /** 참조가 든 객체가 이 조건에 맞을 때만 (예: 슬롯 후보의 kind 가 'char') — Phase 4 UI */
  when?: { field: string; equals?: string | number | boolean | null; notEquals?: string | number | boolean | null }
}

/** 섹션 처리 순서 — 참조는 항상 앞서 처리한 섹션·컬렉션을 가리켜야 한다 */
const ORDER: DataSectionId[] = [
  'settings',
  'saveFolders',
  'tagUsage',
  'presets',
  'prompt',
  'characters',
  'fragments',
  'scenes',
  'vibes',
  'charRefs',
  'masks',
  'collections',
  'exportTemplates',
  'projects'
]

export const RESTORE_SCHEMA: { sections: Record<DataSectionId, SectionSchema>; refs: RefSchema[] } = {
  sections: {
    settings: {},
    prompt: {},
    presets: { collections: [{ key: 'presets', nameField: 'name' }] },
    characters: {
      collections: [
        { key: 'folders', nameField: 'name' },
        { key: 'characters', nameField: 'name', scopeField: 'folderId' }
      ]
    },
    scenes: {
      collections: [
        { key: 'folders', nameField: 'name' },
        { key: 'scenes', nameField: 'name', scopeField: 'folderId' }
      ]
    },
    fragments: {
      collections: [
        { key: 'folders', nameField: 'name' },
        { key: 'fragments', nameField: 'name', scopeField: 'folderId' }
      ]
    },
    vibes: { collections: [{ key: 'vibes', nameField: 'name' }] },
    charRefs: { collections: [{ key: 'charRefs', nameField: 'name' }] },
    tagUsage: { maps: [{ key: 'entries', resolve: 'usage' }] },
    masks: { collections: [{ key: 'masks', nameField: 'name' }] },
    saveFolders: { lists: ['saveFolders'], maps: [{ key: 'nameCounters', resolve: 'max' }] },
    collections: { mergeable: false },
    exportTemplates: { mergeable: false },
    // ── Phase 4 UI
    projects: { addMissing: [{ key: 'projects', nameField: 'name' }, { key: 'presets', nameField: 'name' }] }
  },
  refs: [
    { section: 'characters', path: 'characters[].folderId', target: { section: 'characters', key: 'folders' } },
    { section: 'characters', path: 'cast[].charId', target: { section: 'characters', key: 'characters' }, onMissing: 'drop' },
    { section: 'fragments', path: 'fragments[].folderId', target: { section: 'fragments', key: 'folders' } },
    { section: 'scenes', path: 'scenes[].folderId', target: { section: 'scenes', key: 'folders' } },
    { section: 'scenes', path: 'scenes[].cast[]', target: { section: 'characters', key: 'characters' } },
    { section: 'scenes', path: 'scenes[].castCenters{}', target: { section: 'characters', key: 'characters' } },
    { section: 'prompt', path: 'activePresetId', target: { section: 'presets', key: 'presets' } },
    // ── Phase 4 UI: Phase 2 출연 슬롯. 고정 슬롯의 캐릭터가 사라지면 슬롯째 빼고(스토어 pruneSlots 와 같게),
    // 다른 모드의 charId 는 비운다. 후보는 kind 에 따라 캐릭터·폴더를 가리키며 사라지면 후보에서 뺀다
    { section: 'characters', path: 'slots[].charId', when: { field: 'mode', equals: 'fixed' }, target: { section: 'characters', key: 'characters' }, onMissing: 'drop' },
    { section: 'characters', path: 'slots[].charId', when: { field: 'mode', notEquals: 'fixed' }, target: { section: 'characters', key: 'characters' } },
    { section: 'characters', path: 'slots[].candidates[].id', when: { field: 'kind', equals: 'char' }, target: { section: 'characters', key: 'characters' }, onMissing: 'drop' },
    { section: 'characters', path: 'slots[].candidates[].id', when: { field: 'kind', equals: 'folder' }, target: { section: 'characters', key: 'folders' }, onMissing: 'drop' },
    // 에셋 프로젝트 → 캐릭터 라이브러리·바이브·레퍼런스 (libraryId 가 없어지면 null = 프로젝트 전용 캐릭터)
    { section: 'projects', path: 'projects[].characters[].libraryId', target: { section: 'characters', key: 'characters' } },
    { section: 'projects', path: 'projects[].characters[].vibeIds[]', target: { section: 'vibes', key: 'vibes' } },
    { section: 'projects', path: 'projects[].characters[].refIds[]', target: { section: 'charRefs', key: 'charRefs' } }
  ]
}

export interface PlanChange {
  /** kept = 합치기에서 같은 id 라 지금 것을 유지한 항목 (addMissing) */
  kind: 'added' | 'identical' | 'new-id' | 'renamed' | 'replaced' | 'removed' | 'dangling' | 'kept'
  collection: string
  id: number | string | null
  name?: string
  newId?: number
  newName?: string
}

export interface SectionStats {
  incoming: number
  current: number
  added: number
  identical: number
  /** 덮어쓰기에서 같은 id 의 내용이 바뀐 항목 */
  replaced: number
  /** 덮어쓰기에서 사라지는 지금 항목 */
  removed: number
  renamed: number
  /** 합치기에서 새 id 를 받은 항목 (그중 id 충돌로 받은 것 = idConflicts) */
  reassigned: number
  idConflicts: number
  /** 가리키는 대상이 없어 끊은 참조 */
  dangling: number
  /** 합치기에서 같은 id 라 지금 것을 유지한 항목 (addMissing) */
  kept: number
}

export interface SectionPlan {
  section: DataSectionId
  action: 'overwrite' | 'merge'
  /** 적용할 섹션 상태 — 스토어에 setState 로 넣는다 (merge 결과에는 지금 항목도 들어 있다) */
  result: Record<string, unknown>
  stats: SectionStats
  changes: PlanChange[]
  notes: string[]
}

export interface RestorePlan {
  sections: Partial<Record<DataSectionId, SectionPlan>>
  /** 히스토리: replace = 비우고 백업으로, merge = 없는 것만 더함 */
  history: { action: 'replace' | 'merge'; originals: boolean } | null
  warnings: string[]
}

export interface PlanOptions {
  mode: RestoreMode
  /** 섹션별 동작 (selective 에서는 여기 없는 섹션은 건너뜀, 그 밖의 모드에서는 덮어씀) */
  sections?: Partial<Record<SectionId, SectionAction>>
  /** 새 id 발급 — 앱에서는 lib/util 의 uid 를 넘긴다. 없으면 가장 큰 id 다음 번호 */
  newId?: () => number
  /** 백업에 히스토리 기록·원본이 있는지 (manifest.sections) */
  hasHistory?: boolean
  hasOriginals?: boolean
}

// ── 참조 경로 ───────────────────────────────────────────────────────────

interface Token {
  key: string
  kind: 'field' | 'array' | 'record'
}

function parsePath(path: string): Token[] {
  return path.split('.').map((part) => {
    if (part.endsWith('[]')) return { key: part.slice(0, -2), kind: 'array' }
    if (part.endsWith('{}')) return { key: part.slice(0, -2), kind: 'record' }
    return { key: part, kind: 'field' }
  })
}

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

const DROP = Symbol('drop')

type When = RefSchema['when']

function matchesWhen(obj: Obj, when: When): boolean {
  if (!when) return true
  const v = obj[when.field]
  if ('equals' in when && v !== when.equals) return false
  if ('notEquals' in when && v === when.notEquals) return false
  return true
}

/** 경로의 id 들을 fn 으로 바꾼 새 값 (원본은 건드리지 않는다). fn 이 null 이면 끊는다 */
function mapRefs(value: unknown, tokens: Token[], fn: (id: number) => number | null, drop: boolean, when?: When): unknown {
  if (!isObj(value) || !tokens.length) return value
  const [t, ...rest] = tokens
  if (!(t.key in value)) return value
  const cur = value[t.key]
  if (!rest.length) {
    if (!matchesWhen(value, when)) return value
    if (t.kind === 'array') {
      if (!Array.isArray(cur)) return value
      const next = cur.flatMap((x) => {
        if (typeof x !== 'number') return [x]
        const r = fn(x)
        return r === null ? [] : [r]
      })
      return { ...value, [t.key]: next }
    }
    if (t.kind === 'record') {
      if (!isObj(cur)) return value
      const next: Obj = {}
      for (const [k, v] of Object.entries(cur)) {
        const n = Number(k)
        if (!Number.isFinite(n) || k.trim() === '') {
          next[k] = v
          continue
        }
        const r = fn(n)
        if (r !== null) next[String(r)] = v
      }
      return { ...value, [t.key]: next }
    }
    if (typeof cur !== 'number') return value
    const r = fn(cur)
    if (r === null && drop) return DROP
    return { ...value, [t.key]: r }
  }
  if (t.kind === 'array') {
    if (!Array.isArray(cur)) return value
    return { ...value, [t.key]: cur.map((x) => mapRefs(x, rest, fn, drop, when)).filter((x) => x !== DROP) }
  }
  const inner = mapRefs(cur, rest, fn, drop, when)
  return inner === DROP ? value : { ...value, [t.key]: inner }
}

function collectRefs(value: unknown, tokens: Token[], when?: When): number[] {
  const out: number[] = []
  mapRefs(value, tokens, (id) => (out.push(id), id), false, when)
  return out
}

// ── 도움 함수 ───────────────────────────────────────────────────────────

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bb = b as unknown[]
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]))
  }
  const ka = Object.keys(a as Obj).filter((k) => (a as Obj)[k] !== undefined)
  const kb = Object.keys(b as Obj).filter((k) => (b as Obj)[k] !== undefined)
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Obj)[k], (b as Obj)[k]))
}

function itemsOf(v: unknown): Obj[] {
  return Array.isArray(v) ? v.filter(isObj) : []
}

function idOf(item: Obj): number | null {
  return typeof item.id === 'number' && Number.isFinite(item.id) ? item.id : null
}

/** 숫자 또는 문자열 id (addMissing 용) */
function keyOf(item: Obj): number | string | null {
  if (typeof item.id === 'string' && item.id) return item.id
  return idOf(item)
}

function emptyStats(): SectionStats {
  return { incoming: 0, current: 0, added: 0, identical: 0, replaced: 0, removed: 0, renamed: 0, reassigned: 0, idConflicts: 0, dangling: 0, kept: 0 }
}

function resolveAction(id: SectionId, opts: PlanOptions): SectionAction {
  const explicit = opts.sections?.[id]
  if (explicit) return explicit
  if (opts.mode === 'selective') return 'skip'
  return opts.mode
}

// ── 계획 ───────────────────────────────────────────────────────────────

export function planRestore(current: BackupData, incoming: BackupData, opts: PlanOptions): RestorePlan {
  const plan: RestorePlan = { sections: {}, history: null, warnings: [] }
  const cur = current as Record<DataSectionId, unknown>
  const inc = incoming as Record<DataSectionId, unknown>

  // 새 id: 지금·백업의 모든 id 보다 큰 수부터 (newId 를 주면 그것으로)
  let maxId = 0
  for (const id of DATA_SECTION_IDS) {
    for (const c of RESTORE_SCHEMA.sections[id].collections ?? []) {
      for (const src of [cur[id], inc[id]]) {
        for (const item of itemsOf(isObj(src) ? src[c.key] : undefined)) {
          const n = idOf(item)
          if (n !== null && n > maxId) maxId = n
        }
      }
    }
  }
  const nextId = opts.newId ?? (() => ++maxId)
  const allocate = (taken: Set<number>): number => {
    for (let i = 0; i < 1_000_000; i++) {
      const n = nextId()
      if (!taken.has(n)) return n
    }
    throw new Error('새 id 를 만들 수 없습니다')
  }

  const idMaps = new Map<string, Map<number, number>>()
  const finalIds = new Map<string, Set<number>>()
  const planned = new Set<DataSectionId>()
  const idsOfTarget = (t: { section: DataSectionId; key: string }): Set<number> => {
    const k = `${t.section}.${t.key}`
    const known = finalIds.get(k)
    if (known) return known
    // 복원하지 않는 섹션 — 지금 데이터 그대로
    const src = cur[t.section]
    return new Set(itemsOf(isObj(src) ? src[t.key] : undefined).flatMap((x) => (idOf(x) === null ? [] : [idOf(x)!])))
  }

  for (const id of ORDER) {
    if (inc[id] == null) continue
    const action = resolveAction(id, opts)
    if (action === 'skip') continue
    const schema = RESTORE_SCHEMA.sections[id]
    const curObj: Obj = isObj(cur[id]) ? (cur[id] as Obj) : {}
    let incObj: Obj = isObj(inc[id]) ? (inc[id] as Obj) : {}
    const stats = emptyStats()
    const changes: PlanChange[] = []
    const notes: string[] = []
    stats.incoming = countSection(id, incObj)
    stats.current = countSection(id, curObj)
    const collectionKeys = new Set((schema.collections ?? []).map((c) => c.key))
    const refs = RESTORE_SCHEMA.refs.filter((r) => r.section === id)

    const applyRefs = (filter: (firstKey: string) => boolean): void => {
      for (const r of refs) {
        const tokens = parsePath(r.path)
        if (!filter(tokens[0].key)) continue
        const map = idMaps.get(`${r.target.section}.${r.target.key}`)
        const ids = idsOfTarget(r.target)
        incObj = mapRefs(
          incObj,
          tokens,
          (ref) => {
            const mapped = map?.get(ref) ?? ref
            if (ids.has(mapped)) return mapped
            stats.dangling++
            changes.push({ kind: 'dangling', collection: r.path, id: ref })
            return null
          },
          r.onMissing === 'drop',
          r.when
        ) as Obj
      }
    }

    let result: Obj
    if (action === 'overwrite' || (action === 'merge' && schema.mergeable === false && !Object.keys(curObj).length)) {
      // 덮어쓰면 이 섹션의 대상은 백업 항목들이다 — 자기 섹션 안 참조(폴더 등)를 고치기 전에 먼저 정한다
      for (const c of schema.collections ?? []) {
        finalIds.set(`${id}.${c.key}`, new Set(itemsOf(incObj[c.key]).flatMap((x) => (idOf(x) === null ? [] : [idOf(x)!]))))
      }
      applyRefs(() => true)
      result = incObj
      for (const c of [...(schema.collections ?? []), ...(schema.addMissing ?? [])]) {
        const before = new Map(itemsOf(curObj[c.key]).map((x) => [keyOf(x), x]))
        const after = itemsOf(incObj[c.key])
        const afterIds = new Set(after.map(keyOf))
        for (const item of after) {
          const prev = before.get(keyOf(item))
          const name = typeof item[c.nameField ?? 'name'] === 'string' ? (item[c.nameField ?? 'name'] as string) : undefined
          if (!prev) {
            stats.added++
            changes.push({ kind: 'added', collection: c.key, id: keyOf(item), name })
          } else if (deepEqual(prev, item)) {
            stats.identical++
          } else {
            stats.replaced++
            changes.push({ kind: 'replaced', collection: c.key, id: keyOf(item), name })
          }
        }
        for (const [bid, prev] of before) {
          if (afterIds.has(bid)) continue
          stats.removed++
          const name = typeof prev[c.nameField ?? 'name'] === 'string' ? (prev[c.nameField ?? 'name'] as string) : undefined
          changes.push({ kind: 'removed', collection: c.key, id: bid, name })
        }
      }
      plan.sections[id] = { section: id, action: 'overwrite', result, stats, changes, notes }
      planned.add(id)
      continue
    }

    // ── 합치기 ──
    if (schema.mergeable === false) {
      notes.push(`${SECTION_LABELS[id]}은(는) 합칠 수 없어 지금 것을 그대로 둡니다 (바꾸려면 덮어쓰기를 고르세요)`)
      plan.sections[id] = { section: id, action: 'merge', result: { ...curObj }, stats, changes, notes }
      planned.add(id)
      continue
    }
    result = {}
    for (const c of schema.collections ?? []) {
      applyRefs((k) => k === c.key)
      const existing = itemsOf(curObj[c.key])
      const items = itemsOf(incObj[c.key])
      const byId = new Map(existing.map((x) => [idOf(x), x]))
      const taken = new Set<number>([...existing, ...items].flatMap((x) => (idOf(x) === null ? [] : [idOf(x)!])))
      const used = new Set<number>(existing.flatMap((x) => (idOf(x) === null ? [] : [idOf(x)!])))
      const nameField = c.nameField
      const nameKey = (item: Obj, name: string): string => `${c.scopeField ? String(item[c.scopeField] ?? '') : ''}\u0000${name.trim()}`
      const names = new Set(
        nameField ? existing.flatMap((x) => (typeof x[nameField] === 'string' ? [nameKey(x, x[nameField] as string)] : [])) : []
      )
      const map = new Map<number, number>()
      const out: Obj[] = [...existing]
      for (const item of items) {
        const oldId = idOf(item)
        const same = oldId === null ? undefined : byId.get(oldId)
        const name = nameField && typeof item[nameField] === 'string' ? (item[nameField] as string) : undefined
        if (same && deepEqual(same, item)) {
          stats.identical++
          map.set(oldId!, oldId!)
          changes.push({ kind: 'identical', collection: c.key, id: oldId, name })
          continue
        }
        const next: Obj = { ...item }
        if (oldId === null || same || used.has(oldId)) {
          const nid = allocate(taken)
          taken.add(nid)
          next.id = nid
          if (oldId !== null) map.set(oldId, nid)
          stats.reassigned++
          if (same) stats.idConflicts++
          changes.push({ kind: 'new-id', collection: c.key, id: oldId, name, newId: nid })
        } else {
          map.set(oldId, oldId)
        }
        if (nameField && name !== undefined) {
          let candidate = name
          for (let n = 2; names.has(nameKey(next, candidate)); n++) candidate = `${name.trim()} (${n})`
          if (candidate !== name) {
            next[nameField] = candidate
            stats.renamed++
            changes.push({ kind: 'renamed', collection: c.key, id: next.id as number, name, newName: candidate })
          }
          names.add(nameKey(next, candidate))
        }
        used.add(next.id as number)
        out.push(next)
        stats.added++
      }
      result[c.key] = out
      idMaps.set(`${id}.${c.key}`, map)
      finalIds.set(`${id}.${c.key}`, new Set(out.flatMap((x) => (idOf(x) === null ? [] : [idOf(x)!]))))
    }
    applyRefs((k) => !collectionKeys.has(k))

    // ── Phase 4 UI: id 로만 합치는 배열 — 지금 없는 id 만 더하고, 같은 id 는 지금 것을 유지
    for (const c of schema.addMissing ?? []) {
      const existing = itemsOf(curObj[c.key])
      const byKey = new Map(existing.map((x) => [keyOf(x), x]))
      const out: Obj[] = [...existing]
      let noId = 0
      for (const item of itemsOf(incObj[c.key])) {
        const k = keyOf(item)
        const name = c.nameField && typeof item[c.nameField] === 'string' ? (item[c.nameField] as string) : undefined
        if (k === null) {
          noId++
          continue
        }
        const same = byKey.get(k)
        if (same) {
          if (deepEqual(same, item)) {
            stats.identical++
            changes.push({ kind: 'identical', collection: c.key, id: k, name })
          } else {
            stats.kept++
            stats.idConflicts++
            changes.push({ kind: 'kept', collection: c.key, id: k, name })
          }
          continue
        }
        byKey.set(k, item)
        out.push(item)
        stats.added++
        changes.push({ kind: 'added', collection: c.key, id: k, name })
      }
      result[c.key] = out
      if (noId) notes.push(`${SECTION_LABELS[id]}: id 가 없는 항목 ${noId}개는 건너뜁니다`)
    }
    if (stats.kept) {
      notes.push(`${SECTION_LABELS[id]}: 같은 id 가 이미 있는 항목 ${stats.kept}개는 지금 것을 유지합니다 (덮어쓰기를 고르면 백업 것으로 바뀝니다)`)
    }

    for (const m of schema.maps ?? []) {
      const a = isObj(curObj[m.key]) ? (curObj[m.key] as Obj) : {}
      const b = isObj(incObj[m.key]) ? (incObj[m.key] as Obj) : {}
      const merged: Obj = { ...a }
      for (const [k, v] of Object.entries(b)) {
        if (!(k in a)) {
          merged[k] = v
          stats.added++
          continue
        }
        if (m.resolve === 'max') {
          if (typeof v === 'number' && typeof a[k] === 'number' && v > (a[k] as number)) merged[k] = v
        } else if (isObj(v) && isObj(a[k])) {
          // 같은 태그: 더 많이 쓴 기록과 더 최근 시각
          const x = a[k] as Obj
          const n = Math.max(Number(x.n) || 0, Number(v.n) || 0)
          const last = Math.max(Number(x.last) || 0, Number(v.last) || 0)
          merged[k] = { ...((Number(v.last) || 0) > (Number(x.last) || 0) ? v : x), n, last }
        }
        if (deepEqual(merged[k], a[k])) stats.identical++
      }
      result[m.key] = merged
    }
    for (const key of schema.lists ?? []) {
      const a = Array.isArray(curObj[key]) ? (curObj[key] as unknown[]) : []
      const b = Array.isArray(incObj[key]) ? (incObj[key] as unknown[]) : []
      const merged = [...a]
      for (const x of b) {
        if (merged.some((y) => deepEqual(x, y))) stats.identical++
        else {
          merged.push(x)
          stats.added++
        }
      }
      result[key] = merged
    }
    // 나머지 필드(출연·작업 중인 프롬프트·설정값 …): 지금 값을 유지하고, 지금 없는 것만 백업에서.
    // 지금 값이 빈 배열이나 null 이면(예: 출연 슬롯이 비었거나 고른 프로젝트가 없으면) 백업 것을 쓴다 — Phase 4 UI
    const handled = new Set([
      ...collectionKeys,
      ...(schema.addMissing ?? []).map((c) => c.key),
      ...(schema.maps ?? []).map((m) => m.key),
      ...(schema.lists ?? [])
    ])
    let keptCurrent = 0
    for (const key of new Set([...Object.keys(curObj), ...Object.keys(incObj)])) {
      if (handled.has(key)) continue
      const isEmpty = (v: unknown): boolean => v === null || v === undefined || (Array.isArray(v) && !v.length)
      const fillEmpty = isEmpty(curObj[key]) && !isEmpty(incObj[key])
      if (key in curObj && !fillEmpty) {
        result[key] = curObj[key]
        if (key in incObj && !deepEqual(curObj[key], incObj[key])) keptCurrent++
      } else {
        result[key] = incObj[key]
      }
    }
    if (keptCurrent) notes.push(`${SECTION_LABELS[id]}: 합치기라 지금 값을 유지한 항목 ${keptCurrent}개 (덮어쓰기를 고르면 백업 값으로 바뀝니다)`)
    plan.sections[id] = { section: id, action: 'merge', result, stats, changes, notes }
    planned.add(id)
  }

  // 복원하지 않고 남겨 둔 지금 데이터가, 덮어쓴 섹션에서 사라지는 항목을 가리키는지
  for (const r of RESTORE_SCHEMA.refs) {
    if (planned.has(r.section) || !planned.has(r.target.section)) continue
    const ids = idsOfTarget(r.target)
    const missing = collectRefs(cur[r.section], parsePath(r.path), r.when).filter((x) => !ids.has(x)).length
    if (missing) {
      plan.warnings.push(
        `지금 ${SECTION_LABELS[r.section]} 중 ${missing}곳이 복원 뒤에는 없는 ${SECTION_LABELS[r.target.section]} 항목을 가리킵니다 (그 연결은 무시됩니다)`
      )
    }
  }

  if (opts.hasHistory) {
    const h = resolveAction('history', opts)
    if (h !== 'skip') {
      const o = opts.hasOriginals ? (opts.sections?.historyOriginals ?? h) : 'skip'
      plan.history = { action: h === 'overwrite' ? 'replace' : 'merge', originals: o !== 'skip' }
    }
  }
  return plan
}

// ── 미리보기 ────────────────────────────────────────────────────────────

export interface SectionPreview {
  section: DataSectionId
  label: string
  incoming: number
  current: number
  /** 지금 것과 똑같은 항목 */
  identical: number
  /** 같은 id 인데 내용이 다른 항목 (합치면 새 id, 덮어쓰면 백업 내용으로) */
  idConflicts: number
  /** 합치면 이름이 바뀌는 항목 */
  nameConflicts: number
  /** 지금 없는 새 항목 */
  newItems: number
  /** 덮어쓰면 사라지는 지금 항목 */
  removedOnOverwrite: number
  /** 충돌 예시 (최대 50개) */
  conflicts: PlanChange[]
  mergeable: boolean
  /** 합칠 때 같은 id·다른 내용을 어떻게 하는지: new-id = 새 id 로 더함, keep-current = 지금 것 유지, none = 합치기 없음 */
  mergePolicy: 'new-id' | 'keep-current' | 'none'
}

/** 백업 안에 무엇이 들었고 지금 데이터와 무엇이 부딪히는지 */
export function previewRestore(current: BackupData, incoming: BackupData): SectionPreview[] {
  const merged = planRestore(current, incoming, { mode: 'merge' })
  const over = planRestore(current, incoming, { mode: 'overwrite' })
  const out: SectionPreview[] = []
  for (const id of DATA_SECTION_IDS) {
    if ((incoming as Record<string, unknown>)[id] == null) continue
    const m = merged.sections[id]
    const o = over.sections[id]
    const schema = RESTORE_SCHEMA.sections[id]
    out.push({
      section: id,
      label: SECTION_LABELS[id],
      incoming: countSection(id, (incoming as Record<string, unknown>)[id]),
      current: countSection(id, (current as Record<string, unknown>)[id]),
      identical: m?.stats.identical ?? 0,
      idConflicts: m?.stats.idConflicts ?? 0,
      nameConflicts: m?.stats.renamed ?? 0,
      newItems: o?.stats.added ?? 0,
      removedOnOverwrite: o?.stats.removed ?? 0,
      conflicts: (m?.changes ?? []).filter((c) => c.kind === 'new-id' || c.kind === 'renamed' || c.kind === 'kept').slice(0, 50),
      mergeable: schema.mergeable !== false,
      mergePolicy: schema.mergeable === false ? 'none' : schema.addMissing ? 'keep-current' : 'new-id'
    })
  }
  return out
}
