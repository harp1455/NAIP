import type { ReactNode } from 'react'
import { Copy, Pencil, Save, Trash2 } from 'lucide-react'
import { cx } from '../lib/util'
import { usePrompt } from '../stores/prompt'
import { Button, Empty, IconButton, Sheet } from './ui'

export function PresetSheet(props: { onClose: () => void }): ReactNode {
  const p = usePrompt()
  return (
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
                onClick={() => {
                  p.applyPreset(preset.id)
                  props.onClose()
                }}
              >
                <div className="truncate font-medium">{preset.name}</div>
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
    </Sheet>
  )
}
