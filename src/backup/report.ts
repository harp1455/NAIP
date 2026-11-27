/** 변환 보고서 — NAIS3 가져오기·내보내기에서 무엇이 옮겨졌고 무엇이 바뀌거나 빠졌는지 (조용히 버리지 않는다) */
import { SECTION_LABELS, type DataSectionId, type EntryProblem } from './types'

export interface ReportLine {
  /** NAIP 섹션 또는 NAIS3 표 이름 */
  scope: string
  text: string
  count?: number
  /** 해당 항목 이름 (보여 주기용, 너무 많으면 앞부분만) */
  items?: string[]
}

export interface ConversionReport {
  /** 옮긴 섹션과 개수 */
  imported: { section: DataSectionId; label: string; count: number }[]
  /** 모양을 바꿔 옮긴 것 */
  transformed: ReportLine[]
  /** 옮기지 못한 것과 이유 */
  notImported: ReportLine[]
  /** 파일 손상 등 */
  problems: EntryProblem[]
}

export function emptyReport(): ConversionReport {
  return { imported: [], transformed: [], notImported: [], problems: [] }
}

const MAX_ITEMS = 20

export class ReportBuilder {
  readonly report = emptyReport()
  private readonly lines = new Map<string, ReportLine>()

  imported(section: DataSectionId, count: number): void {
    if (count > 0) this.report.imported.push({ section, label: SECTION_LABELS[section], count })
  }

  private add(list: ReportLine[], kind: string, scope: string, text: string, item?: string): void {
    const key = `${kind}\u0000${scope}\u0000${text}`
    let line = this.lines.get(key)
    if (!line) {
      line = { scope, text, count: 0, items: [] }
      this.lines.set(key, line)
      list.push(line)
    }
    line.count = (line.count ?? 0) + 1
    if (item !== undefined && line.items!.length < MAX_ITEMS) line.items!.push(item)
  }

  /** 같은 scope·text 는 한 줄로 모아 개수를 센다 */
  transformed(scope: string, text: string, item?: string): void {
    this.add(this.report.transformed, 't', scope, text, item)
  }

  notImported(scope: string, text: string, item?: string): void {
    this.add(this.report.notImported, 'n', scope, text, item)
  }

  problem(p: EntryProblem): void {
    this.report.problems.push(p)
  }
}

/** 화면·로그에 보여 줄 한국어 줄들 */
export function reportText(r: ConversionReport): string[] {
  const out: string[] = []
  if (r.imported.length) out.push(`가져온 것: ${r.imported.map((x) => `${x.label} ${x.count}개`).join(', ')}`)
  const fmt = (l: ReportLine): string => {
    const n = l.count && l.count > 1 ? ` (${l.count}개)` : ''
    const items = l.items?.length ? ` — ${l.items.join(', ')}${(l.count ?? 0) > l.items.length ? ' …' : ''}` : ''
    return `[${l.scope}] ${l.text}${n}${items}`
  }
  if (r.transformed.length) out.push('바꿔서 옮긴 것:', ...r.transformed.map((l) => `  ${fmt(l)}`))
  if (r.notImported.length) out.push('옮기지 못한 것:', ...r.notImported.map((l) => `  ${fmt(l)}`))
  if (r.problems.length) out.push('파일 문제:', ...r.problems.map((p) => `  ${p.path}: ${p.detail}`))
  return out
}
