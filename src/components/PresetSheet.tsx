import { useState, type ReactNode } from 'react'
import { Copy, Pencil, Save, Trash2, Undo2 } from 'lucide-react'
import { cx } from '../lib/util'
import {
  autoSwitchChoice,
  hasUnsavedPrompt,
  PRESET_SWITCH_MODES,
  presetSwitchMode,
  usePrompt,
  usePromptUndo,
  type PresetSwitchChoice,
  type PromptPreset
} from '../stores/prompt'
import { announcePresetSwitch, PresetSwitchDialog, undoPromptWithToast } from './PresetSwitchDialog'
import { Button, Empty, IconButton, Select, Sheet } from './ui'

export function PresetSheet(props: { onClose: () => void }): ReactNode {
  const p = usePrompt()
  const undo = usePromptUndo((u) => u.snap)
  const [asking, setAsking] = useState<PromptPreset | null>(null)
  const unsaved = hasUnsavedPrompt(p)
  // 잡아 둔 이전 프롬프트가 어느 프리셋에도 없는 내용일 때만 줄을 보인다 (저장한 것이면 그 프리셋을 고르면 된다)
  const undoWorth =
    !!undo &&
    (hasUnsavedPrompt({ ...undo, presets: p.presets }) ||
      (!!undo.additional?.trim() && undo.additional !== p.additional))

  const switchTo = (target: PromptPreset, choice: PresetSwitchChoice): void => {
    const r = usePrompt.getState().switchPreset(target.id, choice)
    setAsking(null)
    props.onClose()
    announcePresetSwitch(r)
  }
  const pick = (target: PromptPreset): void => {
    const s = usePrompt.getState()
    if (!hasUnsavedPrompt(s)) return switchTo(target, 'discard')
    const auto = autoSwitchChoice(s)
    if (auto) return switchTo(target, auto)
    setAsking(target)
  }

  return (
    <>
      <Sheet
        title="프롬프트 프리셋"
        onClose={props.onClose}
        footer={
          <Button
            variant="primary"
            className="flex-1"
            onClick={() => {
              const name = window.prompt('프리셋 이름', '')
              if (name !== null) p.savePreset(name)
            }}
          >
            현재 프롬프트를 새 프리셋으로 저장
          </Button>
        }
      >
        <p className="mb-2 text-xs text-dim">
          고정·디테일·네거티브 프롬프트와 생성 설정을 함께 저장합니다. 가변 프롬프트는 저장하지 않습니다.
        </p>
        {undo && undoWorth && (
          <button
            type="button"
            onClick={() => {
              props.onClose()
              undoPromptWithToast()
            }}
            className="mb-2 flex w-full items-center gap-2.5 rounded-lg border border-dashed border-line px-3 py-2 text-left"
          >
            <Undo2 size={17} className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm">바뀌기 전 프롬프트로 되돌리기</span>
              <span className="block truncate font-mono text-xs text-dim">{undo.base || '(빈 프롬프트)'}</span>
            </span>
          </button>
        )}
        {p.presets.length === 0 && <Empty>저장된 프리셋이 없습니다</Empty>}
        <ul className="flex flex-col gap-1.5">
          {p.presets.map((preset) => {
            const active = preset.id === p.activePresetId
            return (
              <li
                key={preset.id}
                className={cx(
                  'flex items-center rounded-lg border bg-field',
                  active ? 'border-accent' : 'border-line'
                )}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 px-3 py-2.5 text-left"
                  onClick={() => pick(preset)}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{preset.name}</span>
                    {active && unsaved && <span className="shrink-0 text-[11px] text-accent">수정됨</span>}
                  </div>
                  <div className="truncate font-mono text-xs text-dim">{preset.base || '(빈 프롬프트)'}</div>
                </button>
                <IconButton
                  label="현재 내용으로 덮어쓰기"
                  onClick={() => {
                    if (window.confirm(`"${preset.name}" 프리셋을 현재 내용으로 덮어쓸까요?`))
                      p.overwritePreset(preset.id)
                  }}
                >
                  <Save size={17} />
                </IconButton>
                <IconButton label="복제" onClick={() => p.duplicatePreset(preset.id)}>
                  <Copy size={17} />
                </IconButton>
                <IconButton
                  label="이름 바꾸기"
                  onClick={() => {
                    const name = window.prompt('프리셋 이름', preset.name)
                    if (name !== null) p.renamePreset(preset.id, name)
                  }}
                >
                  <Pencil size={17} />
                </IconButton>
                <IconButton
                  label="삭제"
                  onClick={() => {
                    if (window.confirm(`"${preset.name}" 프리셋을 삭제할까요?`)) p.deletePreset(preset.id)
                  }}
                >
                  <Trash2 size={17} />
                </IconButton>
              </li>
            )
          })}
        </ul>
        <div className="mt-3 rounded-lg border border-line bg-field p-3">
          <div className="text-sm">프리셋을 옮길 때 저장하지 않은 내용</div>
          <div className="mt-0.5 text-xs text-dim">자동으로 저장해도 알림의 "되돌리기"로 옮기기 전으로 돌아갈 수 있습니다</div>
          <Select
            className="mt-2"
            label="프리셋을 옮길 때 저장하지 않은 내용"
            value={presetSwitchMode(p.presetSwitch)}
            options={PRESET_SWITCH_MODES}
            onChange={p.setPresetSwitch}
          />
        </div>
      </Sheet>
      {asking && (
        <PresetSwitchDialog
          target={asking}
          onChoose={(choice) => switchTo(asking, choice)}
          onCancel={() => setAsking(null)}
        />
      )}
    </>
  )
}
