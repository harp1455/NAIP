import type { HistoryMeta } from '../lib/db'
import { chunk, marks } from './driver'
import { insertStatements, originalPath, thumbPathFor, type ImageRow } from './history-repo'
import type { Storage } from './index'
import type { LegacySource } from './legacy'

/**
 * 저장 공간 점검 — 기록(행)과 파일이 서로 맞는지 본다. 아무것도 스스로 지우지 않고 보고만 한다.
 * 고치기는 사용자가 고른 것만: 남는 썸네일·임시 파일 지우기, 원본이 없는 기록 지우기,
 * 기록 없는 원본은 히스토리로 되살리거나(기본) 확인을 받고 지운다.
 */
export interface CheckReport {
  rows: number
  /** 기록이 없는 원본 파일 (images/…) */
  orphanOriginals: { path: string; size: number }[]
  /** 기록이 없는 썸네일 (thumbs/…) */
  orphanThumbs: string[]
  /** 쓰다 만 임시 파일·끝난 대기열 파일 */
  leftovers: string[]
  /** 원본 파일이 없는 기록 */
  missingOriginals: number[]
  /** 원본 파일 크기가 기록과 다른 기록 (지우지 않는다 — 보고만) */
  sizeMismatch: number[]
  /** 썸네일이 없는 기록 (화면에 보일 때 다시 만든다) */
  missingThumbs: number[]
}

export async function checkStorage(s: Pick<Storage, 'driver' | 'files'>): Promise<CheckReport> {
  const rows = await s.driver.query<Pick<ImageRow, 'id' | 'file' | 'bytes' | 'thumb'>>('SELECT id, file, bytes, thumb FROM images')
  const [images, thumbs, queue] = await Promise.all([s.files.list('images'), s.files.list('thumbs'), s.files.list('queue')])
  const imageSize = new Map(images.map((f) => [`images/${f.name}`, f.size]))
  const thumbSet = new Set(thumbs.map((f) => `thumbs/${f.name}`))
  const usedFiles = new Set<string>()
  const usedThumbs = new Set<string>()
  const report: CheckReport = {
    rows: rows.length,
    orphanOriginals: [],
    orphanThumbs: [],
    leftovers: [],
    missingOriginals: [],
    sizeMismatch: [],
    missingThumbs: []
  }
  for (const r of rows) {
    const id = Number(r.id)
    if (r.file) {
      usedFiles.add(r.file)
      const size = imageSize.get(r.file)
      if (size === undefined) report.missingOriginals.push(id)
      else if (size !== Number(r.bytes)) report.sizeMismatch.push(id)
    }
    if (r.thumb && thumbSet.has(r.thumb)) usedThumbs.add(r.thumb)
    else report.missingThumbs.push(id)
  }
  for (const f of images) {
    const path = `images/${f.name}`
    if (f.name.endsWith('.tmp')) report.leftovers.push(path)
    else if (!usedFiles.has(path)) report.orphanOriginals.push({ path, size: f.size })
  }
  for (const f of thumbs) {
    const path = `thumbs/${f.name}`
    if (f.name.endsWith('.tmp')) report.leftovers.push(path)
    else if (!usedThumbs.has(path)) report.orphanThumbs.push(path)
  }
  const batches = new Set(
    (await s.driver.query<{ file: string }>('SELECT file FROM queue_batches')).map((r) => r.file)
  )
  for (const f of queue) if (!batches.has(`queue/${f.name}`)) report.leftovers.push(`queue/${f.name}`)
  return report
}

/** 파일 지우기 (사용자가 고른 것만) */
export async function deleteStoredFiles(s: Pick<Storage, 'files'>, paths: string[]): Promise<void> {
  for (const part of chunk(paths, 200)) await s.files.remove(part)
}

/**
 * 쓰지 않는 썸네일·임시 파일 지우기 (점검 결과의 orphanThumbs·leftovers, 사용자가 고른 것만). 점검 결과는 화면에 남아 있는
 * 동안 낡을 수 있다 — 그 사이 복원 등으로 기록이 그 썸네일(또는 원본)을 가리키게 됐거나 대기열 배치가 그 파일을 쓰게
 * 됐으면 지우지 않는다. 기록만 복원한 그림은 원본이 없어 썸네일을 다시 만들 수 없다
 */
export async function deleteUnusedFiles(s: Pick<Storage, 'driver' | 'files'>, paths: string[]): Promise<{ deleted: number; skipped: number }> {
  const used = new Set<string>()
  for (const part of chunk(paths)) {
    const q = marks(part.length)
    for (const sql of [
      `SELECT thumb AS path FROM images WHERE thumb IN (${q})`,
      `SELECT file AS path FROM images WHERE file IN (${q})`,
      `SELECT file AS path FROM queue_batches WHERE file IN (${q})`
    ]) {
      for (const r of await s.driver.query<{ path: string }>(sql, part)) used.add(r.path)
    }
  }
  const gone = paths.filter((p) => !used.has(p))
  await deleteStoredFiles(s, gone)
  return { deleted: gone.length, skipped: paths.length - gone.length }
}

const ORIGINAL_RE = /^images\/(\d+)\.(png|webp)$/

/** 지금 기록이 있는 id → 그 기록의 원본 경로(원본 없는 기록이면 null)와 형식 */
async function rowsFor(s: Pick<Storage, 'driver'>, ids: number[]): Promise<Map<number, { file: string | null; mime: string }>> {
  const out = new Map<number, { file: string | null; mime: string }>()
  for (const part of chunk(ids)) {
    const rows = await s.driver.query<{ id: number; file: string | null; mime: string }>(
      `SELECT id, file, mime FROM images WHERE id IN (${marks(part.length)})`,
      part
    )
    for (const r of rows) out.set(Number(r.id), { file: r.file, mime: r.mime })
  }
  return out
}

/**
 * 기록 없는 원본 지우기 (사용자가 고른 것만). 점검 결과는 화면에 남아 있는 동안 낡을 수 있다 —
 * 그 사이 복원 등으로 그 원본을 가리키는 기록(또는 같은 id 의 원본 없는 기록)이 생겼으면 지우지 않는다
 */
export async function deleteOrphanOriginals(s: Pick<Storage, 'driver' | 'files'>, paths: string[]): Promise<{ deleted: number; skipped: number }> {
  const ids = paths.flatMap((p) => {
    const m = ORIGINAL_RE.exec(p)
    return m ? [Number(m[1])] : []
  })
  const rows = await rowsFor(s, ids)
  const used = new Set<string>()
  for (const part of chunk(paths)) {
    const found = await s.driver.query<{ file: string }>(`SELECT file FROM images WHERE file IN (${marks(part.length)})`, part)
    for (const r of found) used.add(r.file)
  }
  const gone = paths.filter((p) => {
    if (used.has(p)) return false
    const m = ORIGINAL_RE.exec(p)
    const row = m ? rows.get(Number(m[1])) : undefined
    if (!row) return true
    // 같은 id 의 다른 원본(확장자가 다른 예전 파일)을 가리키는 기록이면 이 파일은 정말 남는 것이다.
    // 원본 없는 기록(기록만 복원한 그림)이면 지우지 않는다 — 되살리기가 그 기록에 잇는다
    return row.file !== null && row.file !== p
  })
  await deleteStoredFiles(s, gone)
  return { deleted: gone.length, skipped: paths.length - gone.length }
}

/**
 * 원본이 없는 기록 중 지금도 원본이 없는 것만 (점검 결과가 낡았으면 — 복원으로 원본이 다시 생긴 기록은 뺀다).
 * 기록 지우기는 원본 파일도 함께 지우므로, 다시 생긴 원본까지 지우지 않게 한다
 */
export async function stillMissingOriginals(s: Pick<Storage, 'driver' | 'files'>, ids: number[]): Promise<number[]> {
  const rows = await rowsFor(s, ids)
  const withFile = ids.filter((id) => rows.get(id)?.file)
  const sizes = await s.files.sizes(withFile.map((id) => rows.get(id)!.file!))
  return withFile.filter((_, i) => sizes[i] < 0)
}

/**
 * 기록이 없는 원본을 히스토리로 되살린다. 그림 속 NAI 메타데이터로 프롬프트·시드를 채우고 썸네일을 만든다.
 * describe는 화면 쪽에서 넘긴다 (그림 읽기·메타데이터 해석은 브라우저 기능이 필요하다).
 *
 * 예전 히스토리(옮기기 전 IndexedDB)에 아직 남아 있는 장은 되살리지 않는다(waiting) — 옮기다 멈춘 장의 파일이다.
 * 여기서 빈약한 기록을 만들면 옮기기가 "이미 옮겼다"고 보고 즐겨찾기·저장·씬·계보·설정 사본을 옮기지 않은 채
 * 옛 데이터를 비우게 된다. 그런 장은 옮기기가 옛 기록 그대로 옮긴다.
 *
 * 같은 id 의 기록이 이미 있는 장은 새 기록을 만들지 않는다 — 점검한 뒤 복원 등으로 기록이 생겼으면
 * 그 기록(즐겨찾기·저장·설정 사본)을 그림에서 읽은 빈약한 기록으로 바꾸게 된다 (INSERT OR REPLACE).
 * 그 기록이 원본 없이 들어왔으면(기록만 복원) 이 원본을 그 기록에 잇고(recovered), 아니면 그대로 둔다(present).
 */
export async function recoverOrphans(
  s: Pick<Storage, 'driver' | 'files'>,
  orphans: { path: string; size: number }[],
  describe: (blob: Blob) => Promise<{ width: number; height: number; seed: number; model: string; prompt: string; negative: string; thumb: string }>,
  legacy: Pick<LegacySource, 'ids'>
): Promise<{ recovered: number; waiting: number; present: number }> {
  const pending = new Set(await legacy.ids())
  let recovered = 0
  let waiting = 0
  let present = 0
  for (const o of orphans) {
    const m = ORIGINAL_RE.exec(o.path)
    if (!m) continue
    const id = Number(m[1])
    if (pending.has(id)) {
      waiting++
      continue
    }
    const mime = m[2] === 'webp' ? 'image/webp' : 'image/png'
    const row = (await rowsFor(s, [id])).get(id)
    if (row) {
      const [size] = row.file === null && originalPath(id, row.mime) === o.path ? await s.files.sizes([o.path]) : [-1]
      if (size >= 0) {
        await s.driver.exec('UPDATE images SET file = ?, bytes = ? WHERE id = ? AND file IS NULL', [o.path, size, id])
        recovered++
      } else present++
      continue
    }
    const blob = await s.files.read(o.path, mime)
    if (!blob) continue
    try {
      const d = await describe(blob)
      const meta: HistoryMeta = {
        id,
        ts: id,
        thumb: d.thumb,
        width: d.width,
        height: d.height,
        seed: d.seed,
        model: d.model,
        kind: 't2i',
        prompt: d.prompt,
        negative: d.negative,
        mime,
        unsaved: 1
      }
      const thumbPath = thumbPathFor(id, 'image/jpeg')
      const thumb = await s.files.write(thumbPath, d.thumb).then(
        () => thumbPath,
        () => null
      )
      await s.driver.batch(insertStatements(meta, o.path, o.size, thumb))
      recovered++
    } catch {
      /* 읽을 수 없는 파일은 건너뛴다 (지우지 않는다) */
    }
  }
  return { recovered, waiting, present }
}
