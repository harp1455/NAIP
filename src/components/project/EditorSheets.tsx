/** 프로젝트 설정의 편집 시트 — 캐릭터, 축과 값, 제외 규칙, 조합별 덮어쓰기, 바이브·레퍼런스 고르기 */
import { useMemo, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Check, ListPlus, Pencil, Plus, Trash2 } from 'lucide-react'
import { RESOLUTIONS } from '../../nai/constants'
import { composeCaption } from '../../nai/cast'
import { cx } from '../../lib/util'
import {
  AXIS_KIND_LABEL,
  characterCode,
  keyedAxes,
  newId,
  parseValueLines,
  projectAxes,
  useProjects,
  type Axis,
  type AxisKind,
  type ComboOverride,
  type ExclusionRule,
  type Project,
  type ProjectCharacter
} from '../../project'
import { useCharacters } from '../../stores/characters'
import { useRefs } from '../../stores/refs'
import { Button, Empty, IconButton, Row, Select, Sheet, TextArea, TextInput, Toggle } from '../ui'
import { Chip, DraftArea, DraftInput, Field, patchLatest } from './common'

/**
 * 켜고 끄기로 조합 키에 들어가는 축이 바뀌면(마지막 켠 값을 끄거나, 다 꺼진 축의 값을 켬) 지금까지의 그림이
 * 모두 "행렬에서 빠진 조합"으로 옮겨진다 — 그림은 남고 되돌리면 돌아오지만, 모르고 누르지 않게 먼저 묻는다.
 * (값·캐릭터를 더하거나 지울 때는 model.carryItemKeys가 키를 옮겨 준다)
 */
function confirmKeyChange(p: Project, next: Pick<Project, 'characters' | 'axes'>, what: string): boolean {
  const images = Object.values(p.items).reduce((n, i) => n + i.images.length, 0)
  if (!images) return true
  const before = [...keyedAxes(p).keys()].sort().join('|')
  const after = [...keyedAxes(next).keys()].sort().join('|')
  if (before === after) return true
  return window.confirm(
    `${what} 행렬의 축이 바뀌어 지금까지 만든 그림 ${images}장이 모두 "행렬에서 빠진 조합"으로 옮겨집니다. 그림은 지워지지 않고, 다시 되돌리면 돌아옵니다. 계속할까요?`
  )
}

// ── 바이브 · 정밀 레퍼런스 고르기 ────────────────────────────────────────────

export function RefPicker(props: { vibeIds: number[]; refIds: number[]; onChange: (p: { vibeIds?: number[]; refIds?: number[] }) => void }): ReactNode {
  const { vibes, charRefs } = useRefs()
  const toggle = (list: number[], id: number): number[] => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])
  const missing = [...props.vibeIds.filter((id) => !vibes.some((v) => v.id === id)), ...props.refIds.filter((id) => !charRefs.some((r) => r.id === id))]
  if (!vibes.length && !charRefs.length) {
    return <p className="text-[11px] text-dim">바이브·정밀 레퍼런스는 프롬프트 화면에서 추가한 것 중에서 고릅니다 (지금은 없음)</p>
  }
  const item = (on: boolean, thumb: string, name: string, onClick: () => void, kind: string): ReactNode => (
    <button
      type="button"
      aria-pressed={on}
      aria-label={`${kind} ${name}`}
      onClick={onClick}
      className={cx('relative h-16 w-16 shrink-0 overflow-hidden rounded-md border-2 bg-raised', on ? 'border-accent' : 'border-transparent opacity-60')}
    >
      {thumb && <img src={thumb} alt="" className="h-full w-full object-cover" />}
      <span className="absolute inset-x-0 bottom-0 truncate bg-black/70 px-1 text-[9px] text-white">{name}</span>
      {on && <Check size={14} strokeWidth={3} className="absolute right-0.5 top-0.5 rounded-full bg-accent text-accent-fg" />}
    </button>
  )
  return (
    <div className="flex flex-col gap-2">
      {vibes.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] text-dim">바이브</div>
          <div className="scroll-thin flex gap-1.5 overflow-x-auto pb-1">
            {vibes.map((v) => item(props.vibeIds.includes(v.id), v.thumb, v.name, () => props.onChange({ vibeIds: toggle(props.vibeIds, v.id) }), '바이브'))}
          </div>
        </div>
      )}
      {charRefs.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] text-dim">정밀 레퍼런스</div>
          <div className="scroll-thin flex gap-1.5 overflow-x-auto pb-1">
            {charRefs.map((r) => item(props.refIds.includes(r.id), r.thumb, r.name, () => props.onChange({ refIds: toggle(props.refIds, r.id) }), '레퍼런스'))}
          </div>
        </div>
      )}
      {missing.length > 0 && (
        <button
          type="button"
          className="self-start text-[11px] text-danger underline"
          onClick={() =>
            props.onChange({
              vibeIds: props.vibeIds.filter((id) => vibes.some((v) => v.id === id)),
              refIds: props.refIds.filter((id) => charRefs.some((r) => r.id === id))
            })
          }
        >
          지워진 항목 {missing.length}개 정리
        </button>
      )}
    </div>
  )
}

// ── 캐릭터 ───────────────────────────────────────────────────────────────────

export function LibraryPickerSheet(props: { project: Project; onClose: () => void }): ReactNode {
  const { characters, folders } = useCharacters()
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const used = new Set(props.project.characters.map((c) => c.libraryId))
  const groups = [...folders.map((f) => ({ id: f.id as number | null, name: f.name })), { id: null, name: '미분류' }]
  return (
    <Sheet
      title="라이브러리에서 캐릭터 추가"
      onClose={props.onClose}
      footer={
        <Button
          variant="primary"
          className="flex-1"
          disabled={!picked.size}
          onClick={() => {
            for (const c of characters.filter((x) => picked.has(x.id))) {
              useProjects.getState().addCharacter(props.project.id, { name: c.name, libraryId: c.id })
            }
            props.onClose()
          }}
        >
          {picked.size}명 추가
        </Button>
      }
    >
      {characters.length === 0 ? (
        <Empty>캐릭터 라이브러리가 비어 있습니다. 프롬프트 화면의 "캐릭터"에서 만들거나, 프로젝트 전용 캐릭터를 추가하세요.</Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((g) => {
            const list = characters.filter((c) => c.folderId === g.id)
            if (!list.length) return null
            return (
              <section key={String(g.id)}>
                <h3 className="mb-1 text-xs text-dim">{g.name}</h3>
                <ul className="flex flex-col gap-1">
                  {list.map((c) => {
                    const on = picked.has(c.id)
                    return (
                      <li key={c.id}>
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={on}
                          aria-label={c.name}
                          onClick={() => {
                            const next = new Set(picked)
                            if (on) next.delete(c.id)
                            else next.add(c.id)
                            setPicked(next)
                          }}
                          className={cx('flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left', on ? 'border-accent bg-accent/10' : 'border-line bg-field')}
                        >
                          <span className={cx('flex h-5 w-5 shrink-0 items-center justify-center rounded border', on ? 'border-accent bg-accent text-accent-fg' : 'border-line')}>
                            {on && <Check size={13} strokeWidth={3} />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm">
                              {c.name}
                              {used.has(c.id) && <span className="ml-1 text-[11px] text-dim">(이미 있음)</span>}
                            </span>
                            <span className="block truncate font-mono text-[11px] text-dim">{composeCaption(c, []) || '(빈 프롬프트)'}</span>
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>
      )}
    </Sheet>
  )
}

export function CharacterEditSheet(props: { project: Project; charId: string; onClose: () => void }): ReactNode {
  const p = props.project
  const c = p.characters.find((x) => x.id === props.charId)
  const library = useCharacters((s) => s.characters)
  const s = useProjects.getState()
  if (!c) return null
  const patch = (x: Partial<Omit<ProjectCharacter, 'id'>>): void => s.patchCharacter(p.id, c.id, x)
  const lib = c.libraryId !== null ? library.find((x) => x.id === c.libraryId) : undefined
  return (
    <Sheet
      title={`캐릭터 · ${c.name}`}
      onClose={props.onClose}
      footer={
        <>
          <Button
            variant="danger"
            onClick={() => {
              if (!window.confirm(`"${c.name}"을(를) 프로젝트에서 뺄까요? 이 캐릭터를 가리키는 제외·덮어쓰기 규칙도 지워집니다. 만든 그림은 히스토리와 "행렬에서 빠진 조합"에 남습니다.`)) return
              s.removeCharacter(p.id, c.id)
              props.onClose()
            }}
          >
            <Trash2 size={16} />
            빼기
          </Button>
          <Button variant="primary" className="flex-1" onClick={props.onClose}>
            완료
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-[1fr_1fr_72px] gap-2">
          <Field label="이름">
            <DraftInput label="캐릭터 이름" value={c.name} onCommit={(name) => patch({ name: name.trim() || c.name })} />
          </Field>
          <Field label="파일 이름용 (slug)">
            <DraftInput label="캐릭터 slug" value={c.slug ?? ''} placeholder={c.name} onCommit={(slug) => patch({ slug: slug.trim() || undefined })} />
          </Field>
          <Field label="코드">
            <DraftInput label="코드 글자" value={c.code ?? ''} placeholder={characterCode(p, c)} onCommit={(code) => patch({ code: code.trim() || undefined })} />
          </Field>
        </div>
        <Field label="라이브러리 캐릭터" hint="생성할 때 라이브러리의 고정·가변·디테일 칸을 읽어 앞에 붙입니다 (변형 그룹은 쓰지 않음 — 의상·표정은 축으로)">
          <Select
            label="라이브러리 캐릭터"
            value={c.libraryId ?? 0}
            options={[{ value: 0, label: '없음 (프로젝트 전용)' }, ...library.map((x) => ({ value: x.id, label: x.name }))]}
            onChange={(v) => patch({ libraryId: v === 0 ? null : v })}
          />
        </Field>
        {c.libraryId !== null && (
          <p className={cx('rounded-lg bg-field px-3 py-2 font-mono text-[11px]', lib ? 'text-dim' : 'text-danger')}>
            {lib ? composeCaption(lib, []) || '(라이브러리 프롬프트가 비어 있음)' : '라이브러리에서 지워졌습니다 — 아래 조각만 보냅니다'}
          </p>
        )}
        <Field label="이 프로젝트에서 덧붙일 캐릭터 프롬프트">
          <DraftArea label="캐릭터 추가 프롬프트" value={c.prompt ?? ''} onCommit={(prompt) => patch({ prompt })} placeholder="solo, upper body" />
        </Field>
        <Field label="캐릭터 네거티브">
          <DraftArea label="캐릭터 추가 네거티브" rows={2} value={c.negative ?? ''} onCommit={(negative) => patch({ negative })} />
        </Field>
        <div className="rounded-lg border border-line bg-field px-3">
          <Row label="행렬에 넣기" hint="끄면 이 캐릭터의 조합을 잠시 뺍니다 (기록은 그대로)">
            <Toggle
              label="행렬에 넣기"
              checked={c.enabled !== false}
              onChange={(on) => {
                const next = { ...p, characters: p.characters.map((x) => (x.id === c.id ? { ...x, enabled: on ? undefined : false } : x)) }
                if (!confirmKeyChange(p, next, on ? `"${c.name}"을(를) 다시 넣으면` : `"${c.name}"을(를) 빼면`)) return
                patch({ enabled: on ? undefined : false })
              }}
            />
          </Row>
        </div>
        <Field label="이 캐릭터 조합에만 쓸 바이브·정밀 레퍼런스">
          <RefPicker vibeIds={c.vibeIds} refIds={c.refIds} onChange={(x) => patch(x)} />
        </Field>
      </div>
    </Sheet>
  )
}

// ── 축 · 값 ──────────────────────────────────────────────────────────────────

const KINDS: AxisKind[] = ['outfit', 'expression', 'situation', 'location', 'action', 'custom']

export function AxisEditSheet(props: { project: Project; axisId: string; onClose: () => void }): ReactNode {
  const p = props.project
  const axis = p.axes.find((a) => a.id === props.axisId)
  const s = useProjects.getState()
  const [valueId, setValueId] = useState<string | null>(null)
  const [bulk, setBulk] = useState<string | null>(null)
  if (!axis) return null
  const patch = (x: Partial<Omit<Axis, 'id' | 'values'>>): void => s.patchAxis(p.id, axis.id, x)
  const parsed = bulk !== null ? parseValueLines(bulk) : []
  return (
    <Sheet
      title={`축 · ${axis.name}`}
      onClose={props.onClose}
      footer={
        <>
          <Button
            variant="danger"
            onClick={() => {
              if (!window.confirm(`"${axis.name}" 축을 지울까요? 이 축을 쓰는 제외·덮어쓰기·분류 규칙도 정리됩니다. 만든 그림은 남습니다.`)) return
              s.removeAxis(p.id, axis.id)
              props.onClose()
            }}
          >
            <Trash2 size={16} />
            축 삭제
          </Button>
          <Button variant="primary" className="flex-1" onClick={props.onClose}>
            완료
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="종류">
            <Select
              label="축 종류"
              value={axis.kind}
              options={KINDS.map((k) => ({ value: k, label: AXIS_KIND_LABEL[k] }))}
              onChange={(kind) => patch({ kind })}
            />
          </Field>
          <Field label="이름 (변수 {이름})">
            <DraftInput label="축 이름" value={axis.name} onCommit={(name) => patch({ name: name.trim() || axis.name })} />
          </Field>
          <Field label="영문 변수 (예: hair)">
            <DraftInput label="축 key" value={axis.key ?? ''} placeholder="비우면 이름만" onCommit={(key) => patch({ key: key.trim() || undefined })} />
          </Field>
          <Field label="넣을 곳">
            <Select
              label="프롬프트 위치"
              value={axis.target}
              options={[
                { value: 'character', label: '캐릭터 프롬프트' },
                { value: 'base', label: '메인 프롬프트' }
              ]}
              onChange={(target) => patch({ target })}
            />
          </Field>
        </div>

        <div className="flex items-center">
          <h3 className="flex-1 text-xs font-semibold">값 {axis.values.length}개</h3>
          <Button variant="ghost" className="px-2 text-xs" onClick={() => setBulk(bulk === null ? '' : null)}>
            <ListPlus size={14} />
            여러 줄 추가
          </Button>
          <Button
            variant="ghost"
            className="px-2 text-xs"
            onClick={() => {
              const id = s.addValue(p.id, axis.id, { label: `값 ${axis.values.length + 1}` })
              if (id) setValueId(id)
            }}
          >
            <Plus size={14} />
            값 추가
          </Button>
        </div>
        {bulk !== null && (
          <div className="flex flex-col gap-2 rounded-lg border border-line bg-field p-2">
            <TextArea label="여러 값 붙여넣기" rows={5} value={bulk} onChange={setBulk} placeholder={'웃음: smile, open mouth\n울음 (cry): crying, tears\nangry, frown'} />
            <p className="text-[11px] text-dim">
              한 줄에 하나 — "이름: 프롬프트"(콜론 뒤 띄어쓰기), 괄호 안은 파일 이름용, 이름이 없으면 첫 조각을 이름으로. artist:이름 같은 태그는
              프롬프트로 둡니다
            </p>
            {parsed.length > 0 && (
              <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto text-[11px]" aria-label="추가할 값 미리보기">
                {parsed.slice(0, 50).map((v, i) => (
                  <li key={i} className="truncate">
                    <span className="font-semibold">{v.label}</span>
                    {v.slug ? <span className="text-dim"> ({v.slug})</span> : null}
                    <span className="font-mono text-dim"> — {v.prompt || '(빈 프롬프트)'}</span>
                  </li>
                ))}
                {parsed.length > 50 && <li className="text-dim">외 {parsed.length - 50}개</li>}
              </ul>
            )}
            <Button
              variant="primary"
              disabled={!parsed.length}
              onClick={() => {
                for (const v of parsed) s.addValue(p.id, axis.id, v)
                setBulk(null)
              }}
            >
              {parsed.length}개 추가
            </Button>
          </div>
        )}
        {axis.values.length === 0 ? (
          <p className="py-4 text-center text-xs text-dim">
            값이 없으면 이 축은 행렬에서 빠집니다. 첫 값을 넣으면 지금까지 만든 그림은 그 값의 조합으로 들어갑니다
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5" aria-label={`${axis.name} 값`}>
            {axis.values.map((v, i) => (
              <li key={v.id} className={cx('flex items-center gap-1 rounded-lg border border-line bg-field py-1 pl-2', v.enabled === false && 'opacity-50')}>
                <Toggle
                  label={`${v.label} 켜기`}
                  checked={v.enabled !== false}
                  onChange={(on) => {
                    const next = {
                      ...p,
                      axes: p.axes.map((a) =>
                        a.id === axis.id ? { ...a, values: a.values.map((x) => (x.id === v.id ? { ...x, enabled: on ? undefined : false } : x)) } : a
                      )
                    }
                    if (!confirmKeyChange(p, next, on ? `"${v.label}"을(를) 켜면` : `"${v.label}"을(를) 끄면`)) return
                    s.patchValue(p.id, axis.id, v.id, { enabled: on ? undefined : false })
                  }}
                />
                <button type="button" onClick={() => setValueId(v.id)} className="min-w-0 flex-1 px-1.5 text-left" aria-label={`${v.label} 편집`}>
                  <span className="block truncate text-sm">
                    {v.label}
                    {v.slug ? <span className="ml-1 font-mono text-[11px] text-dim">({v.slug})</span> : null}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-dim">{v.prompt || '(빈 프롬프트)'}</span>
                </button>
                <IconButton label={`${v.label} 위로`} disabled={i === 0} onClick={() => s.moveValue(p.id, axis.id, v.id, -1)}>
                  <ArrowUp size={15} />
                </IconButton>
                <IconButton label={`${v.label} 아래로`} disabled={i === axis.values.length - 1} onClick={() => s.moveValue(p.id, axis.id, v.id, 1)}>
                  <ArrowDown size={15} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </div>
      {valueId && <ValueEditSheet project={p} axis={axis} valueId={valueId} onClose={() => setValueId(null)} />}
    </Sheet>
  )
}

function ValueEditSheet(props: { project: Project; axis: Axis; valueId: string; onClose: () => void }): ReactNode {
  const p = props.project
  const v = props.axis.values.find((x) => x.id === props.valueId)
  const s = useProjects.getState()
  if (!v) return null
  const patch = (x: Parameters<typeof s.patchValue>[3]): void => s.patchValue(p.id, props.axis.id, v.id, x)
  return (
    <Sheet
      title={`${props.axis.name} · ${v.label}`}
      onClose={props.onClose}
      footer={
        <>
          <Button
            variant="danger"
            onClick={() => {
              if (!window.confirm(`"${v.label}" 값을 지울까요? 이 값을 쓰는 규칙도 정리됩니다. 만든 그림은 남습니다.`)) return
              s.removeValue(p.id, props.axis.id, v.id)
              props.onClose()
            }}
          >
            <Trash2 size={16} />
            삭제
          </Button>
          <Button variant="primary" className="flex-1" onClick={props.onClose}>
            완료
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="표시 이름">
            <DraftInput label="값 이름" value={v.label} onCommit={(label) => patch({ label: label.trim() || v.label })} />
          </Field>
          <Field label="파일 이름용 (slug)">
            <DraftInput label="값 slug" value={v.slug ?? ''} placeholder={v.label} onCommit={(slug) => patch({ slug: slug.trim() || undefined })} />
          </Field>
        </div>
        <Field label="프롬프트 조각">
          <DraftArea label="값 프롬프트" value={v.prompt} onCommit={(prompt) => patch({ prompt })} placeholder="smile, open mouth" />
        </Field>
        <Field label="네거티브 조각 (선택)">
          <DraftArea label="값 네거티브" rows={2} value={v.negative ?? ''} onCommit={(negative) => patch({ negative: negative || undefined })} />
        </Field>
        {p.characters.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs text-dim">캐릭터별 프롬프트 — 적으면 그 캐릭터 조합에서는 위 조각 대신 씁니다</h3>
            {p.characters.map((c) => (
              <Field key={c.id} label={c.name}>
                <DraftInput
                  label={`${c.name}의 ${v.label} 프롬프트`}
                  value={v.perCharacter?.[c.id] ?? ''}
                  placeholder={v.prompt}
                  onCommit={(t) => {
                    const per = { ...(v.perCharacter ?? {}) }
                    if (t.trim()) per[c.id] = t
                    else delete per[c.id]
                    patch({ perCharacter: Object.keys(per).length ? per : undefined })
                  }}
                />
              </Field>
            ))}
          </section>
        )}
      </div>
    </Sheet>
  )
}

// ── 제외 규칙 · 덮어쓰기 ─────────────────────────────────────────────────────

export function describeMatch(p: Project, match: Record<string, string | string[]>): string {
  const axes = projectAxes(p)
  const parts = Object.entries(match).map(([a, v]) => {
    const axis = axes.find((x) => x.id === a)
    const names = (Array.isArray(v) ? v : [v]).map((id) => axis?.values.find((x) => x.id === id)?.label ?? '?')
    return `${axis?.name ?? '?'}: ${names.join('/')}`
  })
  return parts.join(' · ') || '(조건 없음)'
}

export function ExclusionSheet(props: { project: Project; rule: ExclusionRule | null; onClose: () => void }): ReactNode {
  const p = props.project
  const axes = useMemo(() => projectAxes(p), [p])
  const [when, setWhen] = useState<Record<string, string[]>>(props.rule?.when ?? {})
  const [note, setNote] = useState(props.rule?.note ?? '')
  const save = (): void => {
    const clean = Object.fromEntries(Object.entries(when).filter(([, v]) => v.length))
    const rule: ExclusionRule = { id: props.rule?.id ?? newId(), when: clean, ...(note.trim() ? { note: note.trim() } : {}) }
    patchLatest(p.id, (latest) => ({
      exclusions: props.rule ? latest.exclusions.map((r) => (r.id === rule.id ? rule : r)) : [...latest.exclusions, rule]
    }))
    props.onClose()
  }
  const count = Object.values(when).filter((v) => v.length).length
  return (
    <Sheet
      title={props.rule ? '제외 규칙 편집' : '제외 규칙 추가'}
      onClose={props.onClose}
      footer={
        <Button variant="primary" className="flex-1" disabled={!count} onClick={save}>
          저장
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-dim">고른 축의 값이 모두 맞는 조합을 만들지 않습니다 (한 축에서 여러 값을 고르면 그중 하나). 예: 하늘 + 수영복</p>
        {axes.map((a) => (
          <Field key={a.id} label={a.name}>
            <div className="flex flex-wrap gap-1.5">
              {a.values.map((v) => {
                const on = when[a.id]?.includes(v.id) ?? false
                return (
                  <Chip
                    key={v.id}
                    on={on}
                    label={`${a.name} ${v.label}`}
                    onClick={() => setWhen({ ...when, [a.id]: on ? (when[a.id] ?? []).filter((x) => x !== v.id) : [...(when[a.id] ?? []), v.id] })}
                  >
                    {v.label}
                  </Chip>
                )
              })}
            </div>
          </Field>
        ))}
        <Field label="메모 (선택)">
          <TextInput label="제외 메모" value={note} onChange={setNote} placeholder="예: 하늘은 수영복 없음" />
        </Field>
      </div>
    </Sheet>
  )
}

export function OverrideSheet(props: { project: Project; override: ComboOverride | null; onClose: () => void }): ReactNode {
  const p = props.project
  const axes = useMemo(() => projectAxes(p), [p])
  const init = props.override
  const [match, setMatch] = useState<Record<string, string>>(init?.match ?? {})
  const [prompt, setPrompt] = useState(init?.prompt ?? '')
  const [negative, setNegative] = useState(init?.negative ?? '')
  const [characterPrompt, setCharacterPrompt] = useState(init?.characterPrompt ?? '')
  const [size, setSize] = useState<string>(init?.width && init?.height ? `${init.width}x${init.height}` : '')
  const [count, setCount] = useState<string>(init?.count !== undefined ? String(init.count) : '')
  const [target, setTarget] = useState<string>(init?.target !== undefined ? String(init.target) : '')
  const save = (): void => {
    const [w, h] = size ? size.split('x').map(Number) : []
    const o: ComboOverride = {
      id: init?.id ?? newId(),
      match: Object.fromEntries(Object.entries(match).filter(([, v]) => v)),
      ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      ...(negative.trim() ? { negative: negative.trim() } : {}),
      ...(characterPrompt.trim() ? { characterPrompt: characterPrompt.trim() } : {}),
      ...(w && h ? { width: w, height: h } : {}),
      ...(count && Number(count) >= 0 ? { count: Math.floor(Number(count)) } : {}),
      ...(target && Number(target) >= 1 ? { target: Math.floor(Number(target)) } : {})
    }
    patchLatest(p.id, (latest) => ({ overrides: init ? latest.overrides.map((x) => (x.id === o.id ? o : x)) : [...latest.overrides, o] }))
    props.onClose()
  }
  const sizes = [{ value: '', label: '기본 해상도' }, ...RESOLUTIONS.map((r) => ({ value: `${r.width}x${r.height}`, label: `${r.label} (${r.width}×${r.height})` }))]
  if (size && !sizes.some((x) => x.value === size)) sizes.push({ value: size, label: size.replace('x', '×') })
  return (
    <Sheet
      title={init ? '덮어쓰기 편집' : '덮어쓰기 추가'}
      onClose={props.onClose}
      footer={
        <Button variant="primary" className="flex-1" onClick={save}>
          저장
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-dim">
          맞는 조합에만 적용합니다. 축을 "모두"로 두면 그 축은 따지지 않습니다. 프롬프트는 맞는 것을 모두 덧붙이고, 숫자는 가장 구체적인 것이 이깁니다.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {axes.map((a) => (
            <Field key={a.id} label={a.name}>
              <Select
                label={`덮어쓰기 ${a.name}`}
                value={match[a.id] ?? ''}
                options={[{ value: '', label: '모두' }, ...a.values.map((v) => ({ value: v.id, label: v.label }))]}
                onChange={(v) => setMatch({ ...match, [a.id]: v })}
              />
            </Field>
          ))}
        </div>
        <Field label="메인 프롬프트에 덧붙임">
          <TextArea label="덮어쓰기 프롬프트" rows={2} value={prompt} onChange={setPrompt} />
        </Field>
        <Field label="캐릭터 프롬프트에 덧붙임">
          <TextArea label="덮어쓰기 캐릭터 프롬프트" rows={2} value={characterPrompt} onChange={setCharacterPrompt} />
        </Field>
        <Field label="네거티브에 덧붙임">
          <TextArea label="덮어쓰기 네거티브" rows={2} value={negative} onChange={setNegative} />
        </Field>
        <Field label="해상도">
          <Select label="덮어쓰기 해상도" value={size} options={sizes} onChange={setSize} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="생성 장수 (비우면 기본)">
            <TextInput label="덮어쓰기 장수" inputMode="numeric" value={count} onChange={(v) => setCount(v.replace(/\D/g, ''))} />
          </Field>
          <Field label="채택 목표 (비우면 기본)">
            <TextInput label="덮어쓰기 목표" inputMode="numeric" value={target} onChange={(v) => setTarget(v.replace(/\D/g, ''))} />
          </Field>
        </div>
      </div>
    </Sheet>
  )
}

// ── 목록 줄 ──────────────────────────────────────────────────────────────────

/** 목록 한 줄 — 오른쪽 끝은 늘 편집(연필). 삭제가 있으면 그 앞에 두고, 누르는 쪽에서 먼저 확인한다 */
export function ListRow(props: {
  title: ReactNode
  sub?: ReactNode
  onEdit: () => void
  editLabel: string
  onUp?: () => void
  onDown?: () => void
  onDelete?: () => void
  deleteLabel?: string
  dim?: boolean
  leading?: ReactNode
}): ReactNode {
  return (
    <li className={cx('flex items-center gap-1 rounded-lg border border-line bg-field py-1 pl-2.5 pr-0.5', props.dim && 'opacity-50')}>
      {props.leading}
      <button type="button" aria-label={props.editLabel} onClick={props.onEdit} className="min-w-0 flex-1 py-1 text-left">
        <span className="block truncate text-sm">{props.title}</span>
        {props.sub && <span className="block truncate text-[11px] text-dim">{props.sub}</span>}
      </button>
      {props.onUp && (
        <IconButton label="위로" onClick={props.onUp}>
          <ArrowUp size={15} />
        </IconButton>
      )}
      {props.onDown && (
        <IconButton label="아래로" onClick={props.onDown}>
          <ArrowDown size={15} />
        </IconButton>
      )}
      {props.onDelete && (
        <IconButton label={props.deleteLabel ?? '삭제'} onClick={props.onDelete}>
          <Trash2 size={15} className="text-danger" />
        </IconButton>
      )}
      <IconButton label={props.editLabel} onClick={props.onEdit}>
        <Pencil size={15} />
      </IconButton>
    </li>
  )
}
