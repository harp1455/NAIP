/**
 * .naipbackup 안의 배치:
 *
 *   manifest.json                 { format:'NAIP', formatVersion:1, app, appVersion, createdAt, mode, sections, counts }
 *   checksums.json                { [경로]: { sha256, size } } — manifest·checksums 를 뺀 모든 항목 (압축 전 기준)
 *   sections/<섹션>.json           섹션 데이터 (JSON). 그림은 { "__asset": 경로, encoding, mime } 로 빼낸다
 *   assets/<섹션>/<순번>-<id>.<확장자>   바이브·레퍼런스 원본, 마스크 PNG (무압축)
 *   history/meta-000001.jsonl     히스토리 기록 500개씩, 한 줄에 { record, original }
 *   history/originals/<id>.<확장자>  히스토리 원본 그림 (전체 백업, 무압축)
 *
 * 항목은 모두 상대 경로·슬래시 구분이며, manifest 와 checksums 는 맨 끝에 쓴다
 * (쓰는 동안 계산한 해시·개수를 담기 위해 — 읽을 때는 중앙 디렉터리로 찾으므로 순서는 상관없다).
 */
import { base64ByteLength, extForMime, fromBase64, safeSegment, sniffImage, toBase64 } from './bytes'
import type { BackupData, BackupItem, DataSectionId, SectionId } from './types'

export const MANIFEST_PATH = 'manifest.json'
export const CHECKSUMS_PATH = 'checksums.json'
export const HISTORY_PAGE_SIZE = 500

export function sectionPath(id: DataSectionId): string {
  return `sections/${id}.json`
}

export function historyPagePath(n: number): string {
  return `history/meta-${String(n).padStart(6, '0')}.jsonl`
}

export const HISTORY_PAGE_RE = /^history\/meta-(\d{6})\.jsonl$/

export function originalPath(id: number | string, mime: string | undefined, bytes?: Uint8Array): string {
  const ext = (bytes && sniffImage(bytes)?.ext) || extForMime(mime)
  return `history/originals/${safeSegment(id)}.${ext}`
}

/** 섹션 JSON 안에서 그림을 가리키는 표식 */
export interface AssetRef {
  __asset: string
  /** 원래 값이 맨 base64 였는지 data URL 이었는지 — 복원할 때 같은 모양으로 되돌린다 */
  encoding: 'base64' | 'dataurl'
  mime: string
}

export function isAssetRef(v: unknown): v is AssetRef {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const r = v as Record<string, unknown>
  return typeof r.__asset === 'string' && (r.encoding === 'base64' || r.encoding === 'dataurl') && typeof r.mime === 'string'
}

/** 섹션별로 따로 빼낼 큰 그림 필드 (배열 키 → 항목의 필드) */
export const ASSET_FIELDS: Partial<Record<DataSectionId, { array: string; field: string; dir: string }[]>> = {
  vibes: [{ array: 'vibes', field: 'image', dir: 'assets/vibes' }],
  charRefs: [{ array: 'charRefs', field: 'image', dir: 'assets/charrefs' }],
  masks: [{ array: 'masks', field: 'data', dir: 'assets/masks' }]
}

export interface PendingAsset {
  path: string
  /** 쓰는 순간에 디코딩한다 (모든 그림을 한꺼번에 바이트로 들고 있지 않도록) */
  bytes: () => Uint8Array
  size: number
}

function sniffBase64(base64: string): ReturnType<typeof sniffImage> {
  try {
    return sniffImage(fromBase64(base64.slice(0, 24)))
  } catch {
    return null
  }
}

function parseImageString(value: string): { encoding: 'base64' | 'dataurl'; mime: string; base64: string } {
  const m = /^data:([^;,]+)?(;base64)?,/.exec(value)
  if (m) return { encoding: 'dataurl', mime: m[1] || 'application/octet-stream', base64: value.slice(m[0].length) }
  return { encoding: 'base64', mime: 'image/png', base64: value }
}

/**
 * 섹션 데이터에서 그림 필드를 자산 항목으로 빼내고 그 자리에 AssetRef 를 둔다.
 * 빈 문자열('')은 "그림 없음"이라 그대로 둔다.
 */
export function extractAssets(id: DataSectionId, payload: unknown): { json: unknown; assets: PendingAsset[] } {
  const specs = ASSET_FIELDS[id]
  if (!specs || !payload || typeof payload !== 'object') return { json: payload, assets: [] }
  const out: Record<string, unknown> = { ...(payload as Record<string, unknown>) }
  const assets: PendingAsset[] = []
  for (const spec of specs) {
    const list = out[spec.array]
    if (!Array.isArray(list)) continue
    out[spec.array] = list.map((item: unknown, i) => {
      if (!item || typeof item !== 'object') return item
      const value = (item as Record<string, unknown>)[spec.field]
      if (typeof value !== 'string' || !value) return item
      const parsed = parseImageString(value)
      const itemId = (item as BackupItem).id
      // 실제 형식은 내용으로 판별해 확장자를 붙인다 (앞 몇 바이트만 디코딩)
      const sniffed = sniffBase64(parsed.base64)
      const mime = sniffed?.mime ?? parsed.mime
      const path = `${spec.dir}/${i}-${safeSegment(itemId ?? i)}.${sniffed?.ext ?? extForMime(mime)}`
      assets.push({ path, bytes: () => fromBase64(parsed.base64), size: base64ByteLength(parsed.base64) })
      const ref: AssetRef = { __asset: path, encoding: parsed.encoding, mime }
      return { ...(item as Record<string, unknown>), [spec.field]: ref }
    })
  }
  return { json: out, assets }
}

/**
 * AssetRef 를 원래 문자열로 되돌린다. 읽지 못한 그림은 '' 로 두고 onMissing 으로 알린다.
 */
export async function inlineAssets(
  id: DataSectionId,
  payload: unknown,
  read: (path: string) => Promise<Uint8Array | null>,
  onMissing: (info: { array: string; index: number; item: BackupItem; path: string }) => void
): Promise<unknown> {
  const specs = ASSET_FIELDS[id]
  if (!specs || !payload || typeof payload !== 'object') return payload
  const out: Record<string, unknown> = { ...(payload as Record<string, unknown>) }
  for (const spec of specs) {
    const list = out[spec.array]
    if (!Array.isArray(list)) continue
    const next: unknown[] = []
    for (let i = 0; i < list.length; i++) {
      const item = list[i] as Record<string, unknown>
      const ref = item && typeof item === 'object' ? item[spec.field] : undefined
      if (!isAssetRef(ref)) {
        next.push(item)
        continue
      }
      // 섹션이 가리킬 수 있는 곳은 자기 자산 폴더뿐이다
      const bytes = ref.__asset.startsWith(`${spec.dir}/`) ? await read(ref.__asset) : null
      if (!bytes) {
        onMissing({ array: spec.array, index: i, item: item as BackupItem, path: ref.__asset })
        next.push({ ...item, [spec.field]: '' })
        continue
      }
      const base64 = toBase64(bytes)
      next.push({ ...item, [spec.field]: ref.encoding === 'dataurl' ? `data:${ref.mime};base64,${base64}` : base64 })
    }
    out[spec.array] = next
  }
  return out
}

/** 섹션의 항목 수 (manifest counts·미리보기용) */
export function countSection(id: SectionId, payload: unknown): number {
  if (!payload || typeof payload !== 'object') return 0
  const p = payload as Record<string, unknown>
  const len = (k: string): number => (Array.isArray(p[k]) ? (p[k] as unknown[]).length : 0)
  switch (id) {
    case 'presets':
      return len('presets')
    case 'characters':
      return len('characters')
    case 'scenes':
      return len('scenes')
    case 'fragments':
      return len('fragments')
    case 'vibes':
      return len('vibes')
    case 'charRefs':
      return len('charRefs')
    case 'masks':
      return len('masks')
    case 'tagUsage':
      return p.entries && typeof p.entries === 'object' ? Object.keys(p.entries).length : 0
    case 'saveFolders':
      return len('saveFolders')
    case 'projects':
      return len('projects')
    default:
      return Object.keys(p).length ? 1 : 0
  }
}

/** 설정 스토어 상태 → 백업할 설정과 저장 폴더 섹션. 서버에서 받는 구독 정보는 백업하지 않는다 */
export const TRANSIENT_SETTINGS = ['subscription', 'subscriptionAt', 'subscriptionError', 'hydrated', 'secretsLoaded', 'secretErrors'] as const
/**
 * 이 기기에서만 정하는 설정 — 백업에 넣지 않고, 백업에서 받지도 않는다.
 * 업데이트 받을 저장소: 남이 만든 백업을 복원했을 때 앱이 내려받아 설치하라고 권할 APK의 출처가 바뀌지 않게
 */
export const DEVICE_SETTINGS = ['updateRepo'] as const
/** 백업에 넣지도, 백업에서 받지도 않는 설정 키 */
export const UNSAVED_SETTINGS: readonly string[] = [...TRANSIENT_SETTINGS, ...DEVICE_SETTINGS]
export const SAVE_FOLDER_KEYS = ['saveFolders', 'saveFolder', 'nameMode', 'nameCounters'] as const

export function splitSettings(state: Record<string, unknown>): Pick<BackupData, 'settings' | 'saveFolders'> {
  const settings: Record<string, unknown> = {}
  const saveFolders: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(state)) {
    if (typeof v === 'function') continue
    if (UNSAVED_SETTINGS.includes(k)) continue
    if ((SAVE_FOLDER_KEYS as readonly string[]).includes(k)) saveFolders[k] = v
    else settings[k] = v
  }
  return { settings, saveFolders }
}
