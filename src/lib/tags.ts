/** 단부루 / e621 태그 자동완성 — public/tags/*.tsv 를 처음 쓸 때 읽어 메모리에서 검색한다 */
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

interface TagTable {
  names: string[]
  counts: Int32Array
  cats: string[]
  kr: string[]
}

const tables: Partial<Record<TagSource, TagTable>> = {}
const loading: Partial<Record<TagSource, Promise<TagTable>>> = {}

function load(source: TagSource): Promise<TagTable> {
  const ready = tables[source]
  if (ready) return Promise.resolve(ready)
  loading[source] ??= fetch(`./tags/${source}.tsv`)
    .then((r) => {
      if (!r.ok) throw new Error(`tags ${r.status}`)
      return r.text()
    })
    .then((text) => {
      const lines = text.split('\n')
      if (!lines[lines.length - 1]) lines.pop()
      const table: TagTable = {
        names: new Array<string>(lines.length),
        counts: new Int32Array(lines.length),
        cats: new Array<string>(lines.length),
        kr: new Array<string>(lines.length)
      }
      lines.forEach((line, i) => {
        const [name, count, cat, kr] = line.split('\t')
        table.names[i] = name
        table.counts[i] = Number(count)
        table.cats[i] = cat
        table.kr[i] = kr ?? ''
      })
      tables[source] = table
      return table
    })
    .catch((e) => {
      delete loading[source]
      throw e
    })
  return loading[source]!
}

const HANGUL = /[ㄱ-ㆎ가-힣]/

function tierOf(name: string, q: string): number {
  const at = name.indexOf(q)
  if (at < 0) return -1
  if (at === 0) return name.length === q.length ? 0 : 1
  // 단어 시작: 앞 글자가 공백·괄호·하이픈 등 구분자
  let i = at
  while (i >= 0) {
    if (/[\s(\-_:/]/.test(name[i - 1])) return 2
    i = name.indexOf(q, i + 1)
    if (i < 0) break
  }
  return 3
}

/**
 * 정확도 순 검색: 완전 일치 → 앞부분 일치 → 단어 시작 일치 → 포함 → 한국어 키워드,
 * 같은 단계 안에서는 게시물 수가 많은 순. 두 사이트에 다 있는 태그는 하나로 합친다.
 */
export async function searchTags(
  query: string,
  setting: TagSourceSetting,
  opts: { limit?: number; artistOnly?: boolean } = {}
): Promise<TagHit[]> {
  const limit = opts.limit ?? 20
  const q = query.trim().toLowerCase().replace(/_/g, ' ')
  const korean = HANGUL.test(q)
  if (setting === 'off' || q.length < (korean ? 1 : 2)) return []
  const sources: TagSource[] = setting === 'both' ? ['danbooru', 'e621'] : [setting]
  const loaded = await Promise.all(sources.map((s) => load(s).catch(() => null)))

  const merged = new Map<string, TagHit>()
  loaded.forEach((table, si) => {
    if (!table) return
    const source = sources[si]
    // 단계별로 limit개까지만 모은다 (표는 게시물 수 내림차순이라 먼저 만난 것이 인기 태그)
    const perTier = [0, 0, 0, 0, 0]
    for (let i = 0; i < table.names.length; i++) {
      if (opts.artistOnly && table.cats[i] !== 'a') continue
      const name = table.names[i]
      let tier: number
      let keyword: string | undefined
      if (korean) {
        const kr = table.kr[i]
        if (!kr || !kr.includes(q)) continue
        keyword = kr.split(', ').find((k) => k.includes(q))
        tier = keyword === q ? 0 : keyword?.startsWith(q) ? 1 : 4
      } else {
        tier = tierOf(name, q)
        if (tier < 0) continue
      }
      if (perTier[tier] >= limit) continue
      perTier[tier]++
      const hit = merged.get(name)
      if (hit) {
        hit.counts[source] = table.counts[i]
        hit.tier = Math.min(hit.tier, tier)
      } else {
        merged.set(name, {
          tag: name,
          category: table.cats[i] as TagCategory,
          counts: { [source]: table.counts[i] },
          tier,
          ...(keyword ? { keyword } : {})
        })
      }
    }
  })
  const total = (h: TagHit): number => Math.max(h.counts.danbooru ?? 0, h.counts.e621 ?? 0)
  return [...merged.values()].sort((a, b) => a.tier - b.tier || total(b) - total(a)).slice(0, limit)
}

export function formatCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}
