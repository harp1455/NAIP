/**
 * 내보내기 실행 — export.ts의 계획대로 원본을 읽어 변환(convert.ts)하고 저장한 뒤, 목록 파일을 쓰고
 * 프로젝트에 내보낸 경로·이미지 코드·번호를 기록한다. 원본(히스토리)은 읽기만 하고 바꾸지 않는다.
 *
 * 저장할 곳
 * - gallery (휴대폰): MediaStore Pictures/NAIP/폴더…/이름 — 여러 단계 폴더, 이 앱이 만든 같은 파일은 덮어쓰기.
 *   한 장 저장할 때마다 바로 기록한다 (도중에 취소·종료돼도 다음 내보내기가 그 파일을 "지난번 파일"로 안다).
 *   목록 파일은 Download/NAIP/폴더… (안드로이드는 사진 폴더에 글 파일을 넣지 못하게 한다) — 이번에 저장한 것에
 *   같은 폴더 아래 전에 내보낸 채택 그림을 더해, "아직 안 내보낸 것만"이나 취소 뒤에도 목록이 줄지 않는다
 * - zip: 폴더 구조를 그대로 담은 ZIP 하나 (휴대폰은 저장할 곳을 고르고, 브라우저는 내려받기)
 */
import * as db from '../lib/db'
import { listSavedImages, OverwriteDeniedError, saveImageAt, saveTextAt } from '../lib/native'
import { stripMetadata } from '../lib/strip'
import { createFile } from '../backup/files'
import { BufferedSink } from '../backup/io'
import { writeZip, type ZipEntryInput } from '../backup/zip/writer'
import { FORMAT_EXT, convertInWorker, formatBytes, type ConvertResult } from './convert'
import {
  assetVars,
  characterCodes,
  exportCandidates,
  manifestRows,
  planExport,
  projectCodeList,
  projectCodes,
  projectColumns,
  slotRef,
  type ExportPlan,
  type ExportPlanEntry
} from './export'
import { buildManifest } from './manifest'
import { presetToConvertOptions } from './presets'
import { useProjects } from './store'
import { pathKey, sanitizeName } from './template'
import type { PlatformPreset, Project } from './types'

export type ExportTarget = 'gallery' | 'zip'

export interface ExportSettings {
  target: ExportTarget
  onlyNotExported: boolean
  renameExported: boolean
}

export interface ExportSummary {
  saved: number
  skipped: number
  failed: number
  /** 저장한 곳 (갤러리 폴더 또는 ZIP 이름) */
  where: string
  manifestPath: string | null
  warnings: string[]
  errors: string[]
  cancelled: boolean
}

/** 지금 프로젝트의 변환 프리셋 (지워졌으면 null) */
export function exportPreset(project: Project, presets: readonly PlatformPreset[]): PlatformPreset | null {
  return project.convertPresetId ? (presets.find((p) => p.id === project.convertPresetId) ?? null) : null
}

/** 계획에 넘길 확장자 — 프리셋 형식, 메타데이터 제거면 PNG, 아니면 원본 그대로(그림마다) */
export function exportExt(project: Project, preset: PlatformPreset | null): string | undefined {
  if (preset) return FORMAT_EXT[preset.format]
  return project.exportStripMeta ? 'png' : undefined
}

/** 이 기기에 이미 있는 파일 (갤러리 저장일 때만 — 이 앱이 만든 것만 보인다) */
export async function existingPaths(target: ExportTarget): Promise<string[]> {
  if (target !== 'gallery') return []
  return listSavedImages().catch(() => [])
}

export function buildExportPlan(project: Project, presets: readonly PlatformPreset[], s: ExportSettings, existing: readonly string[]): ExportPlan {
  const ext = exportExt(project, exportPreset(project, presets))
  return planExport(project, {
    ...(ext ? { ext } : {}),
    existing,
    onlyNotExported: s.onlyNotExported,
    renameExported: s.renameExported
  })
}

/** 폴더들의 공통 앞부분 (목록 파일을 둘 곳) */
export function commonFolder(folders: readonly string[]): string {
  if (!folders.length) return ''
  let common = folders[0].split('/')
  for (const f of folders.slice(1)) {
    const segs = f.split('/')
    let i = 0
    while (i < common.length && i < segs.length && common[i].toLowerCase() === segs[i].toLowerCase()) i++
    common = common.slice(0, i)
  }
  return common.filter(Boolean).join('/')
}

function joinPath(folder: string, file: string): string {
  return folder ? `${folder}/${file}` : file
}

/** 보낸 프롬프트 (메인 | 캐릭터: 프롬프트 …) — 목록의 prompt 열 */
function sentPrompt(m: db.HistoryMeta): string {
  const sent = m.sent
  if (!sent) return m.prompt
  return [sent.prompt, ...sent.chars.map((c) => (c.name ? `${c.name}: ${c.prompt}` : c.prompt))].filter(Boolean).join(' | ')
}

function withExt(fileName: string, ext: string): string {
  const dot = fileName.lastIndexOf('.')
  return `${dot > 0 ? fileName.slice(0, dot) : fileName}.${ext}`
}

/**
 * 실제로 저장한 항목의 번호만 — 번호 범위마다 가장 큰 번호. 계획 전체의 번호(preview.counters)를 남기면
 * 취소·실패·건너뛴 항목의 번호가 비어 다음 내보내기가 그 뒤부터 매긴다 (_01, _02, _04)
 */
export function savedCounters(entries: readonly ExportPlanEntry[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const e of entries) {
    const { scope, index } = e.path
    if (scope === undefined || index === null) continue
    out[scope] = Math.max(out[scope] ?? index, index)
  }
  return out
}

/**
 * 계획 때의 조합 키 → 지금 키. 내보내는 동안 편집(빈 축에 첫 값·첫 캐릭터)으로 그림이 새 키로 옮겨졌을 수 있다
 * (내보내기는 화면을 떠나도 계속된다). 계획 때의 키로 기록하면 그 키에 항목이 없어 내보낸 기록이 사라지고
 * 코드는 빈 항목이 새로 생겨 거기 붙으며, 번호도 옛 범위에 남아 다음 내보내기가 같은 그림을 새 이름으로 또 저장한다.
 * 그림 id로 지금 있는 곳을 찾는다 (계획 때의 키에 그 그림이 그대로 있으면 그대로)
 */
export function currentKeys(latest: Project, entries: readonly ExportPlanEntry[]): (key: string) => string {
  let where: Map<number, string> | null = null
  const moved = new Map<string, string>()
  for (const e of entries) {
    const from = e.candidate.key
    const id = e.candidate.image.id
    if (moved.has(from) || latest.items[from]?.images.some((i) => i.id === id)) continue
    if (!where) {
      where = new Map()
      for (const it of Object.values(latest.items)) for (const img of it.images) if (!where.has(img.id)) where.set(img.id, it.key)
    }
    const to = where.get(id)
    if (to) moved.set(from, to)
  }
  return (key) => moved.get(key) ?? key
}

/** 번호 범위의 조합 키도 지금 키로 */
function countersAt(counters: Record<string, number>, keyOf: (key: string) => string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [scope, n] of Object.entries(counters)) {
    const at = scope.startsWith('combination:') ? `combination:${keyOf(scope.slice('combination:'.length))}` : scope
    out[at] = Math.max(out[at] ?? n, n)
  }
  return out
}

/**
 * 순서 글자(A, B …)로 코드를 처음 받은 캐릭터에 그 글자를 적어 둔다 — 나중에 캐릭터를 빼거나 순서를 바꿔도
 * 같은 캐릭터의 새 코드가 다른 글자로 시작하지 않게 (사용자가 코드를 적어 둔 캐릭터는 그대로)
 */
export function keepCharacterLetters(project: Project, plan: ExportPlan): void {
  if (!plan.newCodes.length || !/\{\s*char\s*(:[^{}]*)?\}/i.test(project.codes.pattern)) return
  const fresh = new Set(plan.newCodes.map((c) => slotRef(c.key, c.slot)))
  const letters = characterCodes(project)
  const s = useProjects.getState()
  const latest = s.projects.find((p) => p.id === project.id)
  if (!latest) return
  const done = new Set<string>()
  for (const e of plan.entries) {
    const ch = e.candidate.character
    if (!ch || done.has(ch.id) || ch.code?.trim() || !fresh.has(slotRef(e.candidate.key, e.candidate.slot))) continue
    done.add(ch.id)
    const now = latest.characters.find((c) => c.id === ch.id)
    const letter = letters.get(ch.id)
    if (now && !now.code?.trim() && letter) s.patchCharacter(project.id, ch.id, { code: letter })
  }
}

interface Prepared {
  entry: ExportPlanEntry
  blob: Blob
  fileName: string
  out?: ConvertResult
}

export async function runExport(
  project: Project,
  presets: readonly PlatformPreset[],
  s: ExportSettings,
  o: { signal: AbortSignal; onProgress: (done: number, total: number, label: string) => void }
): Promise<ExportSummary> {
  const preset = exportPreset(project, presets)
  const strip = !preset && !!project.exportStripMeta
  const existing = await existingPaths(s.target)
  const plan = buildExportPlan(project, presets, s, existing)
  const summary: ExportSummary = {
    saved: 0,
    skipped: plan.entries.filter((e) => e.path.status === 'skip').length,
    failed: 0,
    where: '',
    manifestPath: null,
    warnings: [...plan.preview.warnings],
    errors: [],
    cancelled: false
  }
  if (!plan.preview.ok) {
    summary.errors.push('같은 이름이 있어 내보낼 수 없는 파일이 있습니다 (중복 처리: 오류). 이름 규칙이나 중복 처리를 바꿔 주세요')
    return summary
  }
  const todo = plan.entries.filter((e) => e.path.status !== 'skip' && e.path.status !== 'error')
  if (!todo.length) {
    summary.errors.push('내보낼 채택 그림이 없습니다')
    return summary
  }
  const total = todo.length
  const warn = new Set<string>()
  const done: { key: string; imageId: number; path: string; bytes?: number }[] = []
  const doneEntries: ExportPlanEntry[] = []
  const outputs = new Map<number, { width?: number; height?: number; bytes?: number }>()
  const prompts = new Map<number, string>()

  /** 원본 읽기 → 변환 (실패하면 null, 이유는 errors에) */
  const prepare = async (entry: ExportPlanEntry): Promise<Prepared | null> => {
    const img = entry.candidate.image
    const meta = (await db.getMetas([img.id]))[0]
    if (meta) prompts.set(img.id, sentPrompt(meta))
    const original = await db.getBlob(img.id, img.mime ?? meta?.mime ?? 'image/png')
    if (!original) {
      summary.failed++
      summary.errors.push(`${entry.path.path}: 원본을 찾을 수 없습니다 (히스토리에서 지워짐)`)
      return null
    }
    let fileName = entry.path.fileName
    if (preset) {
      const out = await convertInWorker(original, presetToConvertOptions(preset))
      for (const w of out.warnings) warn.add(out.reachedTarget === false ? `${entry.path.fileName}: ${w}` : w)
      if (out.format !== preset.format) fileName = withExt(fileName, FORMAT_EXT[out.format])
      return { entry, blob: out.blob, fileName, out }
    }
    const blob = strip ? await stripMetadata(original) : original
    return { entry, blob, fileName }
  }

  const record = (p: Prepared, path: string): void => {
    const img = p.entry.candidate.image
    done.push({ key: p.entry.candidate.key, imageId: img.id, path, bytes: p.blob.size })
    doneEntries.push({ ...p.entry, path: { ...p.entry.path, path, fileName: path.slice(path.lastIndexOf('/') + 1) } })
    outputs.set(img.id, { width: p.out?.width ?? img.width, height: p.out?.height ?? img.height, bytes: p.blob.size })
    summary.saved++
  }

  const folder = commonFolder(todo.map((e) => e.path.folder))
  const sep = project.naming.separator || '_'
  const rawStem = (project.slug?.trim() || project.name).trim()
  // 목록 파일 이름에 _manifest.json·_codes.txt가 붙어도 파일 이름 한도(lib/native, 200바이트 + 확장자) 안에 들게
  const stem = sanitizeName(project.naming.replaceSpaces ? rawStem.replace(/\s+/g, sep) : rawStem, { maxBytes: 180 }) || 'project'

  /**
   * 갤러리 목록에 넣을 항목 — 이번에 저장한 것 + 목록 폴더 아래에 전에 내보내 아직 기기에 있는 채택 그림
   * (행렬 순서). 전에 내보낸 그림의 크기는 변환했을 수 있어 지금 변환 설정이 있으면 비워 둔다
   */
  const galleryEntries = async (latest: Project): Promise<ExportPlanEntry[]> => {
    const mine = new Map(doneEntries.map((e) => [e.candidate.image.id, e]))
    const onDevice = new Set(existing.map(pathKey))
    const prefix = folder ? `${pathKey(folder)}/` : ''
    const candidates = exportCandidates(latest)
    const codes = projectCodes(latest, candidates)
    const out: ExportPlanEntry[] = []
    const earlier: ExportPlanEntry[] = []
    for (const c of candidates) {
      const own = mine.get(c.image.id)
      if (own) {
        out.push(own)
        mine.delete(c.image.id)
        continue
      }
      const path = c.image.exported?.path
      if (!path || !onDevice.has(pathKey(path)) || (prefix && !pathKey(path).startsWith(prefix))) continue
      const code = codes.get(slotRef(c.key, c.slot)) ?? ''
      const slash = path.lastIndexOf('/')
      const fileName = path.slice(slash + 1)
      const dot = fileName.lastIndexOf('.')
      const entry: ExportPlanEntry = {
        candidate: c,
        code,
        vars: assetVars(latest, c, code, 'file'),
        path: {
          id: c.image.id,
          folder: slash >= 0 ? path.slice(0, slash) : '',
          name: dot > 0 ? fileName.slice(0, dot) : fileName,
          fileName,
          path,
          index: null,
          kept: true,
          status: 'ok'
        }
      }
      out.push(entry)
      earlier.push(entry)
    }
    out.push(...mine.values())
    if (earlier.length) {
      const metas = await db.getMetas(earlier.map((e) => e.candidate.image.id)).catch(() => [] as db.HistoryMeta[])
      for (const m of metas) if (!prompts.has(m.id)) prompts.set(m.id, sentPrompt(m))
      for (const e of earlier) {
        const img = e.candidate.image
        outputs.set(img.id, { ...(preset ? {} : { width: img.width, height: img.height }), bytes: img.exported?.bytes })
      }
    }
    return out
  }

  const manifestFile = async (): Promise<{ name: string; text: string; mime: string; codes: string }> => {
    const latest = useProjects.getState().projects.find((p) => p.id === project.id) ?? project
    const entries = s.target === 'gallery' ? await galleryEntries(latest) : doneEntries
    const filtered: ExportPlan = { ...plan, entries }
    const m = buildManifest(manifestRows(latest, filtered, { prompts, outputs }), projectColumns(latest), latest.manifest.format, {
      bom: latest.manifest.bom,
      guardFormulas: latest.manifest.guardFormulas
    })
    return { name: `${stem}_manifest.${m.ext}`, text: m.text, mime: m.mime, codes: projectCodeList(latest, filtered) }
  }

  /** 계획 때의 키 → 지금 키 (내보내는 동안 편집으로 옮겨졌을 때) */
  const keyNow = (): ((key: string) => string) => {
    const latest = useProjects.getState().projects.find((p) => p.id === project.id)
    return latest ? currentKeys(latest, plan.entries) : (key) => key
  }

  /** 새 이미지 코드 저장 (+ 캐릭터 글자 고정) — 코드는 칸에 붙는 고정 이름이라 저장한 파일과 어긋나지 않게 */
  const saveCodes = (): void => {
    if (!plan.newCodes.length) return
    keepCharacterLetters(project, plan)
    const keyOf = keyNow()
    useProjects.getState().setCodes(project.id, plan.newCodes.map((c) => ({ ...c, key: keyOf(c.key) })))
  }

  /** 내보낸 경로·번호 기록 (지금 키로) */
  const saveRecords = (list: typeof done): void => {
    const keyOf = keyNow()
    useProjects.getState().markExported(
      project.id,
      list.map((d) => ({ ...d, key: keyOf(d.key) })),
      countersAt(savedCounters(doneEntries), keyOf),
      { onDevice: s.target === 'gallery' }
    )
  }

  if (s.target === 'gallery') {
    summary.where = joinPath('Pictures/NAIP', folder)
    // 파일 이름에 코드가 들어갈 수 있으니 먼저 저장한다 (도중에 꺼져도 다음에 같은 코드)
    saveCodes()
    let n = 0
    for (const entry of todo) {
      if (o.signal.aborted) {
        summary.cancelled = true
        break
      }
      o.onProgress(n, total, entry.path.path)
      try {
        const p = await prepare(entry)
        if (p) {
          const overwrite = entry.path.status === 'overwrite' || entry.path.status === 'update'
          const saved = await saveImageAt(p.blob, entry.path.folder, p.fileName, overwrite)
          if (saved.renamed) warn.add(`${entry.path.path}: 같은 이름의 다른 파일이 있어 기기가 "${saved.name}"(으)로 저장했습니다`)
          record(p, saved.path)
          // 한 장마다 바로 기록 — 화면을 떠나거나 앱이 꺼져도 다음 내보내기가 이 파일을 다른 앱 것으로 보고 _2를 만들지 않게
          saveRecords(done.slice(-1))
        }
      } catch (e) {
        summary.failed++
        summary.errors.push(
          e instanceof OverwriteDeniedError
            ? `${entry.path.path}: 덮어쓸 수 없습니다 — 같은 이름의 파일이 다른 앱(또는 앱을 다시 설치하기 전)의 것입니다`
            : `${entry.path.path}: ${(e as Error).message}`
        )
      }
      o.onProgress(++n, total, entry.path.path)
    }
    if (done.length) {
      const m = await manifestFile()
      try {
        const saved = await saveTextAt(m.text, m.mime, folder, m.name, true)
        summary.manifestPath = `Download/NAIP/${saved.path}`
        if (m.codes.trim()) await saveTextAt(`${m.codes}\n`, 'text/plain;charset=utf-8', folder, `${stem}_codes.txt`, true)
      } catch (e) {
        summary.errors.push(`목록 파일 저장 실패: ${(e as Error).message}`)
      }
    }
  } else {
    const zipName = `${stem}.zip`
    const file = await createFile(zipName, 'application/zip')
    if (!file) {
      summary.cancelled = true
      summary.skipped = 0
      return summary
    }
    summary.where = file.name
    let n = 0
    async function* entries(): AsyncGenerator<ZipEntryInput> {
      for (const entry of todo) {
        if (o.signal.aborted) throw new DOMException('Aborted', 'AbortError')
        o.onProgress(n, total, entry.path.path)
        try {
          const p = await prepare(entry)
          if (p) {
            const path = joinPath(entry.path.folder, p.fileName)
            const data = new Uint8Array(await p.blob.arrayBuffer())
            record(p, path)
            yield { path, data, compress: false }
          }
        } catch (e) {
          if ((e as Error)?.name === 'AbortError') throw e
          summary.failed++
          summary.errors.push(`${entry.path.path}: ${(e as Error).message}`)
        }
        o.onProgress(++n, total, entry.path.path)
      }
      if (done.length) {
        const m = await manifestFile()
        summary.manifestPath = `${file!.name} › ${joinPath(folder, m.name)}`
        yield { path: joinPath(folder, m.name), data: new TextEncoder().encode(m.text) }
        if (m.codes.trim()) yield { path: joinPath(folder, `${stem}_codes.txt`), data: new TextEncoder().encode(`${m.codes}\n`) }
      }
    }
    try {
      await writeZip(entries(), new BufferedSink(file), { signal: o.signal })
      if (done.length) saveRecords(done)
      saveCodes()
    } catch (e) {
      // ZIP은 쓰다 만 파일을 지운다 — 아무것도 내보내지 않은 것으로
      summary.cancelled = (e as Error)?.name === 'AbortError' || o.signal.aborted
      if (!summary.cancelled) summary.errors.push(`ZIP 쓰기 실패: ${(e as Error).message}`)
      summary.saved = 0
      summary.manifestPath = null
      return summary
    }
  }
  summary.warnings.push(...warn)
  return summary
}

/** 요약 한 줄 */
export function describeSummary(s: ExportSummary): string {
  const parts = [`${s.saved}장 저장`]
  if (s.skipped) parts.push(`건너뜀 ${s.skipped}`)
  if (s.failed) parts.push(`실패 ${s.failed}`)
  if (s.warnings.length) parts.push(`경고 ${s.warnings.length}`)
  return `${s.cancelled ? '취소됨 — ' : ''}${parts.join(' · ')}`
}

export { formatBytes }
