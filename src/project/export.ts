/**
 * 프로젝트 → 내보내기 계획: 채택 그림을 행렬 순서로 모으고, 이미지 코드·템플릿 변수·최종 경로·매니페스트 줄을 만든다.
 * 실제 변환(convert.ts)과 저장(lib/native.ts saveToGallery)은 리드가 이 계획대로 돌린다.
 */
import { adoptedImages } from './curation'
import { buildCodeList, assignImageCodes, columnSpecs, letterCode, type ManifestRow } from './manifest'
import { buildJob, expandMatrix, joinPrompt, type Combination, type MatrixSelection } from './matrix'
import { previewPaths, renderTemplate, type NamingPreview, type PathEntry, type TemplateVars } from './template'
import { CHARACTER_AXIS, type AssetImage, type AxisKind, type Project, type ProjectCharacter } from './types'

export interface ExportCandidate {
  key: string
  combo: Combination
  image: AssetImage
  slot: number
  character: ProjectCharacter | null
}

export interface CandidateOptions {
  select?: MatrixSelection
  /** 아직 내보내지 않았거나(교체 포함) 지난번과 경로가 달라질 수 있는 것만 — 기본 false = 채택 전부 */
  onlyNotExported?: boolean
}

/** 내보낼 채택 그림 (행렬 순서 → 칸 순서) */
export function exportCandidates(project: Project, opts: CandidateOptions = {}): ExportCandidate[] {
  const matrix = expandMatrix(project, opts.select)
  const out: ExportCandidate[] = []
  for (const combo of matrix.combos) {
    for (const image of adoptedImages(project.items[combo.key])) {
      if (opts.onlyNotExported && image.exported) continue
      out.push({ key: combo.key, combo, image, slot: image.slot ?? 1, character: combo.character })
    }
  }
  return out
}

/**
 * 캐릭터마다 코드 접두 — 지정한 코드는 그대로, 비어 있으면 프로젝트 안 순서대로 A, B, C … 를 주되
 * 다른 캐릭터가 쓰는 글자는 건너뛴다 (지정한 B와 순서상 B인 캐릭터가 같은 접두를 나눠 쓰지 않게).
 * 내보내기에서 순서 글자로 코드를 처음 매기면 save.ts가 그 글자를 캐릭터에 적어 둔다 — 나중에 캐릭터를
 * 빼거나 순서를 바꿔도 같은 캐릭터의 새 코드가 다른 글자로 시작하지 않게
 */
export function characterCodes(project: Pick<Project, 'characters'>): Map<string, string> {
  const out = new Map<string, string>()
  const taken = new Set<string>()
  for (const c of project.characters) {
    const code = c.code?.trim()
    if (!code) continue
    out.set(c.id, code)
    taken.add(code.toLowerCase())
  }
  project.characters.forEach((c, i) => {
    if (out.has(c.id)) return
    let n = i
    while (taken.has(letterCode(n).toLowerCase())) n++
    const code = letterCode(n)
    out.set(c.id, code)
    taken.add(code.toLowerCase())
  })
  return out
}

/** 캐릭터의 코드 접두 (characterCodes 참고) */
export function characterCode(project: Pick<Project, 'characters'>, character: ProjectCharacter | null): string {
  if (!character) return ''
  if (character.code?.trim()) return character.code.trim()
  return characterCodes(project).get(character.id) ?? letterCode(Math.max(0, project.characters.findIndex((c) => c.id === character.id)))
}

export function slotRef(key: string, slot: number): string {
  return `${key}#${slot}`
}

/**
 * 후보들의 이미지 코드 — 칸에 이미 코드가 있으면 그대로, 없으면 새로 매긴다.
 * 돌려준 새 코드는 store.setCodes로 저장해 두어야 다음에도 같다
 */
export function projectCodes(project: Project, candidates: readonly ExportCandidate[]): Map<string, string> {
  const letters = characterCodes(project)
  const items = candidates.map((c) => ({
    id: slotRef(c.key, c.slot),
    group: c.character?.id ?? '',
    groupCode: c.character ? (letters.get(c.character.id) ?? characterCode(project, c.character)) : '',
    existing: project.items[c.key]?.codes?.[String(c.slot)],
    vars: { project: project.slug || project.name }
  }))
  // 이미 매긴 코드(행렬에서 빠진 조합 것 포함)와 겹치지 않게
  const known = new Set(items.map((i) => i.id))
  for (const item of Object.values(project.items)) {
    for (const [slot, code] of Object.entries(item.codes ?? {})) {
      const id = slotRef(item.key, Number(slot))
      if (!known.has(id)) items.unshift({ id, group: '', groupCode: '', existing: code, vars: { project: '' } })
    }
  }
  return assignImageCodes(items, project.codes.pattern) as Map<string, string>
}

const KIND_VAR: Partial<Record<AxisKind, string>> = {
  outfit: 'outfit',
  expression: 'emotion',
  situation: 'scene',
  action: 'action',
  location: 'location'
}

/**
 * 템플릿 변수. names: 'file'은 파일 이름용(slug 우선), 'label'은 목록·설명용(표시 이름).
 * 기본 변수 → 축 key → 축 이름 순으로 넣어 앞의 것이 이긴다
 */
export function assetVars(
  project: Project,
  cand: ExportCandidate,
  code: string,
  names: 'file' | 'label' = 'file'
): TemplateVars {
  const pick = (v: { label: string; slug?: string }): string => (names === 'file' ? v.slug?.trim() || v.label : v.label)
  const vars: TemplateVars = {
    project: names === 'file' ? project.slug?.trim() || project.name : project.name,
    character: cand.character ? pick({ label: cand.character.name, slug: cand.character.slug }) : '',
    code,
    seed: cand.image.seed,
    date: new Date(cand.image.ts),
    time: new Date(cand.image.ts),
    width: cand.image.width,
    height: cand.image.height,
    slot: cand.slot,
    version: cand.image.version ?? 1,
    custom: project.naming.custom
  }
  const kindVars: TemplateVars = {}
  const axisVars: TemplateVars = {}
  for (const { axis, value } of cand.combo.picks) {
    if (axis.id === CHARACTER_AXIS) continue
    const v = pick(value)
    const builtin = KIND_VAR[axis.kind]
    if (builtin && kindVars[builtin] === undefined) kindVars[builtin] = v
    if (axis.key?.trim()) axisVars[axis.key.trim()] = v
    if (axis.name.trim()) axisVars[axis.name.trim()] ??= v
  }
  // 그 종류의 축이 없으면 빈칸 (알 수 없는 변수 경고가 나지 않게)
  for (const name of Object.values(KIND_VAR)) kindVars[name] ??= ''
  return { ...vars, ...kindVars, ...axisVars }
}

export interface ExportPlanEntry {
  candidate: ExportCandidate
  code: string
  vars: TemplateVars
  path: PathEntry
}

export interface ExportPlan {
  entries: ExportPlanEntry[]
  preview: NamingPreview
  /** 새로 매긴 코드 (칸 → 코드) — store.setCodes로 저장. preview.counters는 store.markExported에 넘긴다 */
  newCodes: { key: string; slot: number; code: string }[]
}

export interface ExportPlanOptions extends CandidateOptions {
  /** 출력 확장자 (변환 형식). 없으면 원본 mime에서 */
  ext?: string
  /** 기기에 이미 있는 파일의 상대 경로 (알면 충돌을 미리 찾는다) */
  existing?: Iterable<string>
  /** 이어 매길 번호 (기본: project.exportCounters) */
  counters?: Record<string, number>
  /**
   * 이미 내보낸 그림도 지금 템플릿으로 이름을 새로 짓는다 (번호도 처음부터). 기본 false —
   * 내보낸 그림(교체한 새 버전 포함)은 지난 경로를 그대로 쓰고, 새 그림만 이어서 번호를 받는다
   */
  renameExported?: boolean
}

/**
 * 지난번 내보낸 경로 — 그림 자신의 기록, 없으면 이 그림이 교체한 이전 버전들의 기록, 그것도 없으면
 * 이 그림이 받은 채택 칸에 마지막으로 내보낸 경로(item.slotPaths). 교체한 새 그림이나 채택을 풀었다가
 * 다른 그림을 채택해 같은 칸(= 같은 코드)을 받은 그림이 같은 파일을 새로 쓰게 해서, 코드의 파일에
 * 탈락한 그림이 남지 않고 이름·코드가 바뀌지 않는다
 */
export function previousExportPath(project: Project, key: string, image: AssetImage): string | undefined {
  const item = project.items[key]
  const byId = new Map((item?.images ?? []).map((i) => [i.id, i]))
  const seen = new Set<number>()
  for (let cur: AssetImage | undefined = image; cur && !seen.has(cur.id); cur = cur.replaces !== undefined ? byId.get(cur.replaces) : undefined) {
    seen.add(cur.id)
    if (cur.exported) return cur.exported.path
  }
  return image.slot !== undefined ? item?.slotPaths?.[String(image.slot)] : undefined
}

function extOf(mime: string | undefined): string {
  if (mime === 'image/webp') return 'webp'
  if (mime === 'image/jpeg') return 'jpg'
  return 'png'
}

/** 내보내기 계획 — 코드·경로·충돌까지 (파일은 만들지 않는다) */
export function planExport(project: Project, opts: ExportPlanOptions = {}): ExportPlan {
  const candidates = exportCandidates(project, opts)
  const codes = projectCodes(project, candidates)
  const newCodes: ExportPlan['newCodes'] = []
  const withVars = candidates.map((c) => {
    const ref = slotRef(c.key, c.slot)
    const code = codes.get(ref) ?? ''
    if (code && !project.items[c.key]?.codes?.[String(c.slot)]) newCodes.push({ key: c.key, slot: c.slot, code })
    return { candidate: c, code, vars: assetVars(project, c, code, 'file') }
  })
  const preview = previewPaths(
    withVars.map(({ candidate, vars }) => {
      const previousPath = previousExportPath(project, candidate.key, candidate.image)
      return {
        id: candidate.image.id,
        vars,
        ext: opts.ext ?? extOf(candidate.image.mime),
        characterKey: candidate.character?.id ?? '',
        comboKey: candidate.key,
        ...(previousPath ? { previousPath } : {})
      }
    }),
    project.naming,
    {
      ...(opts.existing ? { existing: opts.existing } : {}),
      counters: opts.renameExported ? {} : (opts.counters ?? project.exportCounters),
      keepPrevious: !opts.renameExported
    }
  )
  return {
    entries: withVars.map((w, i) => ({ ...w, path: preview.entries[i] })),
    preview,
    newCodes
  }
}

export interface RowExtras {
  /** 히스토리 이미지 id → 실제로 보낸 프롬프트 (없으면 프로젝트 설정으로 만든 프롬프트) */
  prompts?: Map<number, string>
  /** 이미지 id → 변환 뒤 크기·바이트 */
  outputs?: Map<number, { width?: number; height?: number; bytes?: number }>
}

/** 보낸 프롬프트를 모를 때 — 프로젝트 설정으로 만든 메인 + 캐릭터 프롬프트 (라이브러리 캐릭터 프롬프트는 빠진다) */
function fallbackPrompt(project: Project, combo: Combination): string {
  const job = buildJob(project, combo)
  return joinPrompt(job.prompt, job.characterPrompt)
}

/** 매니페스트 줄 (표시 이름으로) */
export function manifestRows(project: Project, plan: ExportPlan, extras: RowExtras = {}): ManifestRow[] {
  return plan.entries
    .filter((e) => e.path.status !== 'skip' && e.path.status !== 'error')
    .map((e) => {
      const c = e.candidate
      const labels = assetVars(project, c, e.code, 'label')
      const out = extras.outputs?.get(c.image.id)
      // 변환 결과를 알려 줬으면 그대로 (모르는 크기는 비워 둔다), 아니면 원본 크기
      const w = out ? out.width : c.image.width
      const h = out ? out.height : c.image.height
      const description =
        c.image.description?.trim() ||
        renderTemplate(project.manifest.descriptionTemplate, labels, { collapse: true, separators: ' ' }).text
      const row: ManifestRow = {
        fileName: e.path.fileName,
        path: e.path.path,
        character: labels.character as string,
        scene: labels.scene as string,
        expression: labels.emotion as string,
        outfit: labels.outfit as string,
        code: e.code,
        resolution: w && h ? `${w}x${h}` : '',
        fileSize: out?.bytes,
        seed: c.image.seed,
        prompt: extras.prompts?.get(c.image.id) ?? fallbackPrompt(project, c.combo),
        description
      }
      // 축 이름 열도 쓸 수 있게
      for (const { axis, value } of c.combo.picks) row[`axis:${axis.id}`] = value.label
      return row
    })
}

/** 프로젝트 설정의 열 + 축 열 이름 */
export function projectColumns(project: Project, keys: readonly string[] = project.manifest.columns) {
  const extra: Record<string, string> = {}
  for (const a of project.axes) extra[`axis:${a.id}`] = a.name
  extra[`axis:${CHARACTER_AXIS}`] = '캐릭터'
  return columnSpecs(keys, extra)
}

/** 채팅 프롬프트용 코드 목록 (프로젝트의 listTemplate, {file}·{path}·{description} 포함) */
export function projectCodeList(project: Project, plan: ExportPlan, template = project.codes.listTemplate): string {
  const rows = plan.entries
    .filter((e) => e.path.status !== 'skip' && e.path.status !== 'error')
    .map((e) => {
      const labels = assetVars(project, e.candidate, e.code, 'label')
      const description =
        e.candidate.image.description?.trim() ||
        renderTemplate(project.manifest.descriptionTemplate, labels, { collapse: true, separators: ' ' }).text
      return { ...labels, file: e.path.fileName, path: e.path.path, description }
    })
  return buildCodeList(rows, template)
}
