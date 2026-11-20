import { useState, type ReactNode } from 'react'
import { Dices } from 'lucide-react'
import { MODELS, NOISE_SCHEDULES, SAMPLERS, UC_PRESET_OPTIONS } from '../nai/constants'
import { isMediumEffortModel, isV5Model, MEDIUM_EFFORT_FIXED, modelCapabilities } from '../nai/models'
import { fitNaiGenerationResolution } from '../nai/resolution'
import { usePrompt } from '../stores/prompt'
import { IconButton, Row, Select, Sheet, SliderRow, TextInput, Toggle } from './ui'

export function ParamsSheet(props: { onClose: () => void }): ReactNode {
  const p = usePrompt()
  const { params } = p
  const caps = modelCapabilities(params.model)
  const medium = isMediumEffortModel(params.model)
  const [w, setW] = useState(String(params.width))
  const [h, setH] = useState(String(params.height))

  const commitSize = (edited: 'width' | 'height'): void => {
    const fit = fitNaiGenerationResolution(Number(w), Number(h), edited)
    if (!fit) {
      setW(String(params.width))
      setH(String(params.height))
      return
    }
    p.patchParams(fit)
    setW(String(fit.width))
    setH(String(fit.height))
  }

  return (
    <Sheet title="생성 설정" onClose={props.onClose}>
      <div className="flex flex-col divide-y divide-line">
        <Row label="모델">
          <Select label="모델" className="w-48" value={params.model} options={MODELS} onChange={p.setModel} />
        </Row>
        <Row label="해상도" hint="64 배수로 맞춰집니다 (최대 약 3MP)">
          <div className="flex items-center gap-1.5">
            <TextInput
              label="너비"
              inputMode="numeric"
              className="!w-[72px] text-center font-mono"
              value={w}
              onChange={setW}
            />
            <span className="text-dim">×</span>
            <TextInput
              label="높이"
              inputMode="numeric"
              className="!w-[72px] text-center font-mono"
              value={h}
              onChange={setH}
            />
            <button
              type="button"
              className="h-11 rounded-lg bg-raised px-3 text-sm"
              onClick={() => commitSize('width')}
            >
              적용
            </button>
          </div>
        </Row>
        <SliderRow
          label="스텝"
          value={medium ? MEDIUM_EFFORT_FIXED.steps : params.steps}
          min={1}
          max={50}
          step={1}
          disabled={medium}
          onChange={(steps) => p.patchParams({ steps })}
        />
        <SliderRow
          label="프롬프트 가이던스 (CFG)"
          value={params.cfgScale}
          min={0}
          max={10}
          step={0.1}
          format={(v) => v.toFixed(1)}
          onChange={(cfgScale) => p.patchParams({ cfgScale })}
        />
        <SliderRow
          label="가이던스 리스케일"
          value={params.cfgRescale}
          min={0}
          max={1}
          step={0.02}
          format={(v) => v.toFixed(2)}
          disabled={medium}
          onChange={(cfgRescale) => p.patchParams({ cfgRescale })}
        />
        <Row label="샘플러">
          <Select
            label="샘플러"
            className="w-48"
            value={medium ? MEDIUM_EFFORT_FIXED.sampler : params.sampler}
            options={SAMPLERS}
            disabled={medium}
            onChange={(sampler) => p.patchParams({ sampler })}
          />
        </Row>
        <Row label="노이즈 스케줄">
          <Select
            label="노이즈 스케줄"
            className="w-48"
            value={isV5Model(params.model) ? 'karras' : params.noiseSchedule}
            options={NOISE_SCHEDULES}
            disabled={!caps.noiseScheduleSelection}
            onChange={(noiseSchedule) => p.patchParams({ noiseSchedule })}
          />
        </Row>
        <Row label="시드" hint="비워 두면 매 장 무작위, 입력하면 장마다 +1">
          <div className="flex items-center gap-1">
            <TextInput
              label="시드"
              inputMode="numeric"
              className="!w-36 font-mono"
              placeholder="무작위"
              value={p.seed}
              onChange={(v) => p.set({ seed: v.replace(/\D/g, '').slice(0, 10) })}
            />
            <IconButton label="시드 무작위로" onClick={() => p.set({ seed: '' })}>
              <Dices size={18} />
            </IconButton>
          </div>
        </Row>
        <Row label="퀄리티 태그" hint="프롬프트 뒤에 품질 태그를 자동으로 붙입니다">
          <Toggle
            label="퀄리티 태그"
            checked={params.qualityToggle}
            onChange={(qualityToggle) => p.patchParams({ qualityToggle })}
          />
        </Row>
        <Row label="UC 프리셋" hint="네거티브 앞에 붙는 기본 제외 태그">
          <Select
            label="UC 프리셋"
            className="w-40"
            value={medium ? MEDIUM_EFFORT_FIXED.ucPreset : params.ucPreset}
            options={UC_PRESET_OPTIONS}
            disabled={medium}
            onChange={(ucPreset) => p.patchParams({ ucPreset })}
          />
        </Row>
        <Row label="Variety+" hint="구도 다양성을 높입니다 (V4 계열)">
          <Toggle
            label="Variety+"
            checked={caps.variety && params.variety}
            disabled={!caps.variety}
            onChange={(variety) => p.patchParams({ variety })}
          />
        </Row>
      </div>
    </Sheet>
  )
}
