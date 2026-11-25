import { stripMetadataOnMainThread } from './image'

/** 동시에 돌릴 워커 수 — 코어를 다 쓰면 화면이 버벅이므로 하나는 남긴다 */
export const STRIP_CONCURRENCY = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1))

interface Slot {
  worker: Worker
  busy: boolean
}

let slots: Slot[] | null = null
let broken = false
let nextId = 1
const waiting: (() => void)[] = []

function pool(): Slot[] | null {
  if (broken || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null
  if (!slots) {
    try {
      slots = Array.from({ length: STRIP_CONCURRENCY }, () => ({
        worker: new Worker(new URL('./strip.worker.ts', import.meta.url), { type: 'module' }),
        busy: false
      }))
    } catch {
      broken = true
      return null
    }
  }
  return slots
}

async function acquire(list: Slot[]): Promise<Slot> {
  for (;;) {
    const free = list.find((s) => !s.busy)
    if (free) {
      free.busy = true
      return free
    }
    await new Promise<void>((resolve) => waiting.push(resolve))
  }
}

function runInWorker(slot: Slot, blob: Blob, bytes: ArrayBuffer): Promise<Blob> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const done = (): void => {
      slot.worker.onmessage = null
      slot.worker.onerror = null
      slot.busy = false
      waiting.shift()?.()
    }
    slot.worker.onmessage = (e: MessageEvent<{ id: number; bytes?: ArrayBuffer; error?: string }>) => {
      if (e.data.id !== id) return
      done()
      if (e.data.bytes) resolve(new Blob([e.data.bytes], { type: 'image/png' }))
      else reject(new Error(e.data.error ?? 'worker failed'))
    }
    slot.worker.onerror = (e) => {
      done()
      reject(new Error(e.message || 'worker failed'))
    }
    slot.worker.postMessage({ id, bytes, type: blob.type || 'image/png' }, [bytes])
  })
}

/**
 * NAI 메타데이터(PNG 텍스트 청크 + 알파 채널 스텔스 정보)를 지운 PNG.
 * 워커 풀에서 처리해 여러 장을 동시에 돌릴 수 있고, 워커를 못 쓰는 환경이면 메인 스레드로 처리한다.
 */
export async function stripMetadata(blob: Blob): Promise<Blob> {
  const list = pool()
  if (!list) return stripMetadataOnMainThread(blob)
  const bytes = await blob.arrayBuffer()
  const slot = await acquire(list)
  try {
    return await runInWorker(slot, blob, bytes)
  } catch {
    // 워커 쪽 실패(오래된 웹뷰 등)는 메인 스레드 방식으로 한 번 더
    return stripMetadataOnMainThread(blob)
  }
}
