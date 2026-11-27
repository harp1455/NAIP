/**
 * 지금 스토어 ↔ BackupData 어댑터 (참고 구현). 스토어 필드를 이름으로 고르지 않고 "함수가 아닌 상태"를
 * 통째로 담으므로, Phase 2 처럼 캐릭터 스토어에 필드가 늘어도 그대로 백업·복원된다.
 * 히스토리는 여기서 다루지 않는다 — Phase 3 저장소에 HistoryExportPort / HistoryImportPort 를 구현할 것.
 *
 * 주의: 바이브·레퍼런스·마스크 스토어는 IndexedDB 에서 비동기로 살아나므로, 모으기 전에
 * useRefs.getState().hydrated 를 확인한다.
 */
import { useCharacters } from '../stores/characters'
import { useFragments } from '../stores/fragments'
import { useMasks } from '../stores/masks'
import { usePrompt } from '../stores/prompt'
import { useRefs } from '../stores/refs'
import { useScenes } from '../stores/scenes'
import { useSettings } from '../stores/settings'
import { useTagUsage } from '../stores/tagUsage'
import { stripCredentials } from './credentials'
import { splitSettings } from './format'
import type { RestorePlan } from './plan'
import type { BackupData, BackupItem, DataSectionId } from './types'

/** 함수와 빼라는 키를 뺀 상태 */
function dataOf(state: object, omit: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(state)) {
    if (typeof v === 'function' || omit.includes(k)) continue
    out[k] = v
  }
  return out
}

export function collectStoreData(): BackupData {
  const { presets, ...prompt } = dataOf(usePrompt.getState())
  // 토큰은 백업 쓰기에서도 지우지만, 여기서부터 아예 넣지 않는다
  const { settings, saveFolders } = splitSettings(stripCredentials(dataOf(useSettings.getState())).value)
  const refs = useRefs.getState()
  return {
    settings,
    saveFolders,
    prompt,
    presets: { presets: (presets as BackupItem[]) ?? [] },
    characters: dataOf(useCharacters.getState()),
    scenes: dataOf(useScenes.getState()),
    fragments: dataOf(useFragments.getState()),
    vibes: { vibes: refs.vibes as unknown as BackupItem[] },
    charRefs: { charRefs: refs.charRefs as unknown as BackupItem[] },
    tagUsage: dataOf(useTagUsage.getState()) as BackupData['tagUsage'],
    masks: dataOf(useMasks.getState()) as BackupData['masks']
  }
}

/** 복원 계획의 섹션 결과를 스토어에 넣는다 (부분 setState — 결과에 없는 키는 그대로) */
export function applyRestorePlan(plan: RestorePlan): DataSectionId[] {
  const applied: DataSectionId[] = []
  for (const [id, section] of Object.entries(plan.sections) as [DataSectionId, NonNullable<RestorePlan['sections'][DataSectionId]>][]) {
    const r = section.result
    switch (id) {
      case 'settings':
      case 'saveFolders':
        // 토큰·비밀값은 백업에서 오지 않는다 (읽을 때 이미 지웠지만 한 번 더)
        useSettings.setState(stripCredentials(r).value as never)
        break
      case 'prompt':
        usePrompt.setState(r as never)
        break
      case 'presets':
        usePrompt.setState({ presets: r.presets as never })
        break
      case 'characters':
        useCharacters.setState(r as never)
        break
      case 'scenes':
        useScenes.setState(r as never)
        break
      case 'fragments':
        useFragments.setState(r as never)
        break
      case 'vibes':
        useRefs.setState({ vibes: r.vibes as never })
        break
      case 'charRefs':
        useRefs.setState({ charRefs: r.charRefs as never })
        break
      case 'tagUsage':
        useTagUsage.setState(r as never)
        break
      case 'masks':
        useMasks.setState(r as never)
        break
      default:
        // collections·exportTemplates·queue: 아직 스토어가 없다 (Phase 3·5 에서 연결)
        continue
    }
    applied.push(id)
  }
  return applied
}
