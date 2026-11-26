/** 단부루 / e621 태그 자동완성 — 검색은 tags.worker.ts 가 한다 (public/tags/*.tsv 를 처음 쓸 때 읽음) */
export type TagSource = 'danbooru' | 'e621'
export type TagSourceSetting = 'both' | TagSource | 'off'

/** g 일반, a 작가, c 캐릭터, s 작품, m 메타, p 종(e621), l 설정(e621) */
export type TagCategory = 'g' | 'a' | 'c' | 's' | 'm' | 'p' | 'l'

export interface TagHit {
  tag: string
  category: TagCategory
  /** 해당 사이트의 게시물 수 */
  counts: Partial<Record<TagSource, number>>
  /** 0 완전 일치, 1 앞부분 일치, 2 단어 시작 일치, 3 포함, 4 한국어 키워드 일치 */
  tier: number
  /** 한국어 키워드로 찾았을 때 그 키워드 */
  keyword?: string
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, (hits: TagHit[]) => void>()

function tagWorker(): Worker {
  if (worker) return worker
  const created = new Worker(new URL('./tags.worker.ts', import.meta.url), { type: 'module' })
  created.onmessage = (e: MessageEvent<{ id: number; hits?: TagHit[] }>) => {
    pending.get(e.data.id)?.(e.data.hits ?? [])
    pending.delete(e.data.id)
  }
  created.onerror = () => {
    for (const resolve of pending.values()) resolve([])
    pending.clear()
    if (worker === created) worker = null
  }
  worker = created
  return created
}

/**
 * 정확도 순 검색: 완전 일치 → 앞부분 일치 → 단어 시작 일치 → 포함 → 한국어 키워드,
 * 같은 단계 안에서는 게시물 수가 많은 순. 두 사이트에 다 있는 태그는 하나로 합친다.
 */
export function searchTags(
  query: string,
  setting: TagSourceSetting,
  opts: { limit?: number; artistOnly?: boolean } = {}
): Promise<TagHit[]> {
  if (setting === 'off' || !query.trim()) return Promise.resolve([])
  return new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    tagWorker().postMessage({ id, base: new URL('./tags/', document.baseURI).href, query, setting, opts })
  })
}

export function formatCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}
