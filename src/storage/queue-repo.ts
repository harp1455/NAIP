import { chunk, marks, type SqlDriver } from './driver'
import type { FileStore } from './files'

/** 대기열 한 장의 진행 상태. sending = 요청을 보냈고 결과를 아직 못 받음 (앱이 죽으면 "확인 필요") */
export type QueueItemState = 'sending' | 'done' | 'failed' | 'skipped'

export interface QueueItemRow {
  batch_id: number
  idx: number
  state: QueueItemState
  req_id: string
  image_id: number | null
  seed: number | null
  updated: number
}

export interface QueueBatchRow {
  id: number
  label: string
  /** 배치 JSON (파일을 못 읽었으면 null) */
  data: string | null
  created: number
}

export type QueueRepo = ReturnType<typeof createQueueRepo>

/** 배치마다 마지막으로 보낸 장의 뽑기 상태(JSON)를 두는 app_kv 열쇠 — 이어서 생성이 순차·배치에 한 번 뽑기를 이어 간다 */
const drawKey = (batchId: number): string => `queue-draw:${batchId}`

/** 생성 대기열 보관 — 배치 내용은 파일로 한 번, 장마다의 진행은 작은 행으로 */
export function createQueueRepo(driver: SqlDriver, files: FileStore) {
  const fileOf = (id: number): string => `queue/${id}.json`
  return {
    /** 배치 내용을 파일로 쓰고(임시 파일 → 이름 바꾸기) 나서 행을 넣는다 */
    async saveBatch(id: number, label: string, data: string): Promise<void> {
      const file = fileOf(id)
      await files.write(file, new Blob([data], { type: 'application/json' }))
      await driver.exec('INSERT OR REPLACE INTO queue_batches (id, label, file, created) VALUES (?, ?, ?, ?)', [
        id,
        label,
        file,
        Date.now()
      ])
    },

    async dropBatch(id: number): Promise<void> {
      await driver.batch([
        { sql: 'DELETE FROM queue_items WHERE batch_id = ?', params: [id] },
        { sql: 'DELETE FROM queue_batches WHERE id = ?', params: [id] },
        { sql: 'DELETE FROM app_kv WHERE key = ?', params: [drawKey(id)] }
      ])
      await files.remove([fileOf(id)]).catch(() => {})
    },

    async mark(
      batchId: number,
      idx: number,
      state: QueueItemState,
      reqId: string,
      /** draw: 이 장의 뽑기 상태 JSON (보낼 때만) — 진행 행과 한 번에 쓴다 */
      extra: { imageId?: number; seed?: number; draw?: string } = {}
    ): Promise<void> {
      const row = {
        sql: 'INSERT OR REPLACE INTO queue_items (batch_id, idx, state, req_id, image_id, seed, updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
        params: [batchId, idx, state, reqId, extra.imageId ?? null, extra.seed ?? null, Date.now()]
      }
      if (extra.draw === undefined) await driver.exec(row.sql, row.params)
      else
        await driver.batch([
          row,
          { sql: 'INSERT OR REPLACE INTO app_kv (key, value) VALUES (?, ?)', params: [drawKey(batchId), extra.draw] }
        ])
    },

    /** 행의 상태만 바꾼다 (예: 확인 필요 → 다시 요청하지 않음) */
    async setState(batchId: number, idxs: number[], state: QueueItemState): Promise<void> {
      if (!idxs.length) return
      await driver.batch(
        chunk(idxs).map((part) => ({
          sql: `UPDATE queue_items SET state = ?, updated = ? WHERE batch_id = ? AND idx IN (${marks(part.length)})`,
          params: [state, Date.now(), batchId, ...part]
        }))
      )
    },

    /** 배치 id → 마지막으로 보낸 장의 뽑기 상태 JSON */
    async draws(): Promise<Map<number, string>> {
      const rows = await driver.query<{ key: string; value: string }>("SELECT key, value FROM app_kv WHERE key LIKE 'queue-draw:%'")
      return new Map(rows.map((r) => [Number(r.key.slice('queue-draw:'.length)), r.value]))
    },

    async load(): Promise<{ batches: QueueBatchRow[]; items: QueueItemRow[] }> {
      const rows = await driver.query<{ id: number; label: string; file: string; created: number }>(
        'SELECT * FROM queue_batches ORDER BY id ASC'
      )
      const batches: QueueBatchRow[] = []
      for (const r of rows) {
        const blob = await files.read(r.file, 'application/json').catch(() => null)
        batches.push({ id: Number(r.id), label: r.label, created: Number(r.created), data: blob ? await blob.text() : null })
      }
      const items = await driver.query<QueueItemRow>('SELECT * FROM queue_items ORDER BY batch_id, idx')
      return {
        batches,
        items: items.map((r) => ({
          ...r,
          batch_id: Number(r.batch_id),
          idx: Number(r.idx),
          image_id: r.image_id === null ? null : Number(r.image_id),
          seed: r.seed === null ? null : Number(r.seed)
        }))
      }
    },

    /** 요청 id로 히스토리에 남은 이미지를 찾는다 (결과는 받았는데 "끝남" 표시 전에 앱이 죽은 경우) */
    async imagesByRequest(reqIds: string[]): Promise<Map<string, number>> {
      const out = new Map<string, number>()
      for (const part of chunk(reqIds)) {
        const rows = await driver.query<{ id: number; req_id: string }>(
          `SELECT id, req_id FROM images WHERE req_id IN (${marks(part.length)})`,
          part
        )
        for (const r of rows) out.set(r.req_id, Number(r.id))
      }
      return out
    }
  }
}
