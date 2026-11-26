import { useEffect, useState } from 'react'
import { processWildcards } from '../nai/fragments'
import { isV5Model } from '../nai/models'
import { removeComments } from '../nai/presets'
import { countTokens, loadTokenizer } from '../nai/tokenizer'
import { fragmentSource } from '../stores/fragments'

/** 한동안 안 쓰면 Qwen 워커를 내려 사전 메모리를 돌려준다 */
const QWEN_IDLE_MS = 5 * 60 * 1000

let qwen: Worker | null = null
let qwenIdle: ReturnType<typeof setTimeout> | undefined
let nextId = 1
const pending = new Map<number, { resolve: (counts: number[]) => void; reject: (e: Error) => void }>()

function qwenWorker(): Worker {
  if (qwen) return qwen
  const worker = new Worker(new URL('./qwen.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<{ id: number; counts?: number[]; error?: string }>) => {
    const request = pending.get(e.data.id)
    if (!request) return
    pending.delete(e.data.id)
    if (e.data.counts) request.resolve(e.data.counts)
    else request.reject(new Error(e.data.error ?? 'tokenizer failed'))
  }
  worker.onerror = (e) => {
    for (const request of pending.values()) request.reject(new Error(e.message || 'tokenizer failed'))
    pending.clear()
    if (qwen === worker) qwen = null
  }
  qwen = worker
  return worker
}

/** V5(Qwen) 토큰 수 — 텍스트마다 따로 센 값 */
function countQwen(texts: string[]): Promise<number[]> {
  clearTimeout(qwenIdle)
  qwenIdle = setTimeout(() => {
    if (pending.size > 0) return
    qwen?.terminate()
    qwen = null
  }, QWEN_IDLE_MS)
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    // 워커 스크립트는 assets/ 아래에 있어서 사전 위치는 페이지 기준 주소로 넘긴다
    qwenWorker().postMessage({ id, base: new URL('./qwen35/', document.baseURI).href, texts })
  })
}

/**
 * 실제로 보낼 내용 기준의 합산 토큰 수 — 주석 줄은 빼고 조각(<이름>)은 첫 줄로 치환해서 센다
 * (NAIS3와 같은 규칙. 순차 조각의 카운터는 건드리지 않는다).
 * V4/V4.5는 T5, V5는 Qwen 토크나이저. 아직 계산 전이거나 실패하면 null.
 */
export function useTokenCount(model: string, texts: string[]): number | null {
  const [count, setCount] = useState<number | null>(null)
  const key = texts.join('\u0000')
  useEffect(() => {
    let live = true
    const t = setTimeout(() => {
      const source = fragmentSource()
      const parts = key
        .split('\u0000')
        .map((s) => processWildcards(removeComments(s), source, () => 0, true))
        .filter((s) => s.trim())
      const done = (n: number | null): void => {
        if (live) setCount(n)
      }
      if (parts.length === 0) return done(0)
      if (isV5Model(model)) {
        void countQwen(parts)
          .then((counts) => done(counts.reduce((a, b) => a + b, 0)))
          .catch(() => done(null))
        return
      }
      void loadTokenizer()
        // T5는 텍스트마다 EOS(1)가 붙는데, 전체에서 한 번만 센다
        .then((v) => done(parts.reduce((n, s) => n + countTokens(s, v) - 1, 1)))
        .catch(() => done(null))
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [model, key])
  return count
}
