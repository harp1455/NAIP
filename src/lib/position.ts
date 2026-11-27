import { isV5Model } from '../nai/models'

/**
 * 캐릭터 위치 규칙 (NAIS3 lib/character-position.ts 와 payload 주석 기준):
 * - V4/V4.5: NovelAI 웹의 5×5 격자 (0.1·0.3·0.5·0.7·0.9)만 쓴다
 * - V5: 자유 위치, 0.1% 단위 (0~1)
 * 좌표는 생성 해상도에 대한 비율이라 해상도를 바꿔도 상대 위치가 유지된다.
 * 위치는 "대략 어디에 둘지"의 힌트일 뿐 정확한 신체 배치를 보장하지 않는다.
 */
export interface Center {
  x: number
  y: number
}

export const GRID = [0.1, 0.3, 0.5, 0.7, 0.9]
export const MARKER_COLORS = ['#e8914f', '#3d8bff', '#3fc47a', '#c24dff', '#e5645a', '#e3c15a', '#7fd0c8', '#f08a8a']

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

function nearest(v: number): number {
  return GRID.reduce((best, g) => (Math.abs(g - v) < Math.abs(best - v) ? g : best), GRID[0])
}

export function freePositions(model: string): boolean {
  return isV5Model(model)
}

/** 이 모델이 받는 위치로 — V5는 0.1% 단위로 반올림, 그 밖은 가장 가까운 격자 칸 */
export function positionFor(center: Center, model: string): Center {
  if (freePositions(model)) {
    return { x: Math.round(clamp01(center.x) * 1000) / 1000, y: Math.round(clamp01(center.y) * 1000) / 1000 }
  }
  return { x: nearest(clamp01(center.x)), y: nearest(clamp01(center.y)) }
}

/** n명을 가로로 고르게 (가운데 높이) */
export function spreadPositions(n: number, model: string): Center[] {
  return Array.from({ length: n }, (_, i) => positionFor({ x: (i + 1) / (n + 1), y: 0.5 }, model))
}

export function mirrorPosition(center: Center, model: string): Center {
  return positionFor({ x: 1 - center.x, y: center.y }, model)
}
