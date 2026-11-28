import { useMemo, type ReactNode } from 'react'
import { ChevronDown, FileSearch, Image as ImageIcon, Layers, Puzzle, ScanFace, Users, Wand2 } from 'lucide-react'
import { modelCapabilities, promptTokenLimit, isMediumEffortModel, MEDIUM_EFFORT_FIXED } from '../nai/models'
import { mergeQualityTags, mergeUcPresetForModel, removeComments } from '../nai/presets'
import { fromMetadata } from '../lib/apply'
import { pickImageFiles } from '../lib/image'
import { readImageSettings } from '../lib/metadata'
import { useTokenCount } from '../lib/tokens'
import { referencesForModel } from '../nai/reference'
import { cx } from '../lib/util'
import { checkPeopleCount, createDrawState, resolveCast } from '../nai/cast'
import { useCharacters } from '../stores/characters'
import { useDirector } from '../stores/director'
import { useFragments } from '../stores/fragments'
import { useImporter } from '../stores/importer'
import { hasUnsavedPrompt, mergePromptParts, usePrompt } from '../stores/prompt'
import { useRefs } from '../stores/refs'
import { useSource } from '../stores/source'
import { ResolutionSelect } from './ResolutionSelect'
import { Section, Stepper, TextArea } from './ui'

export type SheetName = 'characters' | 'source' | 'vibes' | 'refs' | 'params' | 'presets' | 'fragments'

/** 쓴 토큰 수 / 모델의 토큰 한도 (V4·V4.5는 T5 512, V5 Full은 Qwen 1471, V5 Curated는 703) */
function TokenBadge(props: { count: number | null; limit: number }): ReactNode {
  return (
    <span
      className={cx(
        'font-mono tabular-nums',
        props.count !== null && props.count > props.limit ? 'text-danger' : 'text-dim'
      )}
      title="쓴 토큰 수 / 토큰 한도"
    >
      {props.count ?? '…'}/{props.limit}
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
  const { slots, characters, options, cursors } = useCharacters()
  const refs = useRefs()
  const source = useSource()
  const fragmentCount = useFragments((f) => f.fragments.length)
  const importSettings = (): void => {
    void pickImageFiles().then(async ([file]) => {
      if (!file) return
      const meta = await readImageSettings(file).catch(() => null)
      if (!meta) return window.alert('이 이미지에서 NovelAI 생성 정보를 찾지 못했습니다.\n(메신저·SNS를 거치면 정보가 지워집니다)')
      useImporter.getState().open(fromMetadata(meta), file.name.replace(/\.[^.]+$/, ''))
    })
  }
  const caps = modelCapabilities(p.params.model)
  const limit = promptTokenLimit(p.params.model)
  const medium = isMediumEffortModel(p.params.model)

  // 토큰 수·인원 확인용 예시 — 무작위 슬롯·변형은 첫 후보로 고정해 화면이 흔들리지 않게 한다
  // (배치에 한 번 순차는 다음 배치가 쓸 차례로)
  const castPreview = useMemo(
    () => resolveCast({ slots, options, characters }, createDrawState(cursors), () => 0, caps.maxCharacters),
    [slots, options, characters, cursors, caps.maxCharacters]
  )
  const activeChars = castPreview.chars
  const activeSlots = slots.filter((x) => x.enabled).length
  const countCheck = checkPeopleCount(mergePromptParts(p), activeChars.length)
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
  const edited = !!preset && hasUnsavedPrompt(p)
  return (
    <div className="flex flex-col gap-1 p-3">
      <button
        type="button"
        onClick={() => props.open('presets')}
        className="flex h-11 items-center gap-2 rounded-lg border border-line bg-field px-3 text-left"
      >
        <span className="min-w-0 truncate font-semibold">{preset?.name ?? '프리셋 없음'}</span>
        {edited && <span className="shrink-0 text-[11px] text-accent">수정됨</span>}
        <span className="ml-auto shrink-0 text-xs text-dim">프롬프트 프리셋</span>
        <ChevronDown size={16} className="shrink-0 text-dim" />
      </button>

      <Section
        title="프롬프트"
        persistKey="prompt"
        right={<TokenBadge count={posCount} limit={limit} />}
      >
        <div className="flex flex-col gap-1 pl-0.5">
          <Section title="고정" persistKey="prompt.base">
            <TextArea
              label="고정 프롬프트"
              rows={6}
              value={p.base}
              onChange={(base) => p.set({ base })}
              placeholder="작가·화풍 등 매번 유지할 프롬프트"
            />
          </Section>
          <Section title="가변" persistKey="prompt.additional">
            <TextArea
              label="가변 프롬프트"
              rows={3}
              value={p.additional}
              onChange={(additional) => p.set({ additional })}
              placeholder="매번 지우고 바꿀 프롬프트"
            />
          </Section>
          <Section title="디테일" persistKey="prompt.detail">
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
        persistKey="prompt.negative"
        right={<TokenBadge count={negCount} limit={limit} />}
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
          badge={activeSlots}
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
          badge={referencesForModel(refs.charRefs, p.params.model, !!(source.image && source.mask)).length}
          disabled={!caps.characterReferences}
          onClick={() => props.open('refs')}
        />
      </div>
      {countCheck?.conflict && (
        <button
          type="button"
          onClick={() => props.open('characters')}
          className={cx(
            'rounded-lg border px-3 py-1.5 text-left text-xs',
            options.autoCountTags ? 'border-line text-dim' : 'border-danger/50 text-danger'
          )}
        >
          인원 태그({countCheck.tags.join(', ')})와 출연 캐릭터 {countCheck.actual}명이 맞지 않습니다
          {options.autoCountTags ? ' — 보낼 때 자동으로 고칩니다' : ' — 캐릭터 화면에서 자동 고침을 켤 수 있습니다'}
        </button>
      )}

      <div className="flex gap-1">
        <ToolButton
          icon={<Puzzle size={16} />}
          label={fragmentCount ? `조각 ${fragmentCount}` : '조각'}
          onClick={() => props.open('fragments')}
        />
        <ToolButton icon={<Wand2 size={16} />} label="디렉터 툴" onClick={() => useDirector.getState().show()} />
        <ToolButton icon={<FileSearch size={16} />} label="설정 불러오기" onClick={importSettings} />
      </div>

      <div className="mt-1 flex gap-2">
        <ResolutionSelect
          className="min-w-0 flex-1"
          width={p.params.width}
          height={p.params.height}
          onPick={(size) => p.patchParams(size)}
          onCustom={() => props.open('params')}
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
