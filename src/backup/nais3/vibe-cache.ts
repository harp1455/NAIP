/**
 * NAIS3 바이브 인코딩 캐시 형식 — NAIS3 (© sunanakgo, GPL-3.0) src/main/refs/vibe-encoding-cache.ts 를 옮겼다.
 *
 * vibe_images.encoded 열 (그리고 인코딩 전용 바이브의 .nais3vibe 파일 내용):
 *   'nais3-vibe-cache-v1:' + JSON { [모델]: { ie, data } }   — 모델마다 마지막 인코딩 하나
 *   또는 예전 형식: 맨 인코딩 문자열 + encoded_ie 열 → nai-diffusion-4-5-full 로 본다
 */

const PREFIX = 'nais3-vibe-cache-v1:'
const LEGACY_MODEL = 'nai-diffusion-4-5-full'

export type VibeCache = Record<string, { ie: number; data: string }>

export function parseVibeCache(encoded: string | null, legacyIe: number | null): VibeCache {
  if (!encoded) return {}
  if (encoded.startsWith(PREFIX)) {
    try {
      const value = JSON.parse(encoded.slice(PREFIX.length)) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
      const cache: VibeCache = {}
      for (const [model, raw] of Object.entries(value)) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        const entry = raw as { ie?: unknown; data?: unknown }
        if (typeof entry.ie === 'number' && typeof entry.data === 'string') cache[model] = { ie: entry.ie, data: entry.data }
      }
      return cache
    } catch {
      return {}
    }
  }
  return legacyIe === null ? {} : { [LEGACY_MODEL]: { ie: legacyIe, data: encoded } }
}

export function isVibeCacheString(value: string): boolean {
  return value.startsWith(PREFIX)
}

export function packVibeCache(cache: VibeCache): string {
  const sorted = Object.fromEntries(Object.entries(cache).sort(([a], [b]) => a.localeCompare(b)))
  return PREFIX + JSON.stringify(sorted)
}
