/**
 * 선별 도우미 — 조합별로 그림을 모으고, 채택/보류/탈락 표시, 대표 이미지, 교체(버전), 개수·상태 계산.
 * 모두 새 객체를 돌려주는 순수 함수다 (저장소는 store.ts가 이 함수들로 상태를 바꾼다).
 */
import { pathKey } from './template'
import type { AssetImage, AssetItem, AssetStatus, CurationMark } from './types'

export function emptyItem(key: string): AssetItem {
  return { key, images: [], queued: 0, generating: 0, failed: 0 }
}

export interface CurationCounts {
  total: number
  unreviewed: number
  adopted: number
  hold: number
  rejected: number
}

export function curationCounts(item: AssetItem | undefined): CurationCounts {
  const c: CurationCounts = { total: 0, unreviewed: 0, adopted: 0, hold: 0, rejected: 0 }
  for (const img of item?.images ?? []) {
    c.total++
    c[img.mark]++
  }
  return c
}

/** 진행률 = 채택 / 목표 (0~1, 목표를 넘겨 채택해도 1) */
export function progressOf(adopted: number, target: number): number {
  if (target <= 0) return 1
  return Math.min(1, Math.max(0, adopted / target))
}

/**
 * 조합의 상태. 우선순위: 생성 중 → 생성 대기 → 재생성 필요(사용자 표시) → 채택/내보내기 완료(목표 달성)
 * → 선별 필요(미선별·보류가 남음) → 미생성(그림 없음) / 재생성 필요(다 골랐는데 목표 미달 또는 실패만 있음)
 */
export function itemStatus(item: AssetItem | undefined, target: number): AssetStatus {
  if (!item) return 'pending'
  if (item.generating > 0) return 'generating'
  if (item.queued > 0) return 'queued'
  if (item.redo) return 'redo'
  const c = curationCounts(item)
  const goal = Math.max(1, target)
  if (c.adopted >= goal) {
    const adopted = item.images.filter((i) => i.mark === 'adopted')
    return adopted.every((i) => i.exported) ? 'exported' : 'adopted'
  }
  if (c.unreviewed > 0 || c.hold > 0) return 'review'
  if (c.total === 0) return item.failed > 0 ? 'redo' : 'pending'
  return 'redo'
}

/** 키를 가진 것들을 조합 키별로 모은다 (처음 나온 순서 유지) */
export function groupByCombination<T>(list: readonly T[], keyOf: (x: T) => string | undefined): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const x of list) {
    const key = keyOf(x)
    if (key === undefined) continue
    const arr = out.get(key)
    if (arr) arr.push(x)
    else out.set(key, [x])
  }
  return out
}

export type NewAssetImage = Omit<AssetImage, 'mark' | 'slot' | 'version' | 'replaces' | 'supersededBy' | 'exported'> & {
  mark?: CurationMark
}

/**
 * 생성된 그림을 조합에 넣는다 (같은 id가 이미 있으면 그대로). 성공한 장은 실패 하나를 상쇄하고,
 * 생성 중·대기 장수를 하나 줄인다 (리드가 시작/끝을 따로 알리지 않아도 맞게)
 */
export function addImage(item: AssetItem, image: NewAssetImage, opts: { fromQueue?: boolean } = {}): AssetItem {
  if (item.images.some((i) => i.id === image.id)) return item
  const next: AssetItem = {
    ...item,
    images: [...item.images, { ...image, mark: image.mark ?? 'unreviewed' }],
    failed: Math.max(0, item.failed - 1)
  }
  if (opts.fromQueue !== false) {
    if (next.generating > 0) next.generating--
    else if (next.queued > 0) next.queued--
  }
  if (image.mark === 'adopted') return assignSlots(next, [image.id])
  return next
}

/** 비어 있는 가장 작은 채택 칸 */
function freeSlot(images: readonly AssetImage[]): number {
  const used = new Set(images.filter((i) => i.mark === 'adopted' && i.slot).map((i) => i.slot!))
  let n = 1
  while (used.has(n)) n++
  return n
}

/** 칸이 없는 채택 그림에 칸을 준다 */
function assignSlots(item: AssetItem, ids: readonly number[]): AssetItem {
  const images = item.images.map((i) => ({ ...i }))
  for (const id of ids) {
    const img = images.find((i) => i.id === id)
    if (!img || img.mark !== 'adopted' || img.slot) continue
    img.slot = freeSlot(images)
    img.version ??= 1
  }
  return { ...item, images }
}

/**
 * 채택/보류/탈락/미선별 표시. 채택하면 빈 칸을 받고, 채택을 풀면 칸을 내놓는다
 * (칸의 이미지 코드는 item.codes에 남아 다음에 그 칸을 받는 그림이 이어 쓴다)
 */
export function setMarks(item: AssetItem, ids: readonly number[], mark: CurationMark): AssetItem {
  const hit = new Set(ids)
  let changed = false
  const images = item.images.map((i) => {
    if (!hit.has(i.id) || i.mark === mark) return i
    changed = true
    const next: AssetImage = { ...i, mark }
    if (mark !== 'adopted') {
      delete next.slot
      delete next.version
    }
    return next
  })
  if (!changed) return item
  const next: AssetItem = { ...item, images }
  // 사용자가 "재생성 필요"로 표시했어도 새로 채택하면 표시를 거둔다
  if (mark === 'adopted') delete next.redo
  if (next.representative !== undefined && hit.has(next.representative) && mark === 'rejected') delete next.representative
  return mark === 'adopted' ? assignSlots(next, ids) : next
}

/**
 * 채택한 그림을 새 그림으로 교체 — 새 그림이 같은 칸·다음 버전을 물려받고(파일 이름·코드 유지),
 * 이전 그림은 탈락으로 바뀌며 supersededBy로 이어진다. 대표 이미지였으면 새 그림이 대표가 된다
 */
export function replaceAdopted(item: AssetItem, oldId: number, newId: number): AssetItem {
  const old = item.images.find((i) => i.id === oldId)
  const fresh = item.images.find((i) => i.id === newId)
  if (!old || !fresh || oldId === newId || old.mark !== 'adopted') return item
  const slot = old.slot ?? freeSlot(item.images.filter((i) => i.id !== oldId))
  const images = item.images.map((i): AssetImage => {
    if (i.id === oldId) {
      const prev: AssetImage = { ...i, mark: 'rejected', supersededBy: newId }
      delete prev.slot
      return prev
    }
    if (i.id === newId) {
      const next: AssetImage = { ...i, mark: 'adopted', slot, version: (old.version ?? 1) + 1, replaces: oldId }
      delete next.supersededBy
      return next
    }
    return i
  })
  const next: AssetItem = { ...item, images }
  if (item.representative === oldId) next.representative = newId
  delete next.redo
  return next
}

/** 그림의 버전 사슬 (처음 버전 → 지금 그림 순). 교체 기록을 replaces로 거슬러 올라간다 */
export function versionChain(item: AssetItem, id: number): AssetImage[] {
  const byId = new Map(item.images.map((i) => [i.id, i]))
  const chain: AssetImage[] = []
  const seen = new Set<number>()
  // 최신 쪽으로 먼저 따라간 뒤 거꾸로 올라간다
  let cur = byId.get(id)
  while (cur?.supersededBy !== undefined && byId.has(cur.supersededBy) && !seen.has(cur.id)) {
    seen.add(cur.id)
    cur = byId.get(cur.supersededBy)
  }
  seen.clear()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    chain.unshift(cur)
    cur = cur.replaces !== undefined ? byId.get(cur.replaces) : undefined
  }
  return chain
}

/** 대표 이미지 지정 (조합에 없는 그림이면 그대로) */
export function setRepresentative(item: AssetItem, id: number | null): AssetItem {
  if (id === null) {
    const next = { ...item }
    delete next.representative
    return next
  }
  if (!item.images.some((i) => i.id === id)) return item
  return { ...item, representative: id }
}

/** 대표 이미지 — 지정한 것 → 채택 첫 칸 → 보류 중 최신 → 미선별 중 최신 → 아무 그림 중 최신 */
export function representativeOf(item: AssetItem | undefined): AssetImage | null {
  if (!item || !item.images.length) return null
  const chosen = item.representative !== undefined ? item.images.find((i) => i.id === item.representative) : undefined
  if (chosen && chosen.mark !== 'rejected') return chosen
  const adopted = adoptedImages(item)
  if (adopted.length) return adopted[0]
  const newest = (mark?: CurationMark): AssetImage | undefined =>
    item.images.filter((i) => !mark || i.mark === mark).reduce<AssetImage | undefined>((a, b) => (!a || b.ts > a.ts ? b : a), undefined)
  return newest('hold') ?? newest('unreviewed') ?? newest() ?? null
}

/** 채택 그림 (칸 순서) */
export function adoptedImages(item: AssetItem | undefined): AssetImage[] {
  return (item?.images ?? [])
    .filter((i) => i.mark === 'adopted')
    .sort((a, b) => (a.slot ?? Infinity) - (b.slot ?? Infinity) || a.ts - b.ts)
}

/** 그림을 조합에서 뺀다 (히스토리에서 지웠을 때). 칸 코드는 남는다 */
export function removeImages(item: AssetItem, ids: readonly number[]): AssetItem {
  const hit = new Set(ids)
  if (!item.images.some((i) => hit.has(i.id))) return item
  const next: AssetItem = { ...item, images: item.images.filter((i) => !hit.has(i.id)) }
  if (next.representative !== undefined && hit.has(next.representative)) delete next.representative
  return next
}

/**
 * 내보낸 경로 기록 (채택 칸이 있으면 그 칸의 경로도 — 다음에 그 칸을 받는 그림이 같은 파일을 쓴다).
 * 같은 파일을 가리키던 다른 그림의 기록은 지운다 — 그 파일은 이제 이 그림이라, 남겨 두면 그 그림을 다시
 * 채택했을 때 "새 것만"에서 빠지고 목록에 한 파일이 두 그림(두 코드)으로 실린다
 */
export function markExported(item: AssetItem, id: number, path: string, at: number, bytes?: number): AssetItem {
  const image = item.images.find((i) => i.id === id)
  if (!image) return item
  const same = pathKey(path)
  const next: AssetItem = {
    ...item,
    images: item.images.map((i) => {
      if (i.id === id) return { ...i, exported: { path, at, ...(bytes !== undefined ? { bytes } : {}) } }
      if (i.exported && pathKey(i.exported.path) === same) {
        const { exported: _, ...rest } = i
        return rest
      }
      return i
    })
  }
  if (image.mark === 'adopted' && image.slot !== undefined) next.slotPaths = { ...(item.slotPaths ?? {}), [String(image.slot)]: path }
  return next
}

/** 생성 대기·생성 중·실패 장수 조정 (음수가 되지 않게) */
export function bumpRuntime(
  item: AssetItem,
  delta: Partial<Record<'queued' | 'generating' | 'failed', number>>
): AssetItem {
  return {
    ...item,
    queued: Math.max(0, item.queued + (delta.queued ?? 0)),
    generating: Math.max(0, item.generating + (delta.generating ?? 0)),
    failed: Math.max(0, item.failed + (delta.failed ?? 0))
  }
}

/** 채택 칸의 이미지 코드를 정해 둔다 (이미 있으면 그대로) */
export function setSlotCodes(item: AssetItem, codes: Record<number, string>): AssetItem {
  const merged = { ...(item.codes ?? {}) }
  let changed = false
  for (const [slot, code] of Object.entries(codes)) {
    if (merged[slot]) continue
    merged[slot] = code
    changed = true
  }
  return changed ? { ...item, codes: merged } : item
}
