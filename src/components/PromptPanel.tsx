import type { ReactNode } from 'react'
import { ChevronDown, Image as ImageIcon, Layers, ScanFace, Users } from 'lucide-react'
import { RESOLUTIONS } from '../nai/constants'
import { modelCapabilities, promptTokenLimit, isMediumEffortModel, MEDIUM_EFFORT_FIXED } from '../nai/models'
import { mergeQualityTags, mergeUcPresetForModel, removeComments } from '../nai/presets'
import { useTokenCount } from '../lib/tokens'
import { cx } from '../lib/util'
import { useCharacters } from '../stores/characters'
import { mergePromptParts, usePrompt } from '../stores/prompt'
import { useRefs } from '../stores/refs'
import { useSource } from '../stores/source'
import { Section, Select, Stepper, TextArea } from './ui'

export type SheetName = 'characters' | 'source' | 'vibes' | 'refs' | 'params' | 'presets'

function TokenBadge(props: { count: number | null; chars: number; limit: number }): ReactNode {
  if (props.count === null) return <span className="font-mono text-dim">{props.chars}자</span>
  return (
    <span
      className={cx('font-mono tabular-nums', props.count > props.limit ? 'text-danger' : 'text-dim')}
      title="토큰 수 / 한도"
    >
      {props.count}/{props.limit}
    </span>
  )
}

function ToolButton(props: {
  icon: ReactNode
  label: string
  badge?: number
  onClick: () => void
  disabled?: boolean
}): ReactNode {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cx(
        'flex h-11 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg text-[13px] active:bg-raised',
        props.disabled ? 'text-dim/50' : 'text-dim hover:text-fg'
      )}
    >
      {props.icon}
      {props.label}
      {!!props.badge && (
        <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">
          {props.badge}
        </span>
      )}
    </button>
  )
}

export function PromptPanel(props: { open: (s: SheetName) => void }): ReactNode {
  const p = usePrompt()
  const { cast, characters } = useCharacters()
  const refs = useRefs()
  const source = useSource()
  const caps = modelCapabilities(p.params.model)
  const limit = promptTokenLimit(p.params.model)
  const medium = isMediumEffortModel(p.params.model)

  const activeChars = cast
    .filter((e) => e.enabled)
    .map((e) => characters.find((c) => c.id === e.charId))
    .filter((c) => c !== undefined)
  const merged = mergeQualityTags(removeComments(mergePromptParts(p)), p.params.qualityToggle)
  const mergedUc = mergeUcPresetForModel(
    medium ? '' : removeComments(p.negative),
    medium ? MEDIUM_EFFORT_FIXED.ucPreset : p.params.ucPreset,
    p.params.model,
    merged
  )
  const posCount = useTokenCount(p.params.model, [merged, ...activeChars.map((c) => c.prompt)])
  const negCount = useTokenCount(p.params.model, [mergedUc, ...activeChars.map((c) => c.negative)])

  const preset = p.presets.find((x) => x.id === p.activePresetId)
  const resIndex = RESOLUTIONS.findIndex(
    (r) => r.width === p.params.width && r.height === p.params.height
  )
  const resOptions = [
    ...RESOLUTIONS.map((r, i) => ({ value: i, label: `${r.label} (${r.width}×${r.height})` })),
    ...(resIndex < 0
      ? [{ value: -1, label: `사용자 지정 (${p.params.width}×${p.params.height})` }]
      : [])
  ]

  return (
    <div className="flex flex-col gap-1 p-3">
      <button
        type="button"
        onClick={() => props.open('presets')}
        className="flex h-11 items-center gap-2 rounded-lg border border-line bg-field px-3 text-left"
      >
        <span className="min-w-0 flex-1 truncate font-semibold">{preset?.name ?? '프리셋 없음'}</span>
        <span className="shrink-0 text-xs text-dim">프롬프트 프리셋</span>
        <ChevronDown size={16} className="shrink-0 text-dim" />
      </button>

      <Section
        title="프롬프트"
        right={<TokenBadge count={posCount} chars={merged.length} limit={limit} />}
      >
        <div className="flex flex-col gap-1 pl-0.5">
          <Section title="고정">
            <TextArea
              label="고정 프롬프트"
              rows={6}
              value={p.base}
              onChange={(base) => p.set({ base })}
              placeholder="작가·화풍 등 매번 유지할 프롬프트"
            />
          </Section>
          <Section title="가변">
            <TextArea
              label="가변 프롬프트"
              rows={3}
              value={p.additional}
              onChange={(additional) => p.set({ additional })}
              placeholder="매번 지우고 바꿀 프롬프트"
            />
          </Section>
          <Section title="디테일">
            <TextArea
              label="디테일 프롬프트"
              rows={2}
              value={p.detail}
              onChange={(detail) => p.set({ detail })}
              placeholder="조명·품질 등 뒤에 붙일 프롬프트"
            />
          </Section>
        </div>
      </Section>

      <Section
        title="네거티브"
        right={<TokenBadge count={negCount} chars={mergedUc.length} limit={limit} />}
      >
        <TextArea
          label="네거티브 프롬프트"
          rows={3}
          value={p.negative}
          onChange={(negative) => p.set({ negative })}
          placeholder={medium ? 'V5 Medium은 네거티브를 보내지 않습니다' : '제외할 요소'}
        />
      </Section>

      <div className="mt-1 flex gap-1">
        <ToolButton
          icon={<Users size={16} />}
          label="캐릭터"
          badge={activeChars.length}
          onClick={() => props.open('characters')}
        />
        <ToolButton
          icon={<ImageIcon size={16} />}
          label={source.image ? (source.mask ? '인페인트' : 'i2i') : '이미지'}
          badge={source.image ? 1 : 0}
          onClick={() => props.open('source')}
        />
        <ToolButton
          icon={<Layers size={16} />}
          label="바이브"
          badge={caps.vibes ? refs.vibes.filter((v) => v.enabled).length : 0}
          disabled={!caps.vibes}
          onClick={() => props.open('vibes')}
        />
        <ToolButton
          icon={<ScanFace size={16} />}
          label="레퍼런스"
          badge={caps.characterReferences ? refs.charRefs.filter((r) => r.enabled).length : 0}
          disabled={!caps.characterReferences}
          onClick={() => props.open('refs')}
        />
      </div>

      <div className="mt-1 flex gap-2">
        <Select
          label="해상도"
          className="min-w-0 flex-1"
          value={resIndex}
          options={resOptions}
          onChange={(i) => {
            const r = RESOLUTIONS[i]
            if (r) p.patchParams({ width: r.width, height: r.height })
          }}
        />
        <div className="flex items-center gap-2">
          <span className="text-xs text-dim">스텝</span>
          <Stepper
            label="스텝"
            value={medium ? MEDIUM_EFFORT_FIXED.steps : p.params.steps}
            min={1}
            max={50}
            onChange={(steps) => p.patchParams({ steps })}
          />
        </div>
      </div>
    </div>
  )
}
