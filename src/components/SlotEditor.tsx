import { useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Check, Copy, Folder, Plus, Search, Trash2, User, X } from 'lucide-react'
import { SLOT_MODES, orderedCandidates, weightedCandidates, type CastSlot, type SlotCandidate } from '../nai/cast'
import { cx } from '../lib/util'
import { candidateName, useCharacters, type CharFolder, type Character } from '../stores/characters'
import { Button, IconButton, Row, Sheet, SliderRow, Stepper, Toggle } from './ui'

/** 몇 개 중 하나를 고르는 칩 줄 (모드 선택용) */
export function Segmented<T extends string>(props: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (v: T) => void
}): ReactNode {
  return (
    <div role="radiogroup" aria-label={props.label} className="flex gap-1 rounded-lg border border-line bg-field p-1">
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={props.value === o.value}
          onClick={() => props.onChange(o.value)}
          className={cx(
            'h-9 min-w-0 flex-1 truncate rounded-md px-1 text-[13px]',
            props.value === o.value ? 'bg-accent text-accent-fg' : 'text-dim active:bg-raised'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** 슬롯 한 줄 요약 — 제목(누가)과 설명(어떻게) */
export function slotSummary(
  slot: CastSlot,
  characters: readonly Character[],
  folders: readonly CharFolder[]
): { title: string; sub: string; short: string } {
  const names = slot.candidates.map((c) => candidateName(c, characters, folders))
  const list = names.length > 3 ? `${names.slice(0, 3).join(', ')} 외 ${names.length - 3}` : names.join(', ')
  const fixedName = characters.find((c) => c.id === slot.charId)?.name
  switch (slot.mode) {
    case 'fixed':
      return { title: fixedName ?? '(캐릭터를 고르세요)', sub: '고정', short: fixedName ?? '고정' }
    case 'random': {
      const n = weightedCandidates(slot, characters).length
      return { title: list || '(후보를 추가하세요)', sub: `무작위 · ${n}명 중`, short: '무작위' }
    }
    case 'sequential': {
      const n = orderedCandidates(slot, characters).length
      return {
        title: list || '(후보를 추가하세요)',
        sub: `순차 · ${n}명${slot.wrap ? '' : ' · 한 바퀴만'}`,
        short: '순차'
      }
    }
    case 'chance':
      return {
        title: list || fixedName || '(후보를 추가하세요)',
        sub: `확률 ${slot.chance}%`,
        short: `${slot.chance}%`
      }
  }
}

/** 폴더 필터: 'all' = 전체, null = 미분류, number = 폴더 id */
type FolderFilter = 'all' | null | number

/** 라이브러리 목록을 이름·프롬프트로 찾고 폴더로 거른다 */
export function useLibraryFilter(characters: readonly Character[]): {
  query: string
  setQuery: (q: string) => void
  folder: FolderFilter
  setFolder: (f: FolderFilter) => void
  shown: Character[]
} {
  const [query, setQuery] = useState('')
  const [folder, setFolder] = useState<FolderFilter>('all')
  const q = query.trim().toLowerCase()
  const shown = characters.filter(
    (c) =>
      (folder === 'all' || c.folderId === folder) &&
      (!q || c.name.toLowerCase().includes(q) || c.base.toLowerCase().includes(q))
  )
  return { query, setQuery, folder, setFolder, shown }
}

export function chipClass(active: boolean): string {
  return cx(
    'h-9 shrink-0 rounded-full border px-3 text-[13px]',
    active ? 'border-accent bg-accent/15 text-accent' : 'border-line text-dim'
  )
}

export function SearchBox(props: { value: string; onChange: (v: string) => void; label: string }): ReactNode {
  return (
    <div className="relative">
      <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim" />
      <input
        aria-label={props.label}
        type="search"
        value={props.value}
        placeholder="이름·프롬프트로 찾기"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => props.onChange(e.target.value)}
        className="h-10 w-full rounded-lg border border-line bg-field pl-9 pr-3 text-sm text-fg placeholder:text-dim/60"
      />
    </div>
  )
}

/** 후보 고르기: 폴더(통째로)와 캐릭터를 여러 개 골라 한 번에 추가 */
function CandidatePicker(props: { slot: CastSlot; onClose: () => void }): ReactNode {
  const { characters, folders, patchSlot } = useCharacters()
  const lib = useLibraryFilter(characters)
  const has = (kind: 'char' | 'folder', id: number | null): boolean =>
    props.slot.candidates.some((c) => c.kind === kind && c.id === id)
  const [picked, setPicked] = useState<SlotCandidate[]>([])
  const isPicked = (kind: 'char' | 'folder', id: number | null): boolean =>
    picked.some((c) => c.kind === kind && c.id === id)
  const toggle = (kind: 'char' | 'folder', id: number | null): void =>
    setPicked((p) =>
      isPicked(kind, id) ? p.filter((c) => !(c.kind === kind && c.id === id)) : [...p, { kind, id, weight: 1 }]
    )
  const folderRows: { id: number | null; name: string; count: number }[] = [
    ...folders.map((f) => ({ id: f.id, name: f.name, count: characters.filter((c) => c.folderId === f.id).length })),
    { id: null, name: '미분류', count: characters.filter((c) => c.folderId === null).length }
  ].filter((f) => f.count > 0)
  const box = (on: boolean): ReactNode => (
    <span
      className={cx(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded border',
        on ? 'border-accent bg-accent text-accent-fg' : 'border-dim'
      )}
    >
      {on && <Check size={14} strokeWidth={3} />}
    </span>
  )
  return (
    <Sheet
      title="후보 추가"
      onClose={props.onClose}
      footer={
        <Button
          variant="primary"
          className="flex-1"
          disabled={!picked.length}
          onClick={() => {
            patchSlot(props.slot.id, { candidates: [...props.slot.candidates, ...picked] })
            props.onClose()
          }}
        >
          {picked.length ? `${picked.length}개 추가` : '후보를 고르세요'}
        </Button>
      }
    >
      {folderRows.length > 0 && (
        <>
          <h3 className="mb-1 text-xs text-dim">폴더 통째로 — 그 폴더의 캐릭터 중에서 뽑습니다</h3>
          <ul className="mb-4 flex flex-col gap-1">
            {folderRows.map((f) => {
              const already = has('folder', f.id)
              const on = isPicked('folder', f.id)
              return (
                <li key={f.id ?? 'none'}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    disabled={already}
                    onClick={() => toggle('folder', f.id)}
                    className={cx(
                      'flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left disabled:opacity-40',
                      on ? 'border-accent' : 'border-line'
                    )}
                  >
                    {box(on)}
                    <Folder size={15} className="shrink-0 text-dim" />
                    <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
                    <span className="shrink-0 text-[11px] text-dim">{already ? '추가됨' : `${f.count}명`}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}
      <h3 className="mb-1 text-xs text-dim">캐릭터</h3>
      <SearchBox label="캐릭터 찾기" value={lib.query} onChange={lib.setQuery} />
      <div className="scroll-thin -mx-3 mt-2 flex gap-1.5 overflow-x-auto px-3 pb-2">
        <button type="button" className={chipClass(lib.folder === 'all')} onClick={() => lib.setFolder('all')}>
          전체
        </button>
        <button type="button" className={chipClass(lib.folder === null)} onClick={() => lib.setFolder(null)}>
          미분류
        </button>
        {folders.map((f) => (
          <button key={f.id} type="button" className={chipClass(lib.folder === f.id)} onClick={() => lib.setFolder(f.id)}>
            {f.name}
          </button>
        ))}
      </div>
      {lib.shown.length === 0 ? (
        <p className="py-6 text-center text-xs text-dim">캐릭터가 없습니다</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {lib.shown.map((c) => {
            const already = has('char', c.id)
            const on = isPicked('char', c.id)
            return (
              <li key={c.id}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  aria-label={`${c.name} 후보`}
                  disabled={already}
                  onClick={() => toggle('char', c.id)}
                  className={cx(
                    'flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left disabled:opacity-40',
                    on ? 'border-accent' : 'border-line'
                  )}
                >
                  {box(on)}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{c.name}</span>
                    <span className="block truncate font-mono text-[11px] text-dim">{c.base || '(빈 고정 프롬프트)'}</span>
                  </span>
                  {already && <span className="shrink-0 text-[11px] text-dim">추가됨</span>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Sheet>
  )
}

/** 고정 슬롯의 캐릭터 고르기 (하나) */
function FixedPicker(props: { slot: CastSlot }): ReactNode {
  const { characters, folders, patchSlot } = useCharacters()
  const lib = useLibraryFilter(characters)
  return (
    <div>
      <SearchBox label="캐릭터 찾기" value={lib.query} onChange={lib.setQuery} />
      <div className="scroll-thin -mx-3 mt-2 flex gap-1.5 overflow-x-auto px-3 pb-2">
        <button type="button" className={chipClass(lib.folder === 'all')} onClick={() => lib.setFolder('all')}>
          전체
        </button>
        <button type="button" className={chipClass(lib.folder === null)} onClick={() => lib.setFolder(null)}>
          미분류
        </button>
        {folders.map((f) => (
          <button key={f.id} type="button" className={chipClass(lib.folder === f.id)} onClick={() => lib.setFolder(f.id)}>
            {f.name}
          </button>
        ))}
      </div>
      {lib.shown.length === 0 ? (
        <p className="py-6 text-center text-xs text-dim">캐릭터가 없습니다</p>
      ) : (
        <ul role="radiogroup" aria-label="고정 캐릭터" className="flex flex-col gap-1">
          {lib.shown.map((c) => {
            const on = props.slot.charId === c.id
            return (
              <li key={c.id}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={c.name}
                  onClick={() => patchSlot(props.slot.id, { charId: c.id })}
                  className={cx(
                    'flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left',
                    on ? 'border-accent bg-accent/10' : 'border-line'
                  )}
                >
                  <span
                    className={cx(
                      'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                      on ? 'border-accent bg-accent text-accent-fg' : 'border-dim'
                    )}
                  >
                    {on && <Check size={13} strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{c.name}</span>
                    <span className="block truncate font-mono text-[11px] text-dim">{c.base || '(빈 고정 프롬프트)'}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** 출연 슬롯 편집 — 고친 내용은 바로 반영된다 */
export function SlotEditor(props: { slotId: number; onClose: () => void }): ReactNode {
  const s = useCharacters()
  const slot = s.slots.find((x) => x.id === props.slotId)
  const [picking, setPicking] = useState(false)
  if (!slot) return null
  const index = s.slots.indexOf(slot)
  const patch = (p: Partial<Omit<CastSlot, 'id'>>): void => s.patchSlot(slot.id, p)
  const weighted = slot.mode === 'random' || slot.mode === 'chance'
  const totalWeight = slot.candidates.reduce((a, c) => a + Math.max(0, c.weight), 0)
  // 확률 슬롯만 후보가 없을 때 고정 캐릭터로 뽑는다 (weightedCandidates) — 숨기지 않고 보여 준다
  const fallback =
    slot.mode === 'chance' && !slot.candidates.length ? weightedCandidates(slot, s.characters)[0]?.char : undefined
  const moveCandidate = (i: number, dir: -1 | 1): void => {
    const j = i + dir
    if (j < 0 || j >= slot.candidates.length) return
    const next = [...slot.candidates]
    ;[next[i], next[j]] = [next[j], next[i]]
    patch({ candidates: next })
  }
  const setMode = (mode: CastSlot['mode']): void => {
    // 모드를 바꿔도 고른 캐릭터를 잃지 않게 — 고정 캐릭터 ↔ 첫 후보를 서로 채워 준다
    if (mode !== 'fixed' && !slot.candidates.length && slot.charId !== null) {
      return patch({ mode, candidates: [{ kind: 'char', id: slot.charId, weight: 1 }] })
    }
    if (mode === 'fixed' && slot.charId === null) {
      const first = slot.candidates.find((c) => c.kind === 'char')
      return patch({ mode, charId: first?.id ?? null })
    }
    patch({ mode })
  }

  return (
    <>
      <Sheet
        title={`슬롯 ${index + 1}`}
        onClose={props.onClose}
        footer={
          <>
            <Button
              variant="danger"
              onClick={() => {
                s.removeSlot(slot.id)
                props.onClose()
              }}
            >
              <Trash2 size={16} />
              삭제
            </Button>
            <Button onClick={() => s.duplicateSlot(slot.id)}>
              <Copy size={16} />
              복제
            </Button>
            <Button variant="primary" className="flex-1" onClick={props.onClose}>
              완료
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border border-line bg-field px-3">
            <Row label="이 슬롯 사용" hint={slot.enabled ? undefined : '비활성 — 생성할 때 이 슬롯은 건너뜁니다'}>
              <Toggle label="이 슬롯 사용" checked={slot.enabled} onChange={(enabled) => patch({ enabled })} />
            </Row>
          </div>
          <div>
            <h3 className="mb-1 text-xs text-dim">누가 나올지</h3>
            <Segmented label="슬롯 모드" value={slot.mode} options={SLOT_MODES} onChange={setMode} />
            <p className="mt-1.5 text-xs text-dim">
              {slot.mode === 'fixed' && '정한 캐릭터가 매번 나옵니다.'}
              {slot.mode === 'random' && '후보 중 한 명을 비중에 따라 뽑습니다. 폴더는 그 안의 캐릭터가 비중을 나눠 갖습니다.'}
              {slot.mode === 'sequential' && '후보를 위에서부터 차례로 한 명씩 씁니다. 폴더는 라이브러리 순서로 펼칩니다.'}
              {slot.mode === 'chance' && '정한 확률로만 나옵니다. 나올 때는 후보 중 비중에 따라 한 명을 뽑습니다.'}
            </p>
          </div>

          {slot.mode === 'fixed' ? (
            <FixedPicker slot={slot} />
          ) : (
            <>
              {slot.mode === 'chance' && (
                <div className="rounded-lg border border-line bg-field px-3">
                  <SliderRow
                    label="나올 확률"
                    value={slot.chance}
                    min={0}
                    max={100}
                    step={5}
                    format={(v) => `${v}%`}
                    onChange={(chance) => patch({ chance })}
                  />
                </div>
              )}
              {slot.mode === 'sequential' && (
                <div className="rounded-lg border border-line bg-field px-3">
                  <Row
                    label="끝까지 가면 처음부터"
                    hint={slot.wrap ? '후보를 다 쓰면 다시 첫 후보부터' : '후보를 한 바퀴 다 쓰면 그 뒤로는 이 슬롯을 비웁니다'}
                  >
                    <Toggle label="끝까지 가면 처음부터" checked={slot.wrap} onChange={(wrap) => patch({ wrap })} />
                  </Row>
                </div>
              )}
              <div>
                <h3 className="mb-1 flex items-center text-xs text-dim">
                  후보 {slot.candidates.length}
                  {weighted && <span className="ml-auto">비중 (뽑힐 몫)</span>}
                </h3>
                {slot.candidates.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-dim">
                    {fallback
                      ? `후보가 없어 고정 캐릭터 ${fallback.name}이(가) 확률대로 나옵니다`
                      : '후보가 없으면 이 슬롯은 비어 있습니다'}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {slot.candidates.map((cand, i) => {
                      const name = candidateName(cand, s.characters, s.folders)
                      const share = totalWeight > 0 ? Math.round((Math.max(0, cand.weight) / totalWeight) * 100) : 0
                      return (
                        <li
                          key={`${cand.kind}-${cand.id ?? 'none'}`}
                          className="flex items-center gap-1 rounded-lg border border-line bg-field py-1 pl-2.5 pr-1"
                        >
                          {cand.kind === 'folder' ? (
                            <Folder size={15} className="shrink-0 text-accent" aria-label="폴더" />
                          ) : (
                            <User size={15} className="shrink-0 text-dim" aria-label="캐릭터" />
                          )}
                          <span className="ml-1 min-w-0 flex-1">
                            <span className="block truncate text-sm">{name}</span>
                            {weighted && <span className="block text-[11px] text-dim">{share}%</span>}
                          </span>
                          {weighted ? (
                            <Stepper
                              label={`${name} 비중`}
                              value={cand.weight}
                              min={0}
                              max={99}
                              onChange={(weight) =>
                                patch({ candidates: slot.candidates.map((c, j) => (j === i ? { ...c, weight } : c)) })
                              }
                            />
                          ) : (
                            <>
                              <IconButton label="위로" disabled={i === 0} onClick={() => moveCandidate(i, -1)}>
                                <ArrowUp size={16} />
                              </IconButton>
                              <IconButton
                                label="아래로"
                                disabled={i === slot.candidates.length - 1}
                                onClick={() => moveCandidate(i, 1)}
                              >
                                <ArrowDown size={16} />
                              </IconButton>
                            </>
                          )}
                          <IconButton
                            label={`${name} 후보에서 빼기`}
                            onClick={() => patch({ candidates: slot.candidates.filter((_, j) => j !== i) })}
                          >
                            <X size={16} />
                          </IconButton>
                        </li>
                      )
                    })}
                  </ul>
                )}
                <Button className="mt-2 w-full" onClick={() => setPicking(true)}>
                  <Plus size={16} />
                  후보 추가 (캐릭터·폴더)
                </Button>
              </div>
            </>
          )}
        </div>
      </Sheet>
      {picking && <CandidatePicker slot={slot} onClose={() => setPicking(false)} />}
    </>
  )
}
