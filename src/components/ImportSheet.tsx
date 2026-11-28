import { useState, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { MODELS, SAMPLERS, UC_PRESET_OPTIONS } from '../nai/constants'
import { applyImport, availableParts, type ImportPart } from '../lib/apply'
import { cx } from '../lib/util'
import { useImporter } from '../stores/importer'
import { hasUnsavedPrompt, usePrompt } from '../stores/prompt'
import { toastPromptReplaced } from './PresetSwitchDialog'
import { Button, Row, Select, Sheet, TextInput, Toggle } from './ui'

const PART_LABEL: Record<ImportPart, string> = {
  prompt: '프롬프트',
  negative: '네거티브',
  chars: '캐릭터',
  model: '모델',
  size: '해상도',
  sampling: '샘플링 설정',
  quality: '퀄리티 태그 · UC 프리셋',
  seed: '시드',
  vibes: '바이브 트랜스퍼'
}

/** 불러온 설정을 항목별로 골라 적용하고, 원하면 새 프리셋으로 저장한다 */
export function ImportSheet(): ReactNode {
  const { data, origin, close } = useImporter()
  const [checked, setChecked] = useState<Set<ImportPart>>(
    // 시드는 같은 그림을 다시 뽑게 되므로 기본으로는 빼 둔다
    // 바이브도 기본은 꺼 둔다 — 프롬프트만 가져올 때 지금 켜 둔 바이브가 바뀌지 않게
    () => new Set(data ? availableParts(data).filter((p) => p !== 'seed' && p !== 'vibes') : [])
  )
  const [asPreset, setAsPreset] = useState(true)
  const [name, setName] = useState(origin)
  const [vibeModel, setVibeModel] = useState('nai-diffusion-4-5-full')
  // 지금 화면의 프롬프트 중 프리셋에 없는 것 (가변은 프리셋에 저장하지 않는다)
  const unsaved = usePrompt((s) => hasUnsavedPrompt(s))
  const additional = usePrompt((s) => s.additional.trim() !== '')
  if (!data) return null

  const parts = availableParts(data)
  const p = data.params
  const preview: Record<ImportPart, string> = {
    prompt: [data.base, data.additional, data.detail].filter((x) => x.trim()).join(', '),
    negative: data.negative,
    chars: data.chars
      .filter((c) => c.prompt.trim())
      .map((c, i) => `${c.name || i + 1}: ${c.prompt}`)
      .join('\n'),
    model: MODELS.find((m) => m.value === p.model)?.label ?? p.model ?? '',
    size: `${p.width}×${p.height}`,
    sampling: [
      p.steps !== undefined && `스텝 ${p.steps}`,
      p.cfgScale !== undefined && `CFG ${p.cfgScale}`,
      p.cfgRescale !== undefined && `리스케일 ${p.cfgRescale}`,
      p.sampler && (SAMPLERS.find((s) => s.value === p.sampler)?.label ?? p.sampler),
      p.noiseSchedule,
      p.variety && 'Variety+'
    ]
      .filter(Boolean)
      .join(' · '),
    quality: [
      p.qualityToggle !== undefined && `퀄리티 태그 ${p.qualityToggle ? '켬' : '끔'}`,
      p.ucPreset !== undefined && `UC ${UC_PRESET_OPTIONS.find((o) => o.value === p.ucPreset)?.label ?? p.ucPreset}`
    ]
      .filter(Boolean)
      .join(' · '),
    seed: String(data.seed ?? ''),
    vibes: `${data.vibes?.length ?? 0}개 (강도 ${(data.vibes ?? []).map((v) => v.strength.toFixed(2)).join(', ')}) — 원본 그림 없이 그대로 다시 켭니다`
  }
  const toggle = (part: ImportPart): void => {
    const next = new Set(checked)
    if (next.has(part)) next.delete(part)
    else next.add(part)
    setChecked(next)
  }

  return (
    <Sheet
      title="설정 불러오기"
      onClose={close}
      actions={
        <button
          type="button"
          className="h-10 px-2 text-xs text-dim"
          onClick={() => setChecked(checked.size === parts.length ? new Set() : new Set(parts))}
        >
          {checked.size === parts.length ? '모두 해제' : '모두 선택'}
        </button>
      }
      footer={
        <>
          <Button onClick={close}>취소</Button>
          <Button
            variant="primary"
            className="flex-1"
            disabled={checked.size === 0}
            onClick={() => {
              const { undoable } = applyImport(data, checked, asPreset ? name : null, vibeModel)
              close()
              const saved = asPreset ? usePrompt.getState().presets.find((x) => x.id === usePrompt.getState().activePresetId) : null
              toastPromptReplaced(saved ? `「${saved.name}」 프리셋으로 불러왔습니다` : '설정을 불러왔습니다', undoable)
            }}
          >
            {asPreset ? `${checked.size}개 항목을 새 프리셋으로` : `${checked.size}개 항목 적용`}
          </Button>
        </>
      }
    >
      <p className="mb-2 text-xs text-dim">
        불러올 항목만 체크하세요. 체크하지 않은 항목은 지금 설정을 그대로 둡니다.
      </p>
      {((unsaved && (checked.has('prompt') || checked.has('negative'))) || (additional && checked.has('prompt'))) && (
        <p className="mb-2 rounded-lg border border-line bg-field px-3 py-2 text-xs text-dim">
          지금 적어 둔 프롬프트를 바꿉니다 (프리셋에 저장하지 않은 내용 포함). 적용한 뒤 알림의 "되돌리기"로 돌아갈 수 있습니다.
        </p>
      )}
      {parts.length === 0 && <p className="py-8 text-center text-sm text-dim">불러올 수 있는 항목이 없습니다</p>}
      <ul className="flex flex-col gap-1.5">
        {parts.map((part) => {
          const on = checked.has(part)
          return (
            <li key={part}>
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => toggle(part)}
                className={cx(
                  'flex w-full items-start gap-3 rounded-lg border bg-field px-3 py-2.5 text-left',
                  on ? 'border-accent' : 'border-line'
                )}
              >
                <span
                  className={cx(
                    'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border',
                    on ? 'border-accent bg-accent text-accent-fg' : 'border-dim'
                  )}
                >
                  {on && <Check size={14} strokeWidth={3} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">{PART_LABEL[part]}</span>
                  <span className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-all font-mono text-xs text-dim">
                    {preview[part]}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {checked.has('vibes') && (
        <div className="mt-2 rounded-lg border border-line bg-field p-3 text-xs text-dim">
          {data.vibeModel ? (
            <p>
              이 바이브는 {MODELS.find((m) => m.value === data.vibeModel)?.label ?? data.vibeModel} 전용 인코딩입니다. 다른
              모델에서는 쓸 수 없고, 지금 켜 둔 바이브는 꺼집니다.
            </p>
          ) : (
            <label className="flex flex-col gap-1.5">
              어느 모델로 만든 그림인지 이미지에서 알 수 없습니다. 만든 모델을 골라 주세요 (틀리면 결과가 이상해집니다).
              <Select
                label="바이브 모델"
                value={vibeModel}
                options={[
                  { value: 'nai-diffusion-4-5-full', label: 'V4.5 Full' },
                  { value: 'nai-diffusion-4-5-curated', label: 'V4.5 Curated' }
                ]}
                onChange={setVibeModel}
              />
            </label>
          )}
        </div>
      )}
      <div className="mt-3 rounded-lg border border-line bg-field px-3">
        <Row label="새 프리셋으로 저장" hint="끄면 지금 프리셋은 그대로 두고 화면의 설정만 바꿉니다">
          <Toggle label="새 프리셋으로 저장" checked={asPreset} onChange={setAsPreset} />
        </Row>
        {asPreset && (
          <div className="pb-3">
            <TextInput label="프리셋 이름" value={name} onChange={setName} placeholder="프리셋 이름" />
          </div>
        )}
      </div>
    </Sheet>
  )
}
