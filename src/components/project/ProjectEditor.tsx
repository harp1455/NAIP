/** 프로젝트 설정 — 기본, 캐릭터, 스타일, 생성 설정, 축, 제외 규칙, 덮어쓰기, 경고 기준 */
import { useState, type ReactNode } from 'react'
import { ArrowLeftRight, Download, Plus, UserPlus } from 'lucide-react'
import { MODELS, NOISE_SCHEDULES, SAMPLERS, UC_PRESET_OPTIONS } from '../../nai/constants'
import { generationDefaultsForModel, isMediumEffortModel, isV5Model, MEDIUM_EFFORT_FIXED, modelCapabilities } from '../../nai/models'
import { fitNaiGenerationResolution } from '../../nai/resolution'
import { isListedSize } from '../../nai/resolutionList'
import { cx } from '../../lib/util'
import {
  AXIS_KIND_LABEL,
  addCharacter,
  characterCode,
  useProjects,
  type AxisKind,
  type ComboOverride,
  type ExclusionRule,
  type PlanLimits,
  type Project,
  type ProjectParams
} from '../../project'
import { useCharacters } from '../../stores/characters'
import { usePrompt } from '../../stores/prompt'
import { toast } from '../../stores/toast'
import { ResolutionSelect, resolutionPrefs } from '../ResolutionSelect'
import { Button, Row, Section, Select, SliderRow, Stepper, TextInput, Toggle } from '../ui'
import { DraftArea, DraftInput, Field, NumberInput, patchLatest, Segmented } from './common'
import {
  AxisEditSheet,
  CharacterEditSheet,
  confirmKeyChange,
  describeMatch,
  ExclusionSheet,
  LibraryPickerSheet,
  ListRow,
  OverrideSheet,
  RefPicker
} from './EditorSheets'

const NEW_AXIS_KINDS: AxisKind[] = ['expression', 'outfit', 'situation', 'location', 'action', 'custom']

export function ProjectEditor(props: { project: Project }): ReactNode {
  const p = props.project
  const s = useProjects.getState()
  const library = useCharacters((x) => x.characters)
  const [charSheet, setCharSheet] = useState<string | null>(null)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [axisSheet, setAxisSheet] = useState<string | null>(null)
  const [newKind, setNewKind] = useState<AxisKind>('expression')
  const [exclusion, setExclusion] = useState<ExclusionRule | 'new' | null>(null)
  const [override, setOverride] = useState<ComboOverride | 'new' | null>(null)
  const patch = (x: Parameters<typeof s.patch>[1]): void => s.patch(p.id, x)

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-2 p-3">
        <Section title="기본">
          <div className="flex flex-col gap-2 pb-2">
            <div className="grid grid-cols-2 gap-2">
              <Field label="프로젝트 이름">
                <DraftInput label="프로젝트 이름" value={p.name} onCommit={(name) => name.trim() && patch({ name: name.trim() })} />
              </Field>
              <Field label="파일 이름용 (slug)">
                <DraftInput label="프로젝트 slug" value={p.slug ?? ''} placeholder={p.name} onCommit={(slug) => patch({ slug: slug.trim() || undefined })} />
              </Field>
            </div>
            <div className="rounded-lg border border-line bg-field px-3">
              <Row label="조합마다 생성 장수" hint="전체 생성 계획에서 한 조합을 몇 장">
                <Stepper label="조합마다 생성 장수" value={p.defaults.count} min={1} max={99} onChange={(count) => patch({ defaults: { ...p.defaults, count } })} />
              </Row>
              <Row label="채택 목표" hint="조합마다 채택할 장수">
                <Stepper label="채택 목표" value={p.defaults.target} min={1} max={20} onChange={(target) => patch({ defaults: { ...p.defaults, target } })} />
              </Row>
            </div>
          </div>
        </Section>

        <Section
          title={`캐릭터 ${p.characters.length}`}
          right={
            <>
              <Button variant="ghost" className="px-2 text-xs" onClick={() => setLibraryOpen(true)} disabled={!library.length}>
                <UserPlus size={14} />
                라이브러리
              </Button>
              <Button
                variant="ghost"
                className="px-2 text-xs"
                onClick={() => {
                  const c = { name: `캐릭터 ${p.characters.length + 1}` }
                  if (!confirmKeyChange(p, addCharacter(p, c).project, `"${c.name}"을(를) 더하면`, true)) return
                  const id = s.addCharacter(p.id, c)
                  if (id) setCharSheet(id)
                }}
              >
                <Plus size={14} />
                전용
              </Button>
            </>
          }
        >
          {p.characters.length === 0 ? (
            <p className="pb-2 text-xs text-dim">캐릭터가 없으면 캐릭터 축 없이 다른 축만으로 조합을 만듭니다</p>
          ) : (
            <ul className="flex flex-col gap-1.5 pb-2" aria-label="프로젝트 캐릭터">
              {p.characters.map((c, i) => {
                const lib = c.libraryId !== null ? library.find((x) => x.id === c.libraryId) : undefined
                return (
                  <ListRow
                    key={c.id}
                    dim={c.enabled === false}
                    leading={
                      <span className="flex h-7 min-w-7 shrink-0 items-center justify-center rounded-md bg-raised px-1 font-mono text-xs">{characterCode(p, c)}</span>
                    }
                    title={c.name}
                    sub={`${c.libraryId === null ? '프로젝트 전용' : lib ? `라이브러리: ${lib.name}` : '라이브러리에서 지워짐'}${c.prompt ? ` · + ${c.prompt}` : ''}${c.vibeIds.length + c.refIds.length ? ` · 레퍼런스 ${c.vibeIds.length + c.refIds.length}` : ''}`}
                    editLabel={`${c.name} 편집`}
                    onEdit={() => setCharSheet(c.id)}
                    onUp={i > 0 ? () => s.moveCharacter(p.id, c.id, -1) : undefined}
                    onDown={i < p.characters.length - 1 ? () => s.moveCharacter(p.id, c.id, 1) : undefined}
                  />
                )
              })}
            </ul>
          )}
        </Section>

        <Section title="공통 스타일 · 네거티브">
          <div className="flex flex-col gap-2 pb-2">
            <Field label="스타일·작가 프롬프트 (모든 조합의 메인 프롬프트)">
              <DraftArea label="스타일 프롬프트" value={p.stylePrompt} onCommit={(stylePrompt) => patch({ stylePrompt })} placeholder="artist:..., masterpiece, simple background" />
            </Field>
            <Segmented
              label="스타일 위치"
              value={p.stylePosition}
              onChange={(stylePosition) => patch({ stylePosition })}
              options={[
                { value: 'start', label: '조합 조각 앞' },
                { value: 'end', label: '조합 조각 뒤' }
              ]}
            />
            <Field label="공통 네거티브">
              <DraftArea label="공통 네거티브" rows={2} value={p.negative} onCommit={(negative) => patch({ negative })} />
            </Field>
            <Field label="모든 조합에 쓸 바이브·정밀 레퍼런스">
              <RefPicker vibeIds={p.vibeIds} refIds={p.refIds} onChange={(x) => patch(x)} />
            </Field>
          </div>
        </Section>

        <Section title="생성 설정">
          <ParamsEditor project={p} />
        </Section>

        <Section
          title={`축 ${p.axes.length}`}
          right={
            <>
              <Select
                label="새 축 종류"
                className="w-24"
                value={newKind}
                options={NEW_AXIS_KINDS.map((k) => ({ value: k, label: AXIS_KIND_LABEL[k] }))}
                onChange={setNewKind}
              />
              <Button
                variant="ghost"
                className="px-2 text-xs"
                onClick={() => {
                  const id = s.addAxis(p.id, newKind)
                  if (id) setAxisSheet(id)
                }}
              >
                <Plus size={14} />축 추가
              </Button>
            </>
          }
        >
          {p.axes.length === 0 ? (
            <p className="pb-2 text-xs text-dim">표정·의상·상황처럼 캐릭터와 곱할 축을 추가하세요</p>
          ) : (
            <ul className="flex flex-col gap-1.5 pb-2" aria-label="축">
              {p.axes.map((a, i) => {
                const on = a.values.filter((v) => v.enabled !== false).length
                return (
                  <ListRow
                    key={a.id}
                    title={
                      <>
                        {a.name} <span className="text-[11px] text-dim">({AXIS_KIND_LABEL[a.kind]} · {a.target === 'character' ? '캐릭터' : '메인'} 프롬프트)</span>
                      </>
                    }
                    sub={`값 ${on}${on !== a.values.length ? `/${a.values.length}` : ''}개 — ${a.values.map((v) => v.label).join(', ') || '없음'}`}
                    editLabel={`${a.name} 축 편집`}
                    onEdit={() => setAxisSheet(a.id)}
                    onUp={i > 0 ? () => s.moveAxis(p.id, a.id, -1) : undefined}
                    onDown={i < p.axes.length - 1 ? () => s.moveAxis(p.id, a.id, 1) : undefined}
                  />
                )
              })}
            </ul>
          )}
        </Section>

        <Section
          title={`제외 규칙 ${p.exclusions.length}`}
          defaultOpen={p.exclusions.length > 0}
          right={
            <Button variant="ghost" className="px-2 text-xs" onClick={() => setExclusion('new')}>
              <Plus size={14} />
              규칙 추가
            </Button>
          }
        >
          <ul className="flex flex-col gap-1.5 pb-2">
            {p.exclusions.map((r) => (
              <ListRow
                key={r.id}
                title={describeMatch(p, r.when)}
                sub={r.note}
                editLabel="제외 규칙 편집"
                onEdit={() => setExclusion(r)}
                deleteLabel="제외 규칙 삭제"
                onDelete={() => {
                  if (!window.confirm(`제외 규칙 "${describeMatch(p, r.when)}"을(를) 지울까요? 빠져 있던 조합이 행렬에 다시 들어옵니다.`)) return
                  patchLatest(p.id, (latest) => ({ exclusions: latest.exclusions.filter((x) => x.id !== r.id) }))
                }}
              />
            ))}
            {!p.exclusions.length && <p className="text-xs text-dim">예: 이 캐릭터는 수영복 조합을 만들지 않음</p>}
          </ul>
        </Section>

        <Section
          title={`조합별 덮어쓰기 ${p.overrides.length}`}
          defaultOpen={p.overrides.length > 0}
          right={
            <Button variant="ghost" className="px-2 text-xs" onClick={() => setOverride('new')}>
              <Plus size={14} />
              추가
            </Button>
          }
        >
          <ul className="flex flex-col gap-1.5 pb-2">
            {p.overrides.map((o) => (
              <ListRow
                key={o.id}
                title={describeMatch(p, o.match)}
                sub={[
                  o.prompt && `+ ${o.prompt}`,
                  o.characterPrompt && `캐릭터 + ${o.characterPrompt}`,
                  o.negative && `네거티브 + ${o.negative}`,
                  o.width && `${o.width}×${o.height}`,
                  o.count !== undefined && `${o.count}장`,
                  o.target !== undefined && `목표 ${o.target}`
                ]
                  .filter(Boolean)
                  .join(' · ')}
                editLabel="덮어쓰기 편집"
                onEdit={() => setOverride(o)}
                deleteLabel="덮어쓰기 삭제"
                onDelete={() => {
                  if (!window.confirm(`"${describeMatch(p, o.match)}" 덮어쓰기를 지울까요? 이 조합들의 프롬프트·해상도·장수·목표가 기본값으로 돌아갑니다.`)) return
                  patchLatest(p.id, (latest) => ({ overrides: latest.overrides.filter((x) => x.id !== o.id) }))
                }}
              />
            ))}
            {!p.overrides.length && <p className="text-xs text-dim">특정 조합만 프롬프트·해상도·장수·목표를 바꿉니다</p>}
          </ul>
        </Section>

        <Section title="경고 기준" defaultOpen={false}>
          <LimitsEditor project={p} />
        </Section>
      </div>
      {charSheet && <CharacterEditSheet project={p} charId={charSheet} onClose={() => setCharSheet(null)} />}
      {libraryOpen && <LibraryPickerSheet project={p} onClose={() => setLibraryOpen(false)} />}
      {axisSheet && <AxisEditSheet project={p} axisId={axisSheet} onClose={() => setAxisSheet(null)} />}
      {exclusion && <ExclusionSheet project={p} rule={exclusion === 'new' ? null : exclusion} onClose={() => setExclusion(null)} />}
      {override && <OverrideSheet project={p} override={override === 'new' ? null : override} onClose={() => setOverride(null)} />}
    </div>
  )
}

/** 생성 설정 — 프롬프트 화면의 설정 시트와 같은 칸, 프로젝트에 저장 */
function ParamsEditor(props: { project: Project }): ReactNode {
  const p = props.project
  const params = p.params
  const set = (x: Partial<ProjectParams>): void => useProjects.getState().patch(p.id, { params: { ...params, ...x } })
  const caps = modelCapabilities(params.model)
  const medium = isMediumEffortModel(params.model)
  const [custom, setCustom] = useState(() => !isListedSize(resolutionPrefs(), params.width, params.height))
  const [w, setW] = useState(String(params.width))
  const [h, setH] = useState(String(params.height))
  const commitSize = (): void => {
    const fit = fitNaiGenerationResolution(Number(w), Number(h), 'width')
    if (!fit) {
      setW(String(params.width))
      setH(String(params.height))
      return
    }
    set(fit)
    setW(String(fit.width))
    setH(String(fit.height))
  }
  return (
    <div className="flex flex-col pb-2">
      <Button
        variant="default"
        className="mb-1 self-start"
        onClick={() => {
          const screen = usePrompt.getState().params
          useProjects.getState().patch(p.id, { params: { ...screen } })
          setCustom(!isListedSize(resolutionPrefs(), screen.width, screen.height))
          setW(String(screen.width))
          setH(String(screen.height))
          toast('프롬프트 화면의 생성 설정을 가져왔습니다')
        }}
      >
        <Download size={15} />
        현재 설정 가져오기
      </Button>
      <div className="flex flex-col divide-y divide-line">
        <Row label="모델">
          <Select
            label="프로젝트 모델"
            className="w-44"
            value={params.model}
            options={MODELS}
            onChange={(model) => {
              const crossed = isV5Model(model) !== isV5Model(params.model)
              const d = generationDefaultsForModel(model)
              set({ model, ...(crossed ? { steps: d.steps, cfgScale: d.cfgScale, sampler: d.sampler } : {}) })
            }}
          />
        </Row>
        <div className="py-1.5">
          <div className="flex min-h-12 items-center gap-2">
            <span className="flex-1 text-sm">해상도</span>
            <ResolutionSelect
              className="w-52"
              width={params.width}
              height={params.height}
              custom={custom}
              onPick={(size) => {
                setCustom(false)
                set(size)
                setW(String(size.width))
                setH(String(size.height))
              }}
              onCustom={() => setCustom(true)}
            />
            <button
              type="button"
              aria-label="가로세로 바꾸기"
              className="flex h-11 w-9 shrink-0 items-center justify-center rounded-lg text-dim active:bg-raised"
              onClick={() => {
                set({ width: params.height, height: params.width })
                setW(String(params.height))
                setH(String(params.width))
              }}
            >
              <ArrowLeftRight size={16} />
            </button>
          </div>
          {custom && (
            <div className="flex items-center justify-end gap-1.5 pb-1 pt-1.5">
              <span className="mr-auto text-xs text-dim">64 배수로 맞춰집니다</span>
              <TextInput label="프로젝트 너비" inputMode="numeric" className="!w-[72px] text-center font-mono" value={w} onChange={setW} />
              <span className="text-dim">×</span>
              <TextInput label="프로젝트 높이" inputMode="numeric" className="!w-[72px] text-center font-mono" value={h} onChange={setH} />
              <button type="button" className="h-11 rounded-lg bg-raised px-3 text-sm" onClick={commitSize}>
                적용
              </button>
            </div>
          )}
        </div>
        <SliderRow label="스텝" value={medium ? MEDIUM_EFFORT_FIXED.steps : params.steps} min={1} max={50} step={1} disabled={medium} onChange={(steps) => set({ steps })} />
        <SliderRow label="프롬프트 가이던스 (CFG)" value={params.cfgScale} min={0} max={10} step={0.1} format={(v) => v.toFixed(1)} onChange={(cfgScale) => set({ cfgScale })} />
        <SliderRow
          label="가이던스 리스케일"
          value={params.cfgRescale}
          min={0}
          max={1}
          step={0.02}
          format={(v) => v.toFixed(2)}
          disabled={medium}
          onChange={(cfgRescale) => set({ cfgRescale })}
        />
        <Row label="샘플러">
          <Select label="프로젝트 샘플러" className="w-44" value={medium ? MEDIUM_EFFORT_FIXED.sampler : params.sampler} options={SAMPLERS} disabled={medium} onChange={(sampler) => set({ sampler })} />
        </Row>
        <Row label="노이즈 스케줄">
          <Select
            label="프로젝트 노이즈 스케줄"
            className="w-44"
            value={isV5Model(params.model) ? 'karras' : params.noiseSchedule}
            options={NOISE_SCHEDULES}
            disabled={!caps.noiseScheduleSelection}
            onChange={(noiseSchedule) => set({ noiseSchedule })}
          />
        </Row>
        <Row label="퀄리티 태그">
          <Toggle label="프로젝트 퀄리티 태그" checked={params.qualityToggle} onChange={(qualityToggle) => set({ qualityToggle })} />
        </Row>
        <Row label="UC 프리셋">
          <Select
            label="프로젝트 UC 프리셋"
            className="w-36"
            value={medium ? MEDIUM_EFFORT_FIXED.ucPreset : params.ucPreset}
            options={UC_PRESET_OPTIONS}
            disabled={medium}
            onChange={(ucPreset) => set({ ucPreset })}
          />
        </Row>
        <Row label="Variety+">
          <Toggle label="프로젝트 Variety+" checked={caps.variety && params.variety} disabled={!caps.variety} onChange={(variety) => set({ variety })} />
        </Row>
      </div>
      <p className={cx('mt-1 text-[11px] text-dim')}>시드는 장마다 무작위입니다. 프롬프트 화면의 프롬프트는 쓰지 않고, 위 스타일과 축 조각으로 만든 프롬프트를 보냅니다.</p>
    </div>
  )
}

function LimitsEditor(props: { project: Project }): ReactNode {
  const p = props.project
  const set = (x: Partial<PlanLimits>): void => useProjects.getState().patch(p.id, { limits: { ...p.limits, ...x } })
  const rows: { label: string; hint: string; key: keyof PlanLimits; scale?: number; max?: number }[] = [
    { label: '조합 수', hint: '넘으면 경고', key: 'combos' },
    { label: '생성 장수', hint: '한 번 계획에서', key: 'images' },
    { label: 'Anlas', hint: '예상 사용량', key: 'anlas' },
    { label: '예상 시간 (시간)', hint: '장당 시간은 지난 배치 기준', key: 'seconds', scale: 3600 },
    // 위로 열어 두면 행렬을 펼치다 웹뷰 메모리가 바닥날 수 있어 상한을 둔다 (기본 20,000의 5배)
    { label: '펼치지 않을 조합 수', hint: '이보다 많으면 화면이 멈추지 않게 펼치지 않음 (최대 100,000)', key: 'hardLimit', max: 100000 }
  ]
  return (
    <div className="flex flex-col divide-y divide-line pb-2">
      {rows.map((r) => (
        <Row key={r.key} label={r.label} hint={r.hint}>
          <NumberInput
            label={r.label}
            value={p.limits[r.key] / (r.scale ?? 1)}
            min={r.scale ? 0.1 : 1}
            max={r.max}
            onCommit={(v) => set({ [r.key]: Math.round(v * (r.scale ?? 1)) } as Partial<PlanLimits>)}
          />
        </Row>
      ))}
    </div>
  )
}
