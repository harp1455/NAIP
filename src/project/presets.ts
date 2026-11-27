/**
 * 내보내기 변환 프리셋 — 사용자가 직접 만드는 것만 있다.
 *
 * 크랙(crack)을 비롯한 캐릭터 챗 플랫폼의 업로드 형식·크기·용량 제한은 확인된 공식 수치를 구하지 못해
 * 앱에 미리 넣어 두지 않는다. 플랫폼 안내를 보고 사용자가 이름·형식·최대 가로세로·최대 용량·품질을 정해
 * 저장하면, 내보낼 때 presetToConvertOptions로 변환 옵션이 된다. (확인된 수치가 생기면 여기서 기본 프리셋으로 추가)
 */
import type { ConvertOptions } from './convert'
import type { PlatformPreset } from './types'

/** 새 프리셋 양식의 시작값 (플랫폼 제한이 아니라 빈 양식) */
export const BLANK_PRESET: Omit<PlatformPreset, 'id'> = {
  name: '',
  format: 'webp',
  quality: 0.9,
  minQuality: 0.6
}

/** 저장 전에 확인할 것 — 잘못된 칸마다 한국어 메시지 */
export function validatePreset(p: Omit<PlatformPreset, 'id'>): string[] {
  const errors: string[] = []
  const positiveInt = (v: number | undefined): boolean => v === undefined || (Number.isInteger(v) && v > 0)
  if (!p.name.trim()) errors.push('프리셋 이름을 적어 주세요')
  if (!['png', 'jpeg', 'webp'].includes(p.format)) errors.push('형식은 PNG, JPEG, WebP 중 하나여야 합니다')
  if (!positiveInt(p.maxWidth)) errors.push('최대 가로는 1 이상의 정수여야 합니다')
  if (!positiveInt(p.maxHeight)) errors.push('최대 세로는 1 이상의 정수여야 합니다')
  if (p.maxWidth !== undefined && p.maxWidth > 16384) errors.push('최대 가로가 너무 큽니다 (16384 이하)')
  if (p.maxHeight !== undefined && p.maxHeight > 16384) errors.push('최대 세로가 너무 큽니다 (16384 이하)')
  if (p.maxBytes !== undefined && !(Number.isFinite(p.maxBytes) && p.maxBytes >= 1024)) {
    errors.push('최대 용량은 1KB 이상이어야 합니다')
  }
  const q = (v: number | undefined): boolean => v === undefined || (v > 0 && v <= 1)
  if (!q(p.quality)) errors.push('품질은 0보다 크고 1 이하여야 합니다')
  if (!q(p.minQuality)) errors.push('품질 하한은 0보다 크고 1 이하여야 합니다')
  if (p.quality !== undefined && p.minQuality !== undefined && p.minQuality > p.quality) {
    errors.push('품질 하한이 품질보다 높습니다')
  }
  return errors
}

/** 저장은 되지만 알려 둘 점 */
export function presetNotes(p: Omit<PlatformPreset, 'id'>): string[] {
  const notes: string[] = []
  if (p.format === 'png' && p.maxBytes) {
    notes.push('PNG는 품질로 용량을 줄일 수 없어 최대 용량을 넘을 수 있습니다 (내보낼 때 크기 줄이기를 허용하거나 WebP·JPEG를 쓰세요)')
  }
  if (p.format === 'jpeg') notes.push('JPEG는 투명도를 담지 못해 투명한 부분을 배경색으로 채웁니다')
  return notes
}

/** 프리셋 → 변환 옵션 (비율 유지·최대 크기 안으로 줄이기, 용량 제한이 있으면 목표 크기로) */
export function presetToConvertOptions(p: Omit<PlatformPreset, 'id'>): ConvertOptions {
  return {
    format: p.format,
    ...(p.maxWidth ? { maxWidth: p.maxWidth } : {}),
    ...(p.maxHeight ? { maxHeight: p.maxHeight } : {}),
    ...(p.quality !== undefined ? { quality: p.quality } : {}),
    ...(p.minQuality !== undefined ? { minQuality: p.minQuality } : {}),
    ...(p.maxBytes ? { targetBytes: p.maxBytes } : {}),
    ...(p.background ? { background: p.background } : {}),
    scrubAlpha: true
  }
}

/** 프리셋 요약 (목록 표시용) */
export function describePreset(p: Omit<PlatformPreset, 'id'>): string {
  const parts: string[] = [p.format === 'jpeg' ? 'JPEG' : p.format === 'webp' ? 'WebP' : 'PNG']
  if (p.maxWidth || p.maxHeight) parts.push(`최대 ${p.maxWidth ?? '∞'}×${p.maxHeight ?? '∞'}`)
  if (p.maxBytes) parts.push(`${Math.round(p.maxBytes / 1024)}KB 이하`)
  if (p.format !== 'png' && p.quality !== undefined) parts.push(`품질 ${Math.round(p.quality * 100)}%`)
  return parts.join(' · ')
}
