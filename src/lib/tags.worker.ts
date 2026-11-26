/// <reference lib="webworker" />
/**
 * 태그 자동완성 검색 워커 — 8MB 가량의 태그 표를 읽고 훑는 일이 화면을 멈추지 않도록 따로 돈다
 * (NAIS3 1.0.33의 "빠른 태그 자동완성"과 같은 취지).
 */
import type { TagCategory, TagHit, TagSource, TagSourceSetting } from './tags'

let base = ''

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
  loading[source] ??= fetch(`${base}${source}.tsv`)
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
async function searchTags(
  query: string,
  setting: TagSourceSetting,
  opts: { limit?: number; artistOnly?: boolean } = {}
): Promise<TagHit[]> {
  const limit = opts.limit ?? 20
  // 밑줄에서 온 공백은 다듬지 않는다 — `cow_`는 "cow 뒤에 단어가 이어짐"이라는 뜻 (NAIS3 규칙)
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


onmessage = async (
  e: MessageEvent<{
    id: number
    base: string
    query: string
    setting: TagSourceSetting
    opts: { limit?: number; artistOnly?: boolean }
  }>
) => {
  base = e.data.base
  try {
    postMessage({ id: e.data.id, hits: await searchTags(e.data.query, e.data.setting, e.data.opts) })
  } catch (err) {
    postMessage({ id: e.data.id, error: String((err as Error)?.message ?? err) })
  }
}
