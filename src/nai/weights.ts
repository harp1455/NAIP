/**
 * NAI 가중치 문법 파서 — 프롬프트 에디터의 배경 하이라이트용 (NAIS3 prompt-weights.ts 이식).
 * - {...}  : 중첩당 ×1.05
 * - [...]  : 중첩당 ÷1.05
 * - N::...:: : 수치 가중치 (음수 가능). 내부의 괄호는 곱으로 누적
 */
export interface WeightSegment {
  start: number
  end: number
  weight: number
}

const STEP = 1.05
const NUMERIC_OPEN = /^(-?\d+(?:\.\d+)?)::/

export function parseWeights(text: string): WeightSegment[] {
  const segments: WeightSegment[] = []
  let braces = 0
  let brackets = 0
  const numeric: number[] = []
  const effective = (): number => {
    const base = numeric.length > 0 ? numeric[numeric.length - 1] : 1
    return base * Math.pow(STEP, braces) * Math.pow(STEP, -brackets)
  }
  let segStart = 0
  let segWeight = effective()
  const boundary = (pos: number): void => {
    const w = effective()
    if (w === segWeight) return
    if (pos > segStart) segments.push({ start: segStart, end: pos, weight: segWeight })
    segStart = pos
    segWeight = w
  }
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '{') {
      braces++
      boundary(i)
      i++
    } else if (ch === '}') {
      if (braces > 0) braces--
      boundary(i + 1)
      i++
    } else if (ch === '[') {
      brackets++
      boundary(i)
      i++
    } else if (ch === ']') {
      if (brackets > 0) brackets--
      boundary(i + 1)
      i++
    } else if (text.startsWith('::', i) && numeric.length > 0) {
      numeric.pop()
      boundary(i + 2)
      i += 2
    } else {
      const m = NUMERIC_OPEN.exec(text.slice(i, i + 16))
      if (m) {
        numeric.push(Number(m[1]))
        boundary(i)
        i += m[0].length
      } else {
        i++
      }
    }
  }
  if (text.length > segStart) segments.push({ start: segStart, end: text.length, weight: segWeight })
  return segments
}

export type MarkKind = 'up' | 'down' | 'negative' | 'fragment' | 'comment'

export interface HighlightRange {
  start: number
  end: number
  kind: MarkKind | null
  /** 0~1 — 가중치가 1에서 멀수록 진하게 */
  alpha: number
}

function weightMark(weight: number): { kind: MarkKind | null; alpha: number } {
  if (weight === 1) return { kind: null, alpha: 0 }
  // 음수 가중치는 약화(파랑)와 구분되는 별도 색
  if (weight < 0) return { kind: 'negative', alpha: Math.min(0.3 + Math.abs(weight) * 0.06, 0.55) }
  if (weight === 0) return { kind: 'down', alpha: 0.5 }
  const steps = Math.abs(Math.log(weight) / Math.log(STEP))
  return { kind: weight > 1 ? 'up' : 'down', alpha: Math.min(0.12 + steps * 0.045, 0.5) }
}

/** 가중치 + 조각(<...>) + 주석(# 줄)을 합친 하이라이트 구간. 주석 > 조각 > 가중치 순으로 우선 */
export function highlightRanges(text: string): HighlightRange[] {
  const fragments = [...text.matchAll(/<[^<>\n]+>/g)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length
  }))
  const comments: { start: number; end: number }[] = []
  let offset = 0
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('#')) comments.push({ start: offset, end: offset + line.length })
    offset += line.length + 1
  }
  const within = (list: { start: number; end: number }[], pos: number): boolean =>
    list.some((x) => x.start <= pos && pos < x.end)

  const weights = parseWeights(text)
  const bounds = new Set<number>([0, text.length])
  for (const s of [...weights, ...fragments, ...comments]) {
    bounds.add(s.start)
    bounds.add(s.end)
  }
  const sorted = [...bounds].sort((a, b) => a - b)
  const ranges: HighlightRange[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i]
    const end = sorted[i + 1]
    const mark = within(comments, start)
      ? { kind: 'comment' as const, alpha: 0.3 }
      : within(fragments, start)
        ? { kind: 'fragment' as const, alpha: 0.3 }
        : weightMark(weights.find((s) => s.start <= start && start < s.end)?.weight ?? 1)
    const prev = ranges[ranges.length - 1]
    if (prev && prev.kind === mark.kind && prev.alpha === mark.alpha) prev.end = end
    else ranges.push({ start, end, ...mark })
  }
  return ranges
}
