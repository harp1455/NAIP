/**
 * 분류로 히스토리 그림을 조합에 배정할 때 히스토리 쪽 기록 — meta에는 분류 표시(project)만 더한다.
 *
 * - 살펴본 때의 meta를 통째로 다시 쓰지 않고 쓰기 직전에 다시 읽는다 (그 사이 바뀐 즐겨찾기·저장 표시를 되돌리면
 *   저장한 그림이 미저장으로 돌아가 갤러리에 또 저장된다)
 * - 열린 히스토리 목록(useHistory)의 사본에도 표시를 붙인다 — 그러지 않으면 즐겨찾기·저장 표시가 표시 없는 사본을
 *   다시 써서 분류 표시가 지워진다
 * 원본 그림은 건드리지 않는다.
 */
import * as db from '../lib/db'
import { useHistory } from '../stores/history'
import type { ProjectImageTag } from './types'

export async function tagHistoryImages(picks: readonly { id: number; tag: ProjectImageTag }[]): Promise<db.HistoryMeta[]> {
  const tagged: db.HistoryMeta[] = []
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
