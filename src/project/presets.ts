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

/**
 * JPEG 배경색 — #rgb / #rrggbb, CSS 색 이름(white·black …), rgb(r, g, b). 캔버스가 못 읽는 글자는 조용히
 * 검정이 되므로 이것만 받아 16진수로 바꿔 넘긴다 (예전에 저장한 "black" 같은 이름도 그대로 쓰인다)
 */
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
const RGB_COLOR = /^rgb\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*\)$/i

/** CSS Color 4의 색 이름 148개 (transparent는 JPEG에 쓸 수 없어 뺀다) */
const NAMED_COLORS = new Map(
  (
    'aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc ' +
    'bisque:ffe4c4 black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a ' +
    'burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed ' +
    'cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b ' +
    'darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b darkmagenta:8b008b ' +
    'darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 darksalmon:e9967a ' +
    'darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f darkslategrey:2f4f4f darkturquoise:00ced1 ' +
    'darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 dodgerblue:1e90ff ' +
    'firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ' +
    'ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 ' +
    'honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa ' +
    'lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 ' +
    'lightcyan:e0ffff lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 ' +
    'lightpink:ffb6c1 lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 ' +
    'lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 ' +
    'linen:faf0e6 magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 ' +
    'mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a ' +
    'mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 ' +
    'moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 ' +
    'orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee ' +
    'palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd ' +
    'powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 ' +
    'saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d ' +
    'silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa ' +
    'springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 ' +
    'turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 ' +
    'yellowgreen:9acd32'
  )
    .split(' ')
    .map((pair) => pair.split(':') as [string, string])
)

/** 받을 수 있는 색이면 #rrggbb / #rgb (소문자), 아니면 undefined */
function parseColor(text: string): string | undefined {
  const t = text.trim().toLowerCase()
  if (HEX_COLOR.test(t)) return t
  const named = NAMED_COLORS.get(t)
  if (named) return `#${named}`
  const rgb = RGB_COLOR.exec(t)
  if (rgb && rgb.slice(1).every((v) => Number(v) <= 255)) {
    return `#${rgb.slice(1).map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`
  }
  return undefined
}

/** 배경색을 캔버스에 넘길 꼴로 (# 빠진 16진수는 붙여 주고, 읽을 수 없으면 undefined = 기본 흰색) */
export function normalizeBackground(bg: string | undefined): string | undefined {
  const t = bg?.trim() ?? ''
  if (!t) return undefined
  return parseColor(t) ?? (t.startsWith('#') ? undefined : parseColor(`#${t}`))
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
  if (p.format === 'jpeg' && p.background?.trim() && !parseColor(p.background)) {
    errors.push('배경색은 #ffffff처럼 #과 16진수 3자리 또는 6자리, 또는 white·black 같은 색 이름으로 적어 주세요')
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
    // 예전에 저장한 잘못된 색은 넘기지 않는다 (캔버스가 검정으로 채우고 경고는 그 색이라고 말하게 된다)
    ...(normalizeBackground(p.background) ? { background: normalizeBackground(p.background) } : {}),
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
