import { useMemo, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, ListPlus, Plus, RefreshCw, Trash2 } from 'lucide-react'
import {
  createDrawState,
  DEFAULT_CAST_OPTIONS,
  fixedSlots,
  resolveCast,
  VARIATION_KINDS,
  VARIATION_MODES,
  variationGroupLabel,
  type VariationGroup,
  type VariationItem,
  type VariationKind
} from '../nai/cast'
import { cx, uid } from '../lib/util'
import { useCharacters, type Character } from '../stores/characters'
import { Segmented } from './SlotEditor'
import { Button, IconButton, Row, Select, Sheet, Stepper, TextArea, TextInput, Toggle } from './ui'

const MODE_HINT: Record<VariationGroup['mode'], string> = {
  fixed: '고른 항목 하나를 매번 씁니다',
  random: '비중에 따라 장마다 하나를 뽑습니다',
  sequential: '위에서부터 차례로 하나씩 씁니다',
  off: '이 그룹은 넣지 않습니다'
}

/** 이름이 아니라 프롬프트 문법인 접두어 (artist:이름, text: 글자, 단부루 분류 접두어) — 줄을 프롬프트 그대로 둔다 */
const PROMPT_PREFIXES = new Set(['artist', 'text', 'character', 'copyright', 'general', 'meta', 'rating'])

/** "이름: 프롬프트" 또는 프롬프트만 — 한 줄에 항목 하나 */
export function parseItemLines(text: string): VariationItem[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((line) => {
      // "교복: school uniform" — 콜론 앞이 짧은 이름일 때만 이름으로 본다 (가중치 문법 1.2::…:: 과 artist: 같은 접두어는 제외)
      const found = /^([^:,{}[\]<>]{1,24}):(?!:)\s*(.+)$/.exec(line)
      const m = found && !PROMPT_PREFIXES.has(found[1].trim().toLowerCase()) ? found : null
      return m
        ? { id: uid(), label: m[1].trim(), prompt: m[2].trim(), weight: 1 }
        : { id: uid(), label: '', prompt: line, weight: 1 }
    })
}

function ItemRow(props: {
  item: VariationItem
  group: VariationGroup
  index: number
  count: number
  totalWeight: number
  open: boolean
  onToggle: () => void
  onChange: (p: Partial<VariationItem>) => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
  onPickFixed: () => void
}): ReactNode {
  const { item, group } = props
  const fixedOn = group.mode === 'fixed' && (group.fixedId ?? group.items[0]?.id) === item.id
  const share = props.totalWeight > 0 ? Math.round((Math.max(0, item.weight) / props.totalWeight) * 100) : 0
  const title = item.label.trim() || item.prompt.trim() || '(빈 항목 — 아무것도 넣지 않음)'
  return (
    <li className={cx('rounded-md border bg-panel', fixedOn ? 'border-accent' : 'border-line')}>
      <div className="flex items-center gap-1 pl-1 pr-1">
        {group.mode === 'fixed' && (
          <button
            type="button"
            role="radio"
            aria-checked={fixedOn}
            aria-label={`${title} 고정`}
            onClick={props.onPickFixed}
            className="flex h-10 w-9 shrink-0 items-center justify-center"
          >
            <span
              className={cx(
                'h-4 w-4 rounded-full border-2',
                fixedOn ? 'border-accent bg-accent' : 'border-dim'
              )}
            />
          </button>
        )}
        <button
          type="button"
          aria-expanded={props.open}
          onClick={props.onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-1.5 text-left"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{title}</span>
            {item.label.trim() && item.prompt.trim() && (
              <span className="block truncate font-mono text-[11px] text-dim">{item.prompt}</span>
            )}
          </span>
          {group.mode === 'random' && (
            <span className="shrink-0 font-mono text-[11px] text-dim">
              {item.weight > 0 ? `${share}%` : '안 뽑음'}
            </span>
          )}
          {props.open ? <ChevronUp size={15} className="shrink-0 text-dim" /> : <ChevronDown size={15} className="shrink-0 text-dim" />}
        </button>
      </div>
      {props.open && (
        <div className="flex flex-col gap-2 border-t border-line p-2">
          <TextInput label="항목 이름" value={item.label} onChange={(label) => props.onChange({ label })} placeholder="예: 교복" />
          <TextArea
            label="항목 프롬프트"
            rows={2}
            value={item.prompt}
            onChange={(prompt) => props.onChange({ prompt })}
            placeholder="school uniform, ... (조각 <이름> 사용 가능)"
          />
          <div className="flex items-center gap-1">
            {group.mode === 'random' && (
              <>
                <span className="text-xs text-dim">비중</span>
                <Stepper label={`${title} 비중`} value={item.weight} min={0} max={99} onChange={(weight) => props.onChange({ weight })} />
              </>
            )}
            <span className="flex-1" />
            <IconButton label="위로" disabled={props.index === 0} onClick={() => props.onMove(-1)}>
              <ArrowUp size={16} />
            </IconButton>
            <IconButton label="아래로" disabled={props.index === props.count - 1} onClick={() => props.onMove(1)}>
              <ArrowDown size={16} />
            </IconButton>
            <IconButton label="항목 삭제" onClick={props.onRemove}>
              <Trash2 size={16} />
            </IconButton>
          </div>
        </div>
      )}
    </li>
  )
}

function GroupCard(props: {
  group: VariationGroup
  index: number
  count: number
  onChange: (g: VariationGroup) => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
}): ReactNode {
  const g = props.group
  const [open, setOpen] = useState(g.items.length === 0)
  const [openItem, setOpenItem] = useState<number | null>(null)
  const [bulk, setBulk] = useState<string | null>(null)
  const totalWeight = g.items.reduce((a, x) => a + Math.max(0, x.weight), 0)
  const set = (p: Partial<VariationGroup>): void => props.onChange({ ...g, ...p })
  const setItems = (items: VariationItem[]): void => set({ items })
  const label = variationGroupLabel(g)
  const modeLabel = VARIATION_MODES.find((m) => m.value === g.mode)?.label ?? ''

  return (
    <li className="rounded-lg border border-line bg-field">
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex h-12 min-w-0 flex-1 items-center gap-2 px-3 text-left"
        >
          {open ? <ChevronUp size={16} className="shrink-0 text-dim" /> : <ChevronDown size={16} className="shrink-0 text-dim" />}
          <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
          <span className={cx('shrink-0 text-xs', g.mode === 'off' ? 'text-dim' : 'text-accent')}>
            {modeLabel} · {g.items.length}개
          </span>
        </button>
        <IconButton label={`${label} 위로`} disabled={props.index === 0} onClick={() => props.onMove(-1)}>
          <ArrowUp size={16} />
        </IconButton>
        <IconButton label={`${label} 아래로`} disabled={props.index === props.count - 1} onClick={() => props.onMove(1)}>
          <ArrowDown size={16} />
        </IconButton>
      </div>
      {open && (
        <div className="flex flex-col gap-2 border-t border-line p-2.5">
          <div className="flex gap-1.5">
            <Select
              label="그룹 종류"
              className="w-32 shrink-0"
              value={g.kind}
              options={VARIATION_KINDS}
              onChange={(kind: VariationKind) => set({ kind })}
            />
            <TextInput
              label="그룹 이름"
              value={g.name}
              onChange={(name) => set({ name })}
              placeholder={VARIATION_KINDS.find((k) => k.value === g.kind)?.label}
            />
          </div>
          <Segmented label={`${label} 모드`} value={g.mode} options={VARIATION_MODES} onChange={(mode) => set({ mode })} />
          <p className="text-xs text-dim">{MODE_HINT[g.mode]}</p>
          {(g.mode === 'random' || g.mode === 'sequential') && (
            <Row label="배치마다 한 번만 뽑기" hint="한 배치(씬마다 따로 뽑기면 씬) 안에서는 같은 항목을 씁니다">
              <Toggle label="배치마다 한 번만 뽑기" checked={!!g.perBatch} onChange={(perBatch) => set({ perBatch })} />
            </Row>
          )}
          {g.items.length > 0 && (
            <ul className="flex flex-col gap-1">
              {g.items.map((item, i) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  group={g}
                  index={i}
                  count={g.items.length}
                  totalWeight={totalWeight}
                  open={openItem === item.id}
                  onToggle={() => setOpenItem(openItem === item.id ? null : item.id)}
                  onChange={(p) => setItems(g.items.map((x) => (x.id === item.id ? { ...x, ...p } : x)))}
                  onMove={(dir) => {
                    const j = i + dir
                    if (j < 0 || j >= g.items.length) return
                    const items = [...g.items]
                    ;[items[i], items[j]] = [items[j], items[i]]
                    setItems(items)
                  }}
                  onRemove={() =>
                    set({
                      items: g.items.filter((x) => x.id !== item.id),
                      fixedId: g.fixedId === item.id ? null : g.fixedId
                    })
                  }
                  onPickFixed={() => set({ fixedId: item.id })}
                />
              ))}
            </ul>
          )}
          {bulk !== null ? (
            <div className="flex flex-col gap-1.5 rounded-md border border-line p-2">
              <p className="text-xs text-dim">
                한 줄에 항목 하나 — <span className="font-mono">이름: 프롬프트</span> 또는 프롬프트만
              </p>
              <TextArea
                label="여러 항목 붙여넣기"
                rows={5}
                value={bulk}
                onChange={setBulk}
                placeholder={'교복: school uniform\n수영복: swimsuit\npajamas'}
              />
              <div className="flex gap-1.5">
                <Button variant="ghost" onClick={() => setBulk(null)}>
                  취소
                </Button>
                <Button
                  variant="primary"
                  className="flex-1"
                  disabled={!parseItemLines(bulk).length}
                  onClick={() => {
                    setItems([...g.items, ...parseItemLines(bulk)])
                    setBulk(null)
                  }}
                >
                  {parseItemLines(bulk).length}개 추가
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-1.5">
              <Button
                className="flex-1"
                onClick={() => {
                  const item = { id: uid(), label: '', prompt: '', weight: 1 }
                  setItems([...g.items, item])
                  setOpenItem(item.id)
                }}
              >
                <Plus size={16} />
                항목
              </Button>
              <Button className="flex-1" onClick={() => setBulk('')}>
                <ListPlus size={16} />
                여러 줄 추가
              </Button>
            </div>
          )}
          <button
            type="button"
            className="h-9 self-end rounded-md px-2 text-xs text-danger active:bg-raised"
            onClick={() => {
              if (!g.items.length || window.confirm(`"${label}" 그룹과 항목 ${g.items.length}개를 지울까요?`)) props.onRemove()
            }}
          >
            그룹 삭제
          </button>
        </div>
      )}
    </li>
  )
}

/** 캐릭터 편집: 고정 · 가변 · 디테일 · 네거티브 + 변형 그룹 */
export function CharacterEditor(props: { initial: Partial<Character>; onClose: () => void }): ReactNode {
  const { folders, saveCharacter, deleteCharacter } = useCharacters()
  const [name, setName] = useState(props.initial.name ?? '')
  const [folderId, setFolderId] = useState<number | null>(props.initial.folderId ?? null)
  const [base, setBase] = useState(props.initial.base ?? '')
  const [additional, setAdditional] = useState(props.initial.additional ?? '')
  const [detail, setDetail] = useState(props.initial.detail ?? '')
  const [negative, setNegative] = useState(props.initial.negative ?? '')
  const [variations, setVariations] = useState<VariationGroup[]>(props.initial.variations ?? [])
  const [adding, setAdding] = useState(false)
  const [roll, setRoll] = useState(0)
  const id = props.initial.id

  // 지금 고친 내용으로 한 장 뽑아 본 캡션 (조각은 치환 전)
  const sample = useMemo(() => {
    const draft: Character = { id: id ?? -1, name, folderId, base, additional, detail, negative, variations }
    return resolveCast(
      { slots: fixedSlots([draft.id]), options: DEFAULT_CAST_OPTIONS, characters: [draft] },
      createDrawState()
    ).chars[0]
    // roll: "다시 뽑기"
  }, [id, name, folderId, base, additional, detail, negative, variations, roll]) // eslint-disable-line react-hooks/exhaustive-deps

  const patchGroup = (gid: number, g: VariationGroup): void =>
    setVariations((vs) => vs.map((x) => (x.id === gid ? g : x)))

  return (
    <Sheet
      title={id ? '캐릭터 편집' : '캐릭터 추가'}
      onClose={props.onClose}
      footer={
        <>
          {id !== undefined && (
            <Button
              variant="danger"
              onClick={() => {
                if (window.confirm(`"${name}" 캐릭터를 삭제할까요?`)) {
                  deleteCharacter(id)
                  props.onClose()
                }
              }}
            >
              <Trash2 size={16} />
              삭제
            </Button>
          )}
          <Button
            variant="primary"
            className="flex-1"
            onClick={() => {
              saveCharacter({ id, name, folderId, base, additional, detail, negative, variations })
              props.onClose()
            }}
          >
            저장
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs text-dim">
          이름
          <TextInput label="이름" value={name} onChange={setName} placeholder="캐릭터 이름" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-dim">
          폴더
          <Select
            label="폴더"
            value={folderId ?? 0}
            options={[{ value: 0, label: '미분류' }, ...folders.map((f) => ({ value: f.id, label: f.name }))]}
            onChange={(v) => setFolderId(v === 0 ? null : v)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-dim">
          고정 — 얼굴·체형·머리 등 이 캐릭터를 알아보게 하는 부분
          <TextArea label="캐릭터 고정 프롬프트" rows={4} value={base} onChange={setBase} placeholder="girl, black hair, red eyes, ..." />
        </label>
        <label className="flex flex-col gap-1 text-xs text-dim">
          가변 — 복장·표정·자세처럼 그때그때 바꿀 부분 (변형 그룹 뒤에 붙습니다)
          <TextArea label="캐릭터 가변 프롬프트" rows={2} value={additional} onChange={setAdditional} placeholder="smile, ..." />
        </label>
        <label className="flex flex-col gap-1 text-xs text-dim">
          디테일 — 맨 뒤에 붙일 세부 묘사
          <TextArea label="캐릭터 디테일 프롬프트" rows={2} value={detail} onChange={setDetail} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-dim">
          캐릭터 네거티브 (선택)
          <TextArea label="캐릭터 네거티브" rows={2} value={negative} onChange={setNegative} />
        </label>

        <div>
          <h3 className="mb-1 text-xs text-dim">
            변형 그룹 {variations.length} — 고정 뒤·가변 앞에 그룹 순서대로 들어갑니다
          </h3>
          {variations.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {variations.map((g, i) => (
                <GroupCard
                  key={g.id}
                  group={g}
                  index={i}
                  count={variations.length}
                  onChange={(next) => patchGroup(g.id, next)}
                  onMove={(dir) =>
                    setVariations((vs) => {
                      const j = i + dir
                      if (j < 0 || j >= vs.length) return vs
                      const next = [...vs]
                      ;[next[i], next[j]] = [next[j], next[i]]
                      return next
                    })
                  }
                  onRemove={() => setVariations((vs) => vs.filter((x) => x.id !== g.id))}
                />
              ))}
            </ul>
          )}
          {adding ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5 rounded-lg border border-line p-2">
              {VARIATION_KINDS.map((k) => (
                <button
                  key={k.value}
                  type="button"
                  className="h-9 rounded-full border border-line px-3 text-[13px] active:bg-raised"
                  onClick={() => {
                    setVariations((vs) => [
                      ...vs,
                      { id: uid(), kind: k.value, name: '', mode: 'random', fixedId: null, items: [] }
                    ])
                    setAdding(false)
                  }}
                >
                  {k.label}
                </button>
              ))}
              <button type="button" className="h-9 px-2 text-[13px] text-dim" onClick={() => setAdding(false)}>
                취소
              </button>
            </div>
          ) : (
            <Button className="mt-1.5 w-full" onClick={() => setAdding(true)}>
              <Plus size={16} />
              변형 그룹 추가 (복장·표정·자세 …)
            </Button>
          )}
        </div>

        <div className="rounded-lg border border-line bg-field p-2.5">
          <div className="mb-1 flex items-center">
            <span className="flex-1 text-xs text-dim">보낼 캡션 예시 (조각은 생성할 때 치환)</span>
            <button
              type="button"
              className="flex h-8 items-center gap-1 rounded-md px-2 text-xs text-accent active:bg-raised"
              onClick={() => setRoll(roll + 1)}
            >
              <RefreshCw size={13} />
              다시 뽑기
            </button>
          </div>
          {sample?.variations.length ? (
            <div className="mb-1 flex flex-wrap gap-1">
              {sample.variations.map((v) => (
                <span key={v.groupId} className="rounded-full bg-raised px-2 py-0.5 text-[11px]">
                  {v.group}: {v.label}
                </span>
              ))}
            </div>
          ) : null}
          <p className="break-words font-mono text-xs">{sample?.prompt || '(빈 캡션 — 보내지 않습니다)'}</p>
        </div>
      </div>
    </Sheet>
  )
}
