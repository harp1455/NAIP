/**
 * 분류로 히스토리 그림을 조합에 배정할 때 히스토리 쪽 기록 — meta에는 분류 표시(project)만 더한다.
 *
 * - 살펴본 때의 meta를 통째로 다시 쓰지 않고 쓰기 직전에 다시 읽는다 (그 사이 바뀐 즐겨찾기·저장 표시를 되돌리면
 *   저장한 그림이 미저장으로 돌아가 갤러리에 또 저장된다)
 * - 열린 히스토리 목록(useHistory)의 사본에도 표시를 붙인다 — 그러지 않으면 즐겨찾기·저장 표시가 표시 없는 사본을
 *   다시 써서 분류 표시가 지워진다
 * - 표시를 쓰기 전에 배정할 그림 id를 적어 둔다 — 프로젝트 기록(localStorage)은 늦게 디스크에 쓰여, 그 전에 앱이 죽으면
 *   표시만 남는다. 다음 실행에서 적어 둔 그림을 프로젝트에 다시 넣는다 (stores/queue-persist.ts loadResume)
 * 원본 그림은 건드리지 않는다.
 */
import * as db from '../lib/db'
import { useHistory } from '../stores/history'
import type { ProjectImageTag } from './types'

export async function tagHistoryImages(picks: readonly { id: number; tag: ProjectImageTag }[]): Promise<db.HistoryMeta[]> {
  const tagged: db.HistoryMeta[] = []
  // 적지 못해도 배정은 한다 (그때는 앱이 곧바로 죽지 않는 한 그대로 들어간다)
  await db.noteAssigned(picks.map((p) => p.id)).catch((e: unknown) => console.warn('배정 기록 실패', e))
  for (const { id, tag } of picks) {
    const meta = await db.getMeta(id)
    if (!meta) continue
    const next = { ...meta, project: tag }
    await db.putMeta(next)
    tagged.push(next)
  }
  if (tagged.length) {
    const tags = new Map(tagged.map((m) => [m.id, m.project!]))
    useHistory.setState((s) => ({ items: s.items.map((m) => (tags.has(m.id) ? { ...m, project: tags.get(m.id) } : m)) }))
  }
  return tagged
}
