import * as db from './db'
import type { HistoryMeta } from './db'
import { copyImageToClipboard, copyText, fileNameFor, haptic, shareImages } from './native'
import { stripMetadata } from './strip'
import { useSettings } from '../stores/settings'
import { toast } from '../stores/toast'

/** 내보낼 이미지 — 설정에 따라 NAI 메타데이터(프롬프트 등)를 지운 사본 */
async function exportBlob(meta: HistoryMeta): Promise<Blob> {
  const blob = await db.getBlob(meta.id, meta.mime)
  if (!blob) throw new Error('원본을 찾을 수 없습니다')
  return useSettings.getState().shareStripMeta ? stripMetadata(blob) : blob
}

/** 이미지 한 장을 클립보드로 — 결과·히스토리에서 꾹 누르거나 복사 버튼을 눌렀을 때 */
export async function copyImage(meta: HistoryMeta, opts: { haptic?: boolean } = {}): Promise<void> {
  if (opts.haptic) haptic()
  try {
    await copyImageToClipboard(await exportBlob(meta))
    toast(
      useSettings.getState().shareStripMeta
        ? '클립보드에 복사했습니다 (메타데이터 지움)'
        : '클립보드에 복사했습니다 — 붙여 넣기로 보내세요'
    )
  } catch (e) {
    toast(`복사하지 못했습니다: ${(e as Error).message}`, true)
  }
}

/** 공유 창으로 보내기 (여러 장 가능) */
export async function shareHistoryImages(metas: HistoryMeta[]): Promise<void> {
  if (!metas.length) return
  try {
    const files = []
    for (const m of metas) files.push({ blob: await exportBlob(m), fileName: fileNameFor(m.id, m.seed, m.mime) })
    await shareImages(files)
  } catch (e) {
    // 사용자가 공유 창을 그냥 닫은 경우는 알리지 않는다
    const message = (e as Error).message ?? ''
    if (!/cancel|abort/i.test(message)) toast(`공유하지 못했습니다: ${message}`, true)
  }
}

/** 글자 복사 + 알림 */
export async function copyTextWithToast(text: string, what: string): Promise<void> {
  try {
    await copyText(text, what)
    toast(`${what} 복사했습니다`)
  } catch (e) {
    toast(`복사하지 못했습니다: ${(e as Error).message}`, true)
  }
}

/** 이미지의 생성 정보를 한 덩어리 글로 (메신저에 붙여 넣기 좋게) */
export function describeImage(meta: HistoryMeta): string {
  const params = (meta.snap?.params ?? {}) as { steps?: number; cfgScale?: number; sampler?: string }
  const lines = [`프롬프트: ${meta.prompt}`]
  if (meta.negative) lines.push(`네거티브: ${meta.negative}`)
  for (const [i, c] of (meta.sent?.chars ?? []).entries()) {
    lines.push(`캐릭터${i + 1}${c.name ? ` (${c.name})` : ''}: ${c.prompt}`)
    if (c.negative) lines.push(`캐릭터${i + 1} 네거티브: ${c.negative}`)
  }
  lines.push(
    [
      `시드 ${meta.seed}`,
      `${meta.width}×${meta.height}`,
      meta.model,
      params.steps !== undefined && `${params.steps}스텝`,
      params.cfgScale !== undefined && `CFG ${params.cfgScale}`,
      params.sampler
    ]
      .filter(Boolean)
      .join(' · ')
  )
  return lines.join('\n')
}
