/**
 * 내보낸 파일 목록(매니페스트)과 채팅 프롬프트용 이미지 코드 목록.
 *
 * - CSV: RFC 4180 (쉼표·큰따옴표·줄바꿈이 든 칸은 큰따옴표로 감싸고 안의 큰따옴표는 두 번, 줄 끝은 CRLF),
 *   엑셀용 UTF-8 BOM과 수식 방지(' 접두)는 고를 수 있다
 * - JSON(열 key를 이름으로 한 객체 배열), TXT(한 줄에 한 장), Markdown(표)
 * - 이미지 코드: 캐릭터마다 A, B, C … 접두에 번호 (패턴 {char}{n:03} → A001). 이미 받은 코드는 유지
 */
import { renderTemplate, type TemplateVars } from './template'
import type { ManifestColumn, ManifestFormat } from './types'

export const MANIFEST_COLUMN_LABEL: Record<ManifestColumn, string> = {
  fileName: '파일 이름',
  path: '경로',
  character: '캐릭터',
  scene: '장면',
  expression: '표정',
  outfit: '의상',
  code: '이미지 코드',
  resolution: '해상도',
  fileSize: '파일 크기',
  seed: '시드',
  prompt: '프롬프트',
  description: '설명'
}

export const MANIFEST_COLUMNS = Object.keys(MANIFEST_COLUMN_LABEL) as ManifestColumn[]

export interface ColumnSpec {
  key: string
  label: string
}

/** 기본 열 이름 + 사용자 열(축 이름 등) */
export function columnSpecs(keys: readonly string[], extraLabels: Record<string, string> = {}): ColumnSpec[] {
  return keys.map((key) => ({
    key,
    label: extraLabels[key] ?? MANIFEST_COLUMN_LABEL[key as ManifestColumn] ?? key
  }))
}

export type ManifestValue = string | number | null | undefined
export type ManifestRow = Record<string, ManifestValue>

function text(v: ManifestValue): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  return v
}

// ── CSV ──────────────────────────────────────────────────────────────────────

export interface CsvOptions {
  /** 맨 앞에 UTF-8 BOM (엑셀이 한글을 제대로 읽게) */
  bom?: boolean
  /** =,+,-,@ (와 탭·CR)로 시작하는 칸 앞에 ' 를 붙여 엑셀이 수식으로 읽지 않게 */
  guardFormulas?: boolean
  /** 머리글 줄 (기본 true) */
  header?: boolean
}

/** RFC 4180 칸 하나 */
export function csvField(value: ManifestValue, guardFormulas = false): string {
  let s = text(value)
  if (guardFormulas && typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows: readonly ManifestRow[], columns: readonly ColumnSpec[], opts: CsvOptions = {}): string {
  const lines: string[] = []
  if (opts.header !== false) lines.push(columns.map((c) => csvField(c.label)).join(','))
  for (const row of rows) lines.push(columns.map((c) => csvField(row[c.key], opts.guardFormulas)).join(','))
  return `${opts.bom ? '\ufeff' : ''}${lines.join('\r\n')}\r\n`
}

// ── JSON · TXT · Markdown ───────────────────────────────────────────────────

export function toJson(rows: readonly ManifestRow[], columns: readonly ColumnSpec[]): string {
  return JSON.stringify(
    rows.map((row) => Object.fromEntries(columns.map((c) => [c.key, row[c.key] ?? null]))),
    null,
    2
  )
}

/** 한 줄에 한 장 — 칸 사이는 separator, 칸 안의 줄바꿈은 공백으로 */
export function toTxt(
  rows: readonly ManifestRow[],
  columns: readonly ColumnSpec[],
  opts: { separator?: string; header?: boolean } = {}
): string {
  const sep = opts.separator ?? ' | '
  const flat = (v: ManifestValue): string => text(v).replace(/\s*[\r\n]+\s*/g, ' ')
  const lines: string[] = []
  if (opts.header !== false) lines.push(columns.map((c) => c.label).join(sep))
  for (const row of rows) lines.push(columns.map((c) => flat(row[c.key])).join(sep))
  return `${lines.join('\n')}\n`
}

function mdCell(v: ManifestValue): string {
  return text(v)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>')
}

export function toMarkdown(rows: readonly ManifestRow[], columns: readonly ColumnSpec[]): string {
  const lines = [
    `| ${columns.map((c) => mdCell(c.label)).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${columns.map((c) => mdCell(row[c.key])).join(' | ')} |`)
  ]
  return `${lines.join('\n')}\n`
}

export interface ManifestFile {
  text: string
  mime: string
  ext: string
}

export function buildManifest(
  rows: readonly ManifestRow[],
  columns: readonly ColumnSpec[],
  format: ManifestFormat,
  opts: CsvOptions = {}
): ManifestFile {
  switch (format) {
    case 'csv':
      return { text: toCsv(rows, columns, opts), mime: 'text/csv;charset=utf-8', ext: 'csv' }
    case 'json':
      return { text: toJson(rows, columns), mime: 'application/json', ext: 'json' }
    case 'txt':
      return { text: toTxt(rows, columns), mime: 'text/plain;charset=utf-8', ext: 'txt' }
    case 'md':
      return { text: toMarkdown(rows, columns), mime: 'text/markdown;charset=utf-8', ext: 'md' }
  }
}

// ── 이미지 코드 ──────────────────────────────────────────────────────────────

/** 0 → A, 25 → Z, 26 → AA, 27 → AB … (스프레드시트 열 이름 방식) */
export function letterCode(index: number): string {
  let n = Math.max(0, Math.floor(index)) + 1
  let out = ''
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(65 + r) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

export interface CodeItem {
  /** 결과를 돌려줄 때의 열쇠 */
  id: string | number
  /** 번호를 따로 매길 묶음 (보통 캐릭터 id, 없으면 '') */
  group: string
  /** 묶음 코드 — {char} (예: A) */
  groupCode: string
  /** 이미 정해진 코드 (그대로 둔다) */
  existing?: string
  /** 패턴에 쓸 수 있는 그 밖의 변수 */
  vars?: TemplateVars
}

/**
 * 이미지 코드를 매긴다. 이미 코드가 있는 항목은 그대로 두고, 새 항목은 묶음마다 1부터 —
 * 이미 쓰인 코드와 겹치는 번호는 건너뛴다 (교체·추가 뒤에도 기존 코드가 바뀌지 않게).
 * 패턴 변수: {char} 묶음 코드, {n} 묶음 안 번호, + vars
 */
export function assignImageCodes(items: readonly CodeItem[], pattern: string): Map<string | number, string> {
  const out = new Map<string | number, string>()
  const used = new Set<string>()
  for (const it of items) if (it.existing) used.add(it.existing.toLowerCase())
  const next = new Map<string, number>()
  const safePattern = /\{\s*n\s*(:[^{}]*)?\}/i.test(pattern) ? pattern : `${pattern}{n}`
  for (const it of items) {
    if (it.existing) {
      out.set(it.id, it.existing)
      continue
    }
    let n = next.get(it.group) ?? 1
    let code = ''
    // 쓰인 코드는 유한하므로 끝난다. 패턴이 번호와 무관하게 같은 글자를 내면({{n}} 등) 뒤에 번호를 붙인다
    for (let tries = 0; ; tries++, n++) {
      code = renderTemplate(safePattern, { ...(it.vars ?? {}), char: it.groupCode, n }).text
      if (tries > used.size) code = `${code}${n}`
      if (!used.has(code.toLowerCase())) break
    }
    next.set(it.group, n + 1)
    used.add(code.toLowerCase())
    out.set(it.id, code)
  }
  return out
}

/**
 * 채팅 프롬프트용 목록 — 한 줄에 한 장을 템플릿으로 (예: "{code} | {character} | {emotion} | {file}").
 * 변수가 없으면 빈칸으로 두고, 글자는 파일 이름처럼 정리하지 않는다
 */
export function buildCodeList(rows: readonly TemplateVars[], template: string): string {
  return rows.map((vars) => renderTemplate(template, vars).text.replace(/[\r\n]+/g, ' ')).join('\n')
}
