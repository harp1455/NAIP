/// <reference lib="webworker" />
/**
 * 메타데이터 제거 워커 — PNG 바이트를 받아 텍스트 청크와 알파 채널의 숨은 정보가 없는 PNG로 다시 만든다.
 * 메인 스레드의 canvas.toBlob 은 한가한 틈에만 인코딩해서 느리다. 워커에서는 바로 인코딩하고,
 * 여러 워커로 나눠 여러 장을 동시에 처리할 수 있다.
 */
onmessage = async (e: MessageEvent<{ id: number; bytes: ArrayBuffer; type: string }>) => {
  const { id, bytes, type } = e.data
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type }))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const d = data.data
    // image.ts 의 scrubAlpha 와 같은 규칙 (워커 번들을 작게 유지하려고 여기 따로 둔다)
    let opaque = true
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] < 254) {
        opaque = false
        break
      }
    }
    for (let i = 3; i < d.length; i += 4) {
      const a = d[i]
      d[i] = opaque || a >= 254 ? 255 : a <= 1 ? 0 : a | 1
    }
    ctx.putImageData(data, 0, 0)
    const out = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()
    postMessage({ id, bytes: out }, [out])
  } catch (err) {
    postMessage({ id, error: String((err as Error)?.message ?? err) })
  }
}
