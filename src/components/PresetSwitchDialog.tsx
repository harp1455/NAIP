import { useState, type ReactNode } from 'react'
import { useBackClose } from '../lib/back'
import {
  autoPresetName,
  UNSAVED_PART_LABEL,
  undoPromptReplace,
  unsavedParts,
  usePrompt,
  usePromptUndo,
  type PresetSwitchChoice,
  type PresetSwitchResult,
  type PromptPreset
} from '../stores/prompt'
import { toast } from '../stores/toast'
import { Button, TextInput } from './ui'

/** 바뀌기 전 프롬프트로 되돌리고 알린다. 되돌리며 바뀐 내용도 저장하지 않은 것이면 다시 되돌릴 수 있다 */
export function undoPromptWithToast(): void {
  if (!undoPromptReplace()) return
  const again = !!usePromptUndo.getState().snap
  toast('이전 프롬프트로 되돌렸습니다', false, again ? { label: '되돌리기 취소', run: undoPromptWithToast } : undefined)
}

/** 프롬프트를 바꾼 뒤 알림 — 되돌릴 수 있으면 "되돌리기" 버튼을 붙인다 */
export function toastPromptReplaced(text: string, undoable: boolean): void {
  toast(text, false, undoable ? { label: '되돌리기', run: undoPromptWithToast } : undefined)
}

/** 프리셋을 옮긴 결과 알림 (저장하지 않은 내용이 없었으면 띄우지 않는다) */
export function announcePresetSwitch(r: PresetSwitchResult | null): void {
  if (!r || (!r.undoable && !r.savedTo)) return
  const text = r.savedTo
    ? r.savedAsNew
      ? `새 프리셋 「${r.savedTo}」에 저장했습니다`
      : `「${r.savedTo}」에 저장했습니다`
    : '저장하지 않고 옮겼습니다'
  toastPromptReplaced(text, r.undoable)
}

/** 저장하지 않은 내용이 있을 때 프리셋을 옮기기 전에 묻는 창 */
export function PresetSwitchDialog(props: {
  target: PromptPreset
  onChoose: (choice: PresetSwitchChoice) => void
  onCancel: () => void
}): ReactNode {
  useBackClose(props.onCancel)
  const s = usePrompt()
  const active = s.presets.find((x) => x.id === s.activePresetId)
  const parts = unsavedParts(s)
  const same = active?.id === props.target.id
  const [naming, setNaming] = useState<string | null>(null)
  const go = same ? '다시 불러오기' : '이동'

  return (
    <div
      className="sheet-overlay fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 sm:items-center"
      onClick={(e) => e.target === e.currentTarget && props.onCancel()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="preset-switch-title"
        className="sheet-in safe-bottom w-full max-w-md rounded-2xl border border-line bg-panel p-4"
      >
        <h2 id="preset-switch-title" className="text-base font-semibold">
          저장하지 않은 내용이 있습니다
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed">
          {active ? `「${active.name}」에서 고친 내용이 저장되지 않았습니다.` : '지금 적은 프롬프트가 프리셋에 저장되지 않았습니다.'}{' '}
          {same
            ? `「${props.target.name}」 프리셋을 다시 불러오면 고친 내용은 사라집니다.`
            : `「${props.target.name}」 프리셋으로 옮기면 지금 내용은 바뀝니다.`}
        </p>
        <p className="mt-1 text-xs text-dim">
          {active ? '고친 칸' : '적은 칸'}: {parts.map((k) => UNSAVED_PART_LABEL[k]).join(' · ')} — 가변 프롬프트는 그대로 둡니다
        </p>

        {naming === null ? (
          <div className="mt-4 flex flex-col gap-2">
            {active && (
              <Button variant="primary" onClick={() => props.onChoose('saveActive')}>
                <span className="truncate">「{active.name}」에 저장{same ? '' : '하고 이동'}</span>
              </Button>
            )}
            <Button
              variant={active ? 'default' : 'primary'}
              onClick={() => setNaming(autoPresetName(new Date(), s.presets.map((x) => x.name)))}
            >
              새 프리셋으로 저장하고 {go}
            </Button>
            <Button variant="danger" onClick={() => props.onChoose('discard')}>
              저장하지 않고 {go}
            </Button>
            <Button variant="ghost" onClick={props.onCancel}>
              취소
            </Button>
          </div>
        ) : (
          <div className="mt-4">
            <div className="mb-1.5 text-xs text-dim">새 프리셋 이름</div>
            <TextInput label="새 프리셋 이름" value={naming} onChange={setNaming} placeholder="새 프리셋" />
            <div className="mt-3 flex gap-2">
              <Button onClick={() => setNaming(null)}>뒤로</Button>
              <Button variant="primary" className="flex-1" onClick={() => props.onChoose({ saveNew: naming })}>
                저장하고 {go}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
