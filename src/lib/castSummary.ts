import {
  orderedCandidates,
  variationGroupLabel,
  VARIATION_MODES,
  weightedCandidates,
  type CastCharacter,
  type CastOptions,
  type CastResolution,
  type CastSlot,
  type CountCheck,
  type VariationGroup
} from '../nai/cast'

/**
 * 캐릭터 화면의 접은 구역 머리에 보일 한 줄 요약과 경고 (순수 함수 — 화면과 따로 시험한다).
 * 경고는 펼쳤을 때 안에서 보이는 것과 같은 내용 — 접어 두어도 놓치지 않게 머리에 칩으로 띄운다.
 */

export const EMPTY_TEXT = '비어 있음'

/** 프롬프트 칸의 앞부분 (주석 줄은 빼고 한 줄로) */
export function textExcerpt(text: string, max = 80): string {
  const one = text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!one) return EMPTY_TEXT
  return one.length > max ? `${one.slice(0, max)}…` : one
}

/** "뽑기 설정" — 장마다 · 중복 안 됨 · 씬마다 · 인원 자동 */
export function castOptionsSummary(o: CastOptions): string {
  return [
    o.scope === 'batch' ? '배치에 한 번' : '장마다',
    o.allowDuplicates ? '중복 허용' : '중복 안 됨',
    o.perScene ? '씬마다 따로' : '',
    o.autoCountTags ? '인원 자동' : ''
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * 켜진 슬롯이 아무도 내보내지 못하는 설정인가 — 펼친 목록·슬롯 편집에서 빨갛게, 접으면 칩으로.
 * 확률 0%·순서가 끝난 순차처럼 고른 결과인 것은 경고하지 않는다.
 */
export function slotProblem(slot: CastSlot, characters: readonly CastCharacter[]): string | null {
  if (!slot.enabled) return null
  if (slot.mode === 'fixed') {
    return slot.charId !== null && characters.some((c) => c.id === slot.charId) ? null : '캐릭터 없음'
  }
  if (slot.mode === 'sequential') {
    if (orderedCandidates(slot, characters).length) return null
    return slot.candidates.length ? '뽑을 캐릭터 없음' : '후보 없음'
  }
  const pool = weightedCandidates(slot, characters)
  if (!pool.length) return slot.candidates.length ? '뽑을 캐릭터 없음' : '후보 없음'
  return pool.some((p) => p.weight > 0) ? null : '비중이 모두 0'
}

/** 접은 "출연 슬롯" — 켜진 슬롯마다 짧게: 민지, 무작위 3명, 순차 2명, 확률 40% */
export function castSlotsSummary(slots: readonly CastSlot[], characters: readonly CastCharacter[]): string {
  if (!slots.length) return '없음'
  const on = slots.filter((s) => s.enabled)
  if (!on.length) return '모두 꺼짐'
  return on
    .map((s) => {
      switch (s.mode) {
        case 'fixed':
          return characters.find((c) => c.id === s.charId)?.name ?? '빈 고정'
        case 'random':
          return `무작위 ${weightedCandidates(s, characters).length}명`
        case 'sequential':
          return `순차 ${orderedCandidates(s, characters).length}명`
        case 'chance':
          return `확률 ${s.chance}%`
      }
    })
    .join(', ')
}

/** 접은 "출연 슬롯"의 경고 — 모델 한도를 넘은 인원, 아무도 못 내보내는 슬롯 */
export function castSlotsWarning(
  slots: readonly CastSlot[],
  characters: readonly CastCharacter[],
  max: number
): string | null {
  const out: string[] = []
  const on = slots.filter((s) => s.enabled).length
  if (on > max) out.push(`한도 ${max}명 넘음`)
  const problems = slots.map((s) => slotProblem(s, characters)).filter((p): p is string => !!p)
  if (problems.length === 1) out.push(problems[0])
  else if (problems.length > 1) out.push(`확인할 슬롯 ${problems.length}개`)
  return out.length ? out.join(' · ') : null
}

/** 접은 "이번 장 예시"의 경고 — 펼치면 빨갛게 보이는 것과 같다 (모델 한도로 빠진 캐릭터, 고치지 않는 인원 태그 충돌) */
export function castPreviewWarning(res: CastResolution, check: CountCheck | null, fixed: boolean): string | null {
  const out: string[] = []
  if (res.dropped.length) out.push(`${res.dropped.length}명 빠짐`)
  if (check?.conflict && !fixed) out.push('인원 태그 충돌')
  return out.length ? out.join(' · ') : null
}

/** 변형 그룹이 아무것도 넣지 못하는 설정인가 (미사용은 고른 것이라 경고하지 않는다) */
export function variationProblem(g: VariationGroup): string | null {
  if (g.mode === 'off') return null
  if (!g.items.length) return '항목 없음'
  if (g.mode === 'random' && !g.items.some((x) => x.weight > 0)) return '비중이 모두 0'
  return null
}

/** 그룹 카드 머리: 무작위 · 4개 */
export function variationGroupSummary(g: VariationGroup): string {
  return `${VARIATION_MODES.find((m) => m.value === g.mode)?.label ?? ''} · ${g.items.length}개`
}

/** 접은 "변형 그룹" — 복장 · 표정 · 자세 */
export function variationsSummary(groups: readonly VariationGroup[]): string {
  if (!groups.length) return '없음'
  return groups.map((g) => (g.mode === 'off' ? `${variationGroupLabel(g)}(미사용)` : variationGroupLabel(g))).join(' · ')
}

export function variationsWarning(groups: readonly VariationGroup[]): string | null {
  const bad = groups.map((g) => [g, variationProblem(g)] as const).filter(([, p]) => p)
  if (!bad.length) return null
  if (bad.length === 1) return `${variationGroupLabel(bad[0][0])} ${bad[0][1]}`
  return `확인할 그룹 ${bad.length}개`
}

/** 접은 "라이브러리" — 12명 · 폴더 3개 */
export function librarySummary(characters: readonly unknown[], folderCount: number): string {
  return folderCount ? `${characters.length}명 · 폴더 ${folderCount}개` : `${characters.length}명`
}
