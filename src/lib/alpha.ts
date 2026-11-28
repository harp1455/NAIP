/**
 * 투명 배경 그림 다루기 — V5 "배경 투명"(straight_alpha)으로 만든 그림과 디렉터 "배경 제거" 결과.
 * 원본 PNG는 알파를 그대로 저장·복사한다(다시 인코딩하지 않는다). 화면에서는 투명한 곳이 보이도록 뒤에 체크무늬를 깔고,
 * 알파가 없는 JPEG 썸네일은 투명한 곳을 체크무늬 위에 합쳐 둔다 (그대로 두면 검게 된다).
 */
import type { CSSProperties } from 'react'
import { modelCapabilities } from '../nai/models'

/** 체크무늬 두 색 (밝은 칸 / 어두운 칸) — 썸네일과 화면이 같은 색을 쓴다 */
export const CHECKER_LIGHT = 0xec
export const CHECKER_DARK = 0xc4
/** 썸네일 체크무늬 한 칸 (px) — JPEG 8×8 블록에 맞춰 번지지 않게 */
export const CHECKER_CELL = 8

/** 생성 기록(설정 스냅샷)으로 본, V5 배경 투명으로 만든 그림인지 (실제로 보낸 모델 기준) */
export function generatedTransparent(meta: { model: string; snap?: { params: Record<string, unknown> } }): boolean {
  return meta.snap?.params?.transparentBackground === true && modelCapabilities(meta.model).transparency
}

/** 배경이 투명할 수 있는 그림인지 — V5 배경 투명 생성이거나 디렉터 배경 제거 결과 */
export function hasAlphaBackground(meta: { model: string; snap?: { params: Record<string, unknown> } }): boolean {
  return meta.model === 'director:bg-removal' || generatedTransparent(meta)
}

/**
 * RGBA 픽셀(가로 width)의 투명한 곳을 체크무늬 위에 합쳐 불투명하게 만든다 (JPEG 썸네일용).
 * 눈에 띄게 투명한 픽셀(알파 250 미만)이 하나도 없으면 손대지 않고 false — 보통 그림의 썸네일은 예전과 같다.
 * (NAI 그림은 알파 최하위 비트에 정보를 숨겨 254·255가 섞여 있다)
 */
export function flattenOnChecker(d: Uint8ClampedArray, width: number, cell = CHECKER_CELL): boolean {
  let transparent = false
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] < 250) {
      transparent = true
      break
    }
  }
  if (!transparent) return false
  const w = Math.max(1, Math.floor(width))
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const a = d[i + 3]
    if (a === 255) continue
    const x = p % w
    const y = (p - x) / w
    const bg = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? CHECKER_LIGHT : CHECKER_DARK
    const f = a / 255
    d[i] = Math.round(d[i] * f + bg * (1 - f))
    d[i + 1] = Math.round(d[i + 1] * f + bg * (1 - f))
    d[i + 2] = Math.round(d[i + 2] * f + bg * (1 - f))
    d[i + 3] = 255
  }
  return true
}

const hex = (v: number): string => `#${v.toString(16).padStart(2, '0').repeat(3)}`

/**
 * object-contain 으로 띄운 투명 그림 뒤의 체크무늬 (img 의 style). 그림 비율의 SVG를 background-size: contain 으로 깔아
 * 그림이 그려지는 칸에만 체크무늬가 생긴다 (위아래·양옆 빈 곳은 그대로). 칸 크기는 그림 긴 변의 1/48
 */
export function checkerStyle(width: number, height: number): CSSProperties {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const c = Math.max(4, Math.round(Math.max(w, h) / 48))
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'>` +
    `<defs><pattern id='k' width='${c * 2}' height='${c * 2}' patternUnits='userSpaceOnUse'>` +
    `<rect width='${c * 2}' height='${c * 2}' fill='${hex(CHECKER_LIGHT)}'/>` +
    `<path d='M0 0h${c}v${c}H0zM${c} ${c}h${c}v${c}h-${c}z' fill='${hex(CHECKER_DARK)}'/>` +
    `</pattern></defs><rect width='${w}' height='${h}' fill='url(#k)'/></svg>`
  return {
    backgroundImage: `url("data:image/svg+xml,${encodeURIComponent(svg)}")`,
    backgroundSize: 'contain',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat'
  }
}
