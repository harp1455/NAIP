import type { HistoryFilter, HistoryMeta, ImageKind } from '../lib/db'
import { chunk, marks, type SqlDriver, type SqlStatement, type SqlValue } from './driver'
import { dataUrlMime, type FileStore } from './files'

/** 히스토리 목록 조건 — 화면의 HistoryFilter보다 넓다 (모델·종류·계보·날짜도 인덱스로 찾는다) */
export interface HistoryQuery {
  fav?: boolean
  unsaved?: boolean
  sceneId?: number
  model?: string
  kind?: ImageKind
  parentId?: number
  /** ts 범위 (ms, 포함) */
  from?: number
  to?: number
  /** 쉼표로 나눈 조각이 모두 들어 있어야 일치 */
  search?: string
}

export function filterToQuery(filter: HistoryFilter): HistoryQuery {
  if (!filter) return {}
  if ('fav' in filter) return { fav: true }
  if ('unsaved' in filter) return { unsaved: true }
  if ('sceneId' in filter) return { sceneId: filter.sceneId }
  return { search: filter.search }
}

/** DB 한 행 */
export interface ImageRow {
  id: number
  ts: number
  width: number
  height: number
  seed: number
  model: string
  kind: string
  prompt: string
  negative: string
  mime: string
  file: string | null
  bytes: number
  thumb: string | null
  scene_id: number | null
  scene_name: string | null
  fav: number
  unsaved: number
  saved: string | null
  parent_id: number | null
  req_id: string | null
  snap: string | null
  sent: string | null
  extra: string | null
}

/** 열로 따로 두는 HistoryMeta 필드. 나머지는 extra JSON으로 보존한다 */
const COLUMN_FIELDS = new Set([
  'id', 'ts', 'thumb', 'width', 'height', 'seed', 'model', 'kind', 'prompt', 'negative', 'mime',
  'sceneId', 'sceneName', 'fav', 'snap', 'sent', 'saved', 'parentId', 'unsaved', 'requestId'
])

/** 검색 대상 글 — 보낸 프롬프트·네거티브·캐릭터·씬 이름·시드·모델·저장 이름 */
export function searchText(meta: HistoryMeta): string {
  return [
    meta.prompt,
    meta.negative,
    ...(meta.sent?.chars ?? []).flatMap((c) => [c.name, c.prompt]),
    meta.sceneName ?? '',
    String(meta.seed),
    meta.model,
    meta.saved ?? ''
  ]
    .join('\n')
    .toLowerCase()
}

/** 검색어를 쉼표로 나눈 조각들 — 모두 들어 있어야 일치 (예: "blue eyes, beach") */
export function searchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/_/g, ' ')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

export function matchesSearch(text: string, terms: string[]): boolean {
  return terms.length > 0 && terms.every((t) => text.includes(t))
}

export function extOf(mime: string): string {
  return mime === 'image/webp' ? 'webp' : 'png'
}

/** 원본 파일 경로 규칙 — id와 MIME만으로 정해진다 (DB를 읽지 않고도 주소를 만들 수 있게) */
export function originalPath(id: number, mime: string): string {
  return `images/${id}.${extOf(mime)}`
}

export function thumbPathFor(id: number, mime: string): string {
  return `thumbs/${id}.${mime === 'image/webp' ? 'webp' : 'jpg'}`
}

function parseJson<T>(text: string | null): T | undefined {
  if (!text) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

/** HistoryMeta → 열 값 (file·bytes·thumb는 따로) */
function metaColumns(meta: HistoryMeta): SqlValue[] {
  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(meta)) if (!COLUMN_FIELDS.has(k) && v !== undefined) extra[k] = v
  return [
    meta.ts,
    meta.width,
    meta.height,
    meta.seed,
    meta.model,
    meta.kind,
    meta.prompt,
    meta.negative,
    meta.mime,
    meta.sceneId ?? null,
    meta.sceneName ?? null,
    meta.fav ? 1 : 0,
    meta.unsaved ? 1 : 0,
    meta.saved ?? null,
    meta.parentId ?? null,
    meta.requestId ?? null,
    meta.snap ? JSON.stringify(meta.snap) : null,
    meta.sent ? JSON.stringify(meta.sent) : null,
    Object.keys(extra).length ? JSON.stringify(extra) : null
  ]
}

const META_COLS =
  'ts, width, height, seed, model, kind, prompt, negative, mime, scene_id, scene_name, fav, unsaved, saved, parent_id, req_id, snap, sent, extra'
const META_SET = META_COLS.split(', ')
  .map((c) => `${c} = ?`)
  .join(', ')

export function insertStatements(meta: HistoryMeta, file: string | null, bytes: number, thumb: string | null): SqlStatement[] {
  return [
    {
      sql: `INSERT OR REPLACE INTO images (id, file, bytes, thumb, ${META_COLS}) VALUES (${marks(23)})`,
      params: [meta.id, file, bytes, thumb, ...metaColumns(meta)]
    },
    { sql: 'INSERT OR REPLACE INTO image_text (id, body) VALUES (?, ?)', params: [meta.id, searchText(meta)] }
  ]
}

/** 행 → HistoryMeta (thumb는 화면에 띄울 주소) */
export function rowToMeta(row: ImageRow, thumbUrl: string): HistoryMeta {
  const extra = parseJson<Record<string, unknown>>(row.extra) ?? {}
  const meta: HistoryMeta = {
    ...(extra as object),
    id: Number(row.id),
    ts: Number(row.ts),
    thumb: thumbUrl,
    width: Number(row.width),
    height: Number(row.height),
    seed: Number(row.seed),
    model: row.model,
    kind: row.kind as ImageKind,
    prompt: row.prompt,
    negative: row.negative,
    mime: row.mime
  }
  if (row.scene_id !== null) meta.sceneId = Number(row.scene_id)
  if (row.scene_name !== null) meta.sceneName = row.scene_name
  if (row.fav) meta.fav = 1
  const snap = parseJson<HistoryMeta['snap']>(row.snap)
  if (snap) meta.snap = snap
  const sent = parseJson<HistoryMeta['sent']>(row.sent)
  if (sent) meta.sent = sent
  if (row.saved !== null) meta.saved = row.saved
  if (row.parent_id !== null) meta.parentId = Number(row.parent_id)
  if (row.unsaved) meta.unsaved = 1
  if (row.req_id !== null) meta.requestId = row.req_id
  return meta
}

/** 조건 → WHERE 절. 검색이 있으면 좁은 image_text를 최신순으로 훑으며 images를 붙인다 */
function whereOf(q: HistoryQuery, beforeId?: number): { from: string; where: string; params: SqlValue[]; empty: boolean } {
  const conds: string[] = []
  const params: SqlValue[] = []
  let from = 'images i'
  if (q.search !== undefined) {
    const terms = searchTerms(q.search)
    if (!terms.length) return { from, where: '0', params, empty: true }
    from = 'image_text t JOIN images i ON i.id = t.id'
    // instr은 대소문자를 가리는 부분 문자열 찾기 — 글과 검색어를 모두 소문자로 둔다 (LIKE의 %·_ 문제도 없다)
    for (const term of terms) {
      conds.push('instr(t.body, ?) > 0')
      params.push(term)
    }
  }
  if (q.fav) conds.push('i.fav = 1')
  if (q.unsaved) conds.push('i.unsaved = 1')
  if (q.sceneId !== undefined) {
    conds.push('i.scene_id = ?')
    params.push(q.sceneId)
  }
  if (q.model !== undefined) {
    conds.push('i.model = ?')
    params.push(q.model)
  }
  if (q.kind !== undefined) {
    conds.push('i.kind = ?')
    params.push(q.kind)
  }
  if (q.parentId !== undefined) {
    conds.push('i.parent_id = ?')
    params.push(q.parentId)
  }
  if (q.from !== undefined) {
    conds.push('i.ts >= ?')
    params.push(q.from)
  }
  if (q.to !== undefined) {
    conds.push('i.ts <= ?')
    params.push(q.to)
  }
  if (beforeId !== undefined) {
    conds.push(q.search !== undefined ? 't.id < ?' : 'i.id < ?')
    params.push(beforeId)
  }
  return { from, where: conds.length ? conds.join(' AND ') : '1', params, empty: false }
}

export type HistoryRepo = ReturnType<typeof createHistoryRepo>

export function createHistoryRepo(driver: SqlDriver, files: FileStore) {
  const thumbUrl = async (row: ImageRow): Promise<string> => {
    if (!row.thumb) return ''
    return files.urlSync(row.thumb) ?? (await files.url(row.thumb))
  }
  const toMetas = (rows: ImageRow[]): Promise<HistoryMeta[]> =>
    Promise.all(rows.map(async (r) => rowToMeta(r, await thumbUrl(r))))

  const repo = {
    driver,
    files,

    /** 원본을 파일로 쓰고(크기 확인) 썸네일·행을 남긴다. 행을 못 남겨도 원본 파일은 지우지 않는다 */
    async add(meta: HistoryMeta, blob: Blob): Promise<void> {
      const file = originalPath(meta.id, meta.mime)
      const written = await files.write(file, blob)
      if (written !== blob.size) throw new Error(`원본 저장 크기가 다릅니다 (${written}/${blob.size})`)
      let thumb: string | null = null
      if (meta.thumb?.startsWith('data:')) {
        const path = thumbPathFor(meta.id, dataUrlMime(meta.thumb) ?? 'image/jpeg')
        // 썸네일은 다시 만들 수 있으므로 실패해도 진행한다
        thumb = await files.write(path, meta.thumb).then(
          () => path,
          () => null
        )
      }
      await driver.batch(insertStatements(meta, file, written, thumb))
    },

    /** 메타데이터만 고친다 (즐겨찾기·저장 표시 등). 파일 경로·썸네일은 그대로 */
    async put(meta: HistoryMeta): Promise<void> {
      await driver.batch([
        { sql: `UPDATE images SET ${META_SET} WHERE id = ?`, params: [...metaColumns(meta), meta.id] },
        { sql: 'INSERT OR REPLACE INTO image_text (id, body) VALUES (?, ?)', params: [meta.id, searchText(meta)] }
      ])
    },

    async get(id: number): Promise<HistoryMeta | null> {
      const rows = await driver.query<ImageRow>('SELECT * FROM images WHERE id = ?', [id])
      return rows.length ? (await toMetas(rows))[0] : null
    },

    async row(id: number): Promise<ImageRow | null> {
      return (await driver.query<ImageRow>('SELECT * FROM images WHERE id = ?', [id]))[0] ?? null
    },

    /** id 목록의 meta (순서 유지, 없는 것은 건너뜀) */
    async getMany(ids: number[]): Promise<HistoryMeta[]> {
      const byId = new Map<number, ImageRow>()
      for (const part of chunk(ids)) {
        const rows = await driver.query<ImageRow>(`SELECT * FROM images WHERE id IN (${marks(part.length)})`, part)
        for (const r of rows) byId.set(Number(r.id), r)
      }
      return toMetas(ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])))
    },

    /** 최신순 limit장. beforeId를 주면 그보다 오래된 것부터 (커서 페이지) */
    async list(q: HistoryQuery, limit: number, beforeId?: number): Promise<HistoryMeta[]> {
      const w = whereOf(q, beforeId)
      if (w.empty) return []
      const order = q.search !== undefined ? 't.id' : 'i.id'
      const rows = await driver.query<ImageRow>(
        `SELECT i.* FROM ${w.from} WHERE ${w.where} ORDER BY ${order} DESC LIMIT ?`,
        [...w.params, limit]
      )
      return toMetas(rows)
    },

    /** 조건에 맞는 id 전부 (최신순) */
    async ids(q: HistoryQuery): Promise<number[]> {
      const w = whereOf(q)
      if (w.empty) return []
      const order = q.search !== undefined ? 't.id' : 'i.id'
      const rows = await driver.query<{ id: number }>(`SELECT i.id AS id FROM ${w.from} WHERE ${w.where} ORDER BY ${order} DESC`, w.params)
      return rows.map((r) => Number(r.id))
    },

    async count(q: HistoryQuery = {}): Promise<number> {
      const w = whereOf(q)
      if (w.empty) return 0
      // 검색만 걸렸으면 images를 붙이지 않고 글만 센다
      const onlySearch = q.search !== undefined && Object.keys(q).filter((k) => q[k as keyof HistoryQuery] !== undefined).length === 1
      const sql = onlySearch
        ? `SELECT COUNT(*) AS n FROM image_text t WHERE ${w.where}`
        : `SELECT COUNT(*) AS n FROM ${w.from} WHERE ${w.where}`
      const [row] = await driver.query<{ n: number }>(sql, w.params)
      return Number(row?.n ?? 0)
    },

    /** 보관 한도 정리용: 즐겨찾기를 뺀 가장 오래된 n장의 id */
    async oldestIds(n: number): Promise<number[]> {
      const rows = await driver.query<{ id: number }>('SELECT id FROM images WHERE fav = 0 ORDER BY id ASC LIMIT ?', [n])
      return rows.map((r) => Number(r.id))
    },

    /** 행을 먼저 지우고 파일을 지운다 — 중간에 죽으면 파일만 남고(점검에서 찾는다), 행이 빈 파일을 가리키지 않는다 */
    async remove(ids: number[]): Promise<void> {
      const paths: string[] = []
      for (const part of chunk(ids)) {
        const rows = await driver.query<{ file: string | null; thumb: string | null }>(
          `SELECT file, thumb FROM images WHERE id IN (${marks(part.length)})`,
          part
        )
        for (const r of rows) {
          if (r.file) paths.push(r.file)
          if (r.thumb) paths.push(r.thumb)
        }
        await driver.batch([
          { sql: `DELETE FROM images WHERE id IN (${marks(part.length)})`, params: part },
          { sql: `DELETE FROM image_text WHERE id IN (${marks(part.length)})`, params: part }
        ])
      }
      for (const part of chunk(paths, 200)) await files.remove(part).catch(() => {})
    },

    async clear(): Promise<void> {
      await driver.batch([{ sql: 'DELETE FROM images' }, { sql: 'DELETE FROM image_text' }])
      for (const dir of ['images', 'thumbs']) {
        const names = (await files.list(dir)).map((f) => `${dir}/${f.name}`)
        for (const part of chunk(names, 200)) await files.remove(part).catch(() => {})
      }
    },

    async savedCount(): Promise<number> {
      const [row] = await driver.query<{ n: number }>('SELECT COUNT(*) AS n FROM images WHERE saved IS NOT NULL')
      return Number(row?.n ?? 0)
    },

    /** 원본 파일 (없으면 null) */
    async readOriginal(id: number, mime: string): Promise<Blob | null> {
      return files.read(originalPath(id, mime), mime)
    },

    async originalUrl(id: number, mime: string): Promise<string> {
      const path = originalPath(id, mime)
      return files.urlSync(path) ?? (await files.url(path))
    },

    /** 썸네일 경로를 기록하고 화면에 띄울 주소를 돌려준다 */
    async setThumb(id: number, path: string | null): Promise<string> {
      await driver.exec('UPDATE images SET thumb = ? WHERE id = ?', [path, id])
      return path ? (files.urlSync(path) ?? (await files.url(path))) : ''
    }
  }
  return repo
}
