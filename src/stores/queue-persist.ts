import { getStorage } from '../storage'
import type { QueueBatchRow, QueueItemRow } from '../storage/queue-repo'
import { fragmentSourceFrom, type FragmentLibrary } from './fragments'
import type { Batch, DrawSnapshot, PlanItem } from './generation'
import { useScenes } from './scenes'
import { adoptCutoff, adoptTaggedImages, projectItemsQueued, releaseProjectItems } from '../project/queue' // ── Phase 5

/**
 * 생성 대기열을 앱이 죽어도 남게 한다.
 * - 배치는 누른 순간의 내용 그대로 JSON으로 저장한다 (조각 치환 함수 대신 조각 라이브러리 사본).
 *   Batch에 새 필드가 생겨도 JSON으로 옮겨지는 값이면 따로 손대지 않아도 함께 저장된다.
 * - 장마다 요청을 보내기 직전에 "보냄"(sending)을 먼저 기록하고, 히스토리에 넣은 뒤 "끝남"(done)으로 바꾼다.
 * - 다시 열었을 때 "보냄"으로 남은 장은 이미 과금됐을 수 있어 자동으로 다시 보내지 않는다 — "확인 필요"로 보여 주고
 *   사용자가 정한다. 그 요청 id로 히스토리에 그림이 있으면 끝난 것으로 본다.
 */

/** 요청마다 새로 만드는 고유 id */
export function newRequestId(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c?.randomUUID) return c.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

export function serializeBatch(batch: Batch): string {
  // fragments는 함수라 JSON에 담기지 않는다 — fragmentLib에서 다시 만든다
  const { fragments: _closure, ...rest } = batch
  void _closure
  return JSON.stringify(rest)
}

export function deserializeBatch(data: string): Batch {
  const raw = JSON.parse(data) as Omit<Batch, 'fragments'> & { fragmentLib?: FragmentLibrary }
  const lib = raw.fragmentLib ?? { folders: [], fragments: [] }
  return { ...raw, fragmentLib: lib, fragments: fragmentSourceFrom(lib) } as Batch
}

const warn = (e: unknown): void => console.warn('대기열 기록 실패', e)
/** 배치 내용을 쓰는 중인 것 — 그 배치의 첫 "보냄" 기록과 지우기(drop)는 이것이 끝난 뒤에 한다 */
const saving = new Map<number, Promise<void>>()
/**
 * 이 실행(앱 프로세스)이 저장해 아직 지우지 않은 배치 — 지금 돌거나 대기 중인 배치다.
 * 다시 열기(loadResume)가 늦게 돌아도 이 배치들을 "끝나지 않은 생성"으로 내놓거나 진행 기록을 지우지 않게 한다
 * (내놓으면 이어서 생성이 같은 장을 한 번 더 보낸다)
 */
const live = new Set<number>()
/**
 * ── Phase 5: 지난 실행에서 남아 이어서 할지 물었는데 아직 고르지 않은 배치 (시트를 X로 닫으면 다음 실행까지 남는다).
 * 그 프로젝트를 지우며 대기·생성 중인 장도 취소하면 여기서 찾아 버린다 (cancelSavedProject)
 */
const offered = new Map<number, ResumeEntry>()
/** 프로젝트 삭제로 버린 저장 배치 — 이미 읽어 둔 목록으로 "이어서 생성"을 눌러도 다시 보내지 않는다 */
const cancelledSaved = new Set<number>()
/** 버린 저장 배치를 지우는 중 — 다시 읽기(loadResume)는 이것이 끝난 뒤에 읽는다 */
const cancelling = new Set<Promise<void>>()

/** 대기열 기록 — 기록이 실패해도 생성은 멈추지 않는다 (sending만 기다린다) */
export const queueStore = {
  save(batch: Batch): Promise<void> {
    live.add(batch.id)
    const p = getStorage()
      .then((s) => s.queue.saveBatch(batch.id, batch.label, serializeBatch(batch)))
      .catch(warn)
      .finally(() => saving.delete(batch.id))
    saving.set(batch.id, p)
    return p
  },
  /**
   * 요청을 보내기 직전 — 이 기록이 디스크에 닿은 뒤에 보낸다.
   * 배치 내용(수 MB일 수 있다)을 다 쓰기 전이면 기다린다: 진행 기록만 있고 배치가 없으면 이어서 할 수 없다
   */
  async sending(batchId: number, key: number, reqId: string, seed: number, draw?: DrawRecord): Promise<void> {
    await saving.get(batchId)
    return getStorage()
      .then((s) => s.queue.mark(batchId, key, 'sending', reqId, { seed, ...(draw ? { draw: JSON.stringify(draw) } : {}) }))
      .catch(warn)
  },
  done(batchId: number, key: number, reqId: string, imageId: number): void {
    void getStorage()
      .then((s) => s.queue.mark(batchId, key, 'done', reqId, { imageId }))
      .catch(warn)
  },
  failed(batchId: number, key: number, reqId: string): void {
    void getStorage()
      .then((s) => s.queue.mark(batchId, key, 'failed', reqId))
      .catch(warn)
  },
  /** 지난 실행에서 저장된 배치를 이 실행에서 다시 돌린다 — 이제 이 실행의 배치로 본다 */
  resumed(batchId: number): void {
    live.add(batchId)
    offered.delete(batchId)
  },
  skip(batchId: number, keys: number[]): Promise<void> {
    return getStorage()
      .then((s) => s.queue.setState(batchId, keys, 'skipped'))
      .catch(warn)
  },
  /**
   * 배치 기록을 지운다. 아직 쓰는 중인 배치 내용(save)이 있으면 그것이 끝난 뒤에 지운다 —
   * 먼저 지우면 늦게 끝난 save가 행·파일을 다시 남겨, 취소한 배치가 다음 실행에서 "이어서 생성"으로 나온다
   */
  drop(batchId: number): Promise<void> {
    offered.delete(batchId)
    return (saving.get(batchId) ?? Promise.resolve())
      .then(() => getStorage())
      .then((s) => s.queue.dropBatch(batchId))
      .catch(warn)
      .finally(() => live.delete(batchId))
  }
}

/** 마지막으로 보낸 장(idx)의 뽑기 상태 — 그 장을 뽑기 전(before)과 뒤(after) */
export interface DrawRecord {
  idx: number
  before: DrawSnapshot
  after: DrawSnapshot
}

function parseDraw(text: string | undefined): DrawRecord | undefined {
  if (!text) return undefined
  try {
    const d = JSON.parse(text) as DrawRecord
    const ok = (x: DrawSnapshot | undefined): boolean => !!x && Array.isArray(x.counters) && Array.isArray(x.states)
    return Number.isFinite(d?.idx) && ok(d.before) && ok(d.after) ? d : undefined
  } catch {
    return undefined
  }
}

/**
 * 이어서 돌릴 계획의 첫 장에서 쓸 뽑기 상태. 마지막으로 보낸 장부터 다시 보내면(확인 필요 장) 그 장을 뽑기 전 상태,
 * 그 뒤 장부터면 뽑은 뒤 상태 — 순차 조각·순차 슬롯이 처음부터 다시 돌지 않고, 배치에 한 번 뽑은 캐릭터·변형도 그대로다
 */
export function resumeDrawFor(draw: DrawRecord | undefined, plan: readonly PlanItem[]): DrawSnapshot | undefined {
  if (!draw || !plan.length) return undefined
  const first = Math.min(...plan.map((p) => p.key ?? 0))
  return first <= draw.idx ? draw.before : draw.after
}

export interface UncertainItem {
  key: number
  reqId: string
  seed: number | null
  item: PlanItem
}

/** 다시 열었을 때 이어서 돌릴 수 있는 배치 하나 */
export interface ResumeEntry {
  /** 저장된 배치 (plan은 원래 전체, 각 칸에 key = 원래 위치) */
  batch: Batch
  total: number
  done: number
  failed: number
  /** 아직 보내지 않은 장 */
  remaining: PlanItem[]
  /** 보냈는데 결과를 모르는 장 — 이미 과금됐을 수 있다 */
  uncertain: UncertainItem[]
  /** 마지막으로 보낸 장의 뽑기 상태 (없으면 처음부터 뽑는다) */
  draw?: DrawRecord
}

/**
 * 저장된 배치·진행 행 → 이어서 할 목록.
 * found: 요청 id → 히스토리 이미지 id (결과를 받아 저장까지 했는데 "끝남" 기록 전에 죽은 장)
 */
export function planResume(
  batches: QueueBatchRow[],
  items: QueueItemRow[],
  found: Map<string, number>,
  draws: Map<number, string> = new Map()
): { entries: ResumeEntry[]; resolved: { batchId: number; idx: number; reqId: string; imageId: number }[]; dropped: number[] } {
  const entries: ResumeEntry[] = []
  const resolved: { batchId: number; idx: number; reqId: string; imageId: number }[] = []
  const dropped: number[] = []
  for (const row of batches) {
    let batch: Batch
    try {
      if (!row.data) throw new Error('no data')
      batch = deserializeBatch(row.data)
      if (!Array.isArray(batch.plan)) throw new Error('no plan')
    } catch {
      // 내용을 읽을 수 없는 배치는 이어서 할 수 없다
      dropped.push(row.id)
      continue
    }
    const plan = batch.plan.map((item, idx) => ({ ...item, key: item.key ?? idx }))
    const state = new Map(items.filter((i) => i.batch_id === row.id).map((i) => [i.idx, i]))
    let done = 0
    let failed = 0
    const remaining: PlanItem[] = []
    const uncertain: UncertainItem[] = []
    for (const item of plan) {
      const s = state.get(item.key)
      if (!s) remaining.push(item)
      else if (s.state === 'done') done++
      else if (s.state === 'sending') {
        const imageId = found.get(s.req_id)
        if (imageId !== undefined) {
          done++
          resolved.push({ batchId: row.id, idx: item.key, reqId: s.req_id, imageId })
        } else uncertain.push({ key: item.key, reqId: s.req_id, seed: s.seed, item })
      } else failed++ // failed·skipped: 다시 보내지 않는다 (앱이 살아 있을 때와 같은 규칙)
    }
    if (!remaining.length && !uncertain.length) {
      dropped.push(row.id)
      continue
    }
    const draw = parseDraw(draws.get(row.id))
    entries.push({ batch: { ...batch, plan }, total: plan.length, done, failed, remaining, uncertain, ...(draw ? { draw } : {}) })
  }
  return { entries, resolved, dropped }
}

/** 지난 실행에서 끝나지 않은 대기열 */
export async function loadResume(): Promise<ResumeEntry[]> {
  // 프로젝트 삭제로 버린 저장 배치를 다 지운 뒤에 읽는다 (지우기 전에 읽으면 버린 배치를 다시 내놓는다)
  await Promise.all(cancelling)
  offered.clear()
  // 읽기 전에 이 실행의 배치를 적어 둔다 — 읽는 사이에 지워진(drop) 배치도 지난 실행의 것으로 착각하지 않게
  const own = new Set(live)
  const { queue, history } = await getStorage()
  // ── Phase 5: 히스토리에는 분류 표시와 함께 들어갔는데 프로젝트 기록(localStorage — 늦게 디스크에 쓰인다)이
  // 저장되기 전에 앱이 죽어 빠진 그림을 다시 넣는다. 대기열 기록이 이미 끝났거나 지워진 장도 있어 대기열과 따로 찾는다.
  // 지금 도는 배치의 그림을 프로젝트 기록 직전에 먼저 넣어도 projectItemLanded가 그 장의 생성 중 장수를 돌려준다
  const cutoff = adoptCutoff()
  if (cutoff !== null) {
    try {
      adoptTaggedImages(await history.taggedSince(cutoff))
    } catch (e) {
      console.warn('프로젝트 그림을 맞추지 못했습니다', e)
    }
  }
  // 분류로 배정한 그림은 id가 오래돼 위에서 찾지 못한다 — 배정할 때 적어 둔 id로 찾는다. 이번에 넣은 그림이 있으면
  // 적은 것을 남긴다: 이번 기록도 디스크에 닿기 전에 죽을 수 있다. 넣을 것이 없는 실행(기록이 디스크에 있다)에서 지운다
  try {
    const notes = await history.assignedNotes()
    if (notes.length) {
      const added = new Set(adoptTaggedImages(await history.getMany([...new Set(notes.flatMap((n) => n.ids))])))
      const settled = notes.filter((n) => !n.ids.some((id) => added.has(id))).map((n) => n.key)
      if (settled.length) await history.dropAssignedNotes(settled)
    }
  } catch (e) {
    console.warn('분류한 그림을 맞추지 못했습니다', e)
  }
  const loaded = await queue.load()
  // 이 실행에서 저장한 배치(지금 돌거나 대기 중)는 지난 실행의 것이 아니다 — 내놓지도 지우지도 않는다
  const mine = (id: number): boolean => own.has(id) || live.has(id)
  const batches = loaded.batches.filter((b) => !mine(b.id))
  const items = loaded.items.filter((i) => !mine(i.batch_id))
  // 배치 없이 남은 진행 기록(배치를 쓰기 전에 꺼진 경우)은 이어서 할 수 없다
  const known = new Set(batches.map((b) => b.id))
  for (const id of new Set(items.filter((i) => !known.has(i.batch_id)).map((i) => i.batch_id))) await queue.dropBatch(id)
  if (!batches.length) return []
  const found = await queue.imagesByRequest(items.filter((i) => i.state === 'sending').map((i) => i.req_id))
  const draws = await queue.draws().catch(() => new Map<number, string>())
  const { entries, resolved, dropped } = planResume(batches, items, found, draws)
  for (const r of resolved) await queue.mark(r.batchId, r.idx, 'done', r.reqId, { imageId: r.imageId })
  // ── Phase 5: 히스토리에는 들어갔는데 프로젝트 기록 전에 죽은 장 — 분류 표시로 프로젝트에 넣는다
  if (resolved.length) adoptTaggedImages(await (await getStorage()).history.getMany(resolved.map((r) => r.imageId)))
  for (const id of dropped) await queue.dropBatch(id)
  // ── Phase 5: 보내지 않은 프로젝트 장은 저장된 대기열에 그대로 있다 — 앱을 열면 0이 된 대기 장수를 다시 센다.
  // 세지 않으면 "부족분만" 계획이 같은 장을 또 넣고, 나중에 이어서 생성하면 두 번 생성(과금)된다
  projectItemsQueued(entries.flatMap((e) => e.remaining))
  for (const e of entries) offered.set(e.batch.id, e)
  return entries
}

/**
 * ── Phase 5: 지난 실행에서 남은(이어서 할지 아직 고르지 않은) 배치 중 이 프로젝트의 것을 버린다 — 프로젝트를 지우며
 * 대기·생성 중인 장도 취소한 경우. 앱을 열 때 대기로 센 장을 돌려주고 저장된 배치를 지운다 (다음 실행에 다시 묻지 않게).
 * 프로젝트 배치에는 그 프로젝트의 장만 든다 (stores/generation.ts cancelProject와 같이 배치째 버린다). 버린 장수를 돌려준다
 */
export function cancelSavedProject(projectId: string): number {
  let n = 0
  for (const [id, e] of offered) {
    if (!e.batch.plan.some((item) => item.project?.tag.projectId === projectId)) continue
    offered.delete(id)
    cancelledSaved.add(id)
    n += e.remaining.length
    releaseProjectItems(e.remaining)
    const p = getStorage()
      .then((s) => s.queue.dropBatch(id))
      .catch(warn)
      .finally(() => cancelling.delete(p))
    cancelling.add(p)
  }
  return n
}

/** 프로젝트 삭제로 버린 저장 배치인지 */
export function savedBatchCancelled(batchId: number): boolean {
  return cancelledSaved.has(batchId)
}

/**
 * 이어서 하지 않고 버린다. 보내지 않은 씬 장은 씬 예약으로 돌려준다.
 * 확인 필요 장은 이미 그려졌을 수 있어 예약으로 돌려주지 않는다 (돌려주면 같은 장을 또 뽑게 될 수 있다).
 */
export async function discardResume(entries: ResumeEntry[]): Promise<void> {
  const { queue } = await getStorage()
  const scenes = new Set(useScenes.getState().scenes.map((s) => s.id))
  for (const e of entries) {
    offered.delete(e.batch.id)
    for (const item of e.remaining) {
      if (item.scene?.reserved && scenes.has(item.scene.id)) useScenes.getState().bumpReserve([item.scene.id], 1)
    }
    releaseProjectItems(e.remaining) // ── Phase 5: 읽을 때 대기로 센 프로젝트 장을 돌려준다
    await queue.dropBatch(e.batch.id)
  }
}
