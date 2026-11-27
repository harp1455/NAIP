/// <reference lib="webworker" />
/**
 * 이미지 변환 워커 — convert.ts의 convertImage를 그대로 돌린다 (OffscreenCanvas만 쓴다).
 * convertInWorker가 원본 바이트·옵션을 보내고, 결과 바이트와 정보(크기·품질·경고)를 받는다.
 */
import { convertImage, type ConvertOptions } from './convert'

onmessage = async (e: MessageEvent<{ id: number; bytes: ArrayBuffer; type: string; opts: ConvertOptions }>) => {
  const { id, bytes, type, opts } = e.data
  try {
    const result = await convertImage(new Blob([bytes], { type }), opts)
    const { blob, ...info } = result
    const out = await blob.arrayBuffer()
    postMessage({ id, bytes: out, type: blob.type, info }, [out])
  } catch (err) {
    postMessage({ id, error: String((err as Error)?.message ?? err) })
  }
}
