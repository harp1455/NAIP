import type { HistoryMeta } from '../lib/db'
import { chunk } from './driver'
import { insertStatements, thumbPathFor, type ImageRow } from './history-repo'
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
 * 기록이 없는 원본을 히스토리로 되살린다. 그림 속 NAI 메타데이터로 프롬프트·시드를 채우고 썸네일을 만든다.
 * describe는 화면 쪽에서 넘긴다 (그림 읽기·메타데이터 해석은 브라우저 기능이 필요하다).
 *
 * 예전 히스토리(옮기기 전 IndexedDB)에 아직 남아 있는 장은 되살리지 않는다(waiting) — 옮기다 멈춘 장의 파일이다.
 * 여기서 빈약한 기록을 만들면 옮기기가 "이미 옮겼다"고 보고 즐겨찾기·저장·씬·계보·설정 사본을 옮기지 않은 채
 * 옛 데이터를 비우게 된다. 그런 장은 옮기기가 옛 기록 그대로 옮긴다.
 */
export async function recoverOrphans(
  s: Pick<Storage, 'driver' | 'files'>,
  orphans: { path: string; size: number }[],
  describe: (blob: Blob) => Promise<{ width: number; height: number; seed: number; model: string; prompt: string; negative: string; thumb: string }>,
  legacy: Pick<LegacySource, 'ids'>
): Promise<{ recovered: number; waiting: number }> {
  const pending = new Set(await legacy.ids())
  let recovered = 0
  let waiting = 0
  for (const o of orphans) {
    const m = /^images\/(\d+)\.(png|webp)$/.exec(o.path)
    if (!m) continue
    const id = Number(m[1])
    if (pending.has(id)) {
      waiting++
      continue
    }
    const mime = m[2] === 'webp' ? 'image/webp' : 'image/png'
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
  return { recovered, waiting }
}
